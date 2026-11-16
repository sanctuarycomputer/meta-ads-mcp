// 266: ads_update_campaign sets a campaign spend cap given in the account
// currency's standard unit (converted to Meta's minor unit from the
// currency read from Meta, failing closed), or removes it only through an
// explicit remove_spend_cap flag. The removal value never comes from an
// amount, on update or on create.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  campaignSpendCapMinor,
  registerCampaignTools,
  SPEND_CAP_REMOVAL_MINOR,
  spendCapDigits,
} from "../../src/tools/campaigns.js";
import { metaApiClient } from "../../src/meta/client.js";
import { resetAccountCurrencyCacheForTests } from "../../src/meta/account-currency.js";
import { cleanupTestToken, createMockMcpServer, fetchCallSummary, mockFetchResponse, setupTestToken } from "../setup.js";

type TextResult = { content: Array<{ type: string; text: string }> };

function tool(name: string) {
  const server = createMockMcpServer();
  registerCampaignTools(server as never);
  const found = server._registeredTools.find((t) => t.name === name);
  if (!found) throw new Error(`tool ${name} not registered`);
  return found;
}

const update = (args: Record<string, unknown>) => tool("ads_update_campaign").handler(args);

/**
 * A recording fetch for the campaign update: GET /<campaign> answers
 * `campaign`, GET /act_<id> answers `account`, any POST succeeds. An Error
 * as an answer is a failed request (HTTP 400).
 */
function stubMeta(campaign: unknown = { id: "1001", account_id: "123" }, account: unknown = { id: "act_123", currency: "USD" }) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname.replace(/^\/v[\d.]+/, "");
    if (init?.method === "POST") return mockFetchResponse({ success: true, id: "1000999" });
    // Any /act_ path is the account, so a malformed account id is decided by
    // the tool's own check, not by the stub.
    const answer = path.startsWith("/act_") ? account : campaign;
    if (answer instanceof Error) return mockFetchResponse({ error: { code: 100, type: "OAuthException", message: answer.message } }, { status: 400 });
    return mockFetchResponse(answer);
  }));
}

function posts(): string[] {
  return fetchCallSummary().filter((c) => c.startsWith("POST"));
}

function postBody(): URLSearchParams {
  const call = vi.mocked(fetch).mock.calls.find(([, init]) => init?.method === "POST");
  if (!call) throw new Error("no POST was sent");
  return new URLSearchParams(String(call[1]?.body ?? ""));
}

const text = (result: unknown) => (result as TextResult).content.map((c) => c.text).join("\n");

describe("266: campaign spend cap", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    resetAccountCurrencyCacheForTests();
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  describe("campaignSpendCapMinor(amount, currency)", () => {
    it.each([
      [1000, "USD", "100000"],
      [100.5, "USD", "10050"],
      [19.99, "USD", "1999"],
      [0.29, "USD", "29"],
      [8.7, "USD", "870"],
      [500000, "COP", "500000"],
      [1, "JPY", "1"],
      [9223372036854.77, "USD", "922337203685477"],
    ])("%s %s is %s minor", (amount, currency, minor) => {
      expect(campaignSpendCapMinor(amount, currency)).toBe(minor);
    });

    it.each([0, -5, Number.NaN, Number.POSITIVE_INFINITY, 1e-7, 1e21, "1000", undefined, null])(
      "refuses %s as not plain digits",
      (amount) => {
        expect(() => campaignSpendCapMinor(amount, "USD")).toThrow(/plain digits/);
        expect(() => spendCapDigits(amount)).toThrow(/plain digits/);
      },
    );

    it.each([[100.555, "USD"], [1000.5, "COP"]])("refuses %s %s for its decimal places", (amount, currency) => {
      expect(() => campaignSpendCapMinor(amount, currency)).toThrow(/decimal places/);
    });

    it.each([9223372036854.78, 92233720368547.8, 9007199254740993])(
      "refuses %s USD as at or above the removal value",
      (amount) => {
        expect(() => campaignSpendCapMinor(amount, "USD")).toThrow(/remove_spend_cap/);
      },
    );

    it("refuses a currency Meta's table lacks", () => {
      expect(() => campaignSpendCapMinor(1000, "XYZ")).toThrow(/currency table/);
    });

    it("has one removal value, Meta's", () => {
      expect(SPEND_CAP_REMOVAL_MINOR).toBe("922337203685478");
    });
  });

  describe("ads_update_campaign", () => {
    it("sets spend_cap in minor units of the account currency", async () => {
      stubMeta();
      const result = await update({ campaign_id: "1001", spend_cap: 1000 });
      expect(fetchCallSummary()).toEqual(["GET /1001", "GET /act_123", "POST /1001"]);
      expect(postBody().get("spend_cap")).toBe("100000");
      expect(text(result)).toContain("Spend cap: USD 1,000.00");
      expect(text(result)).toContain("spend_cap=100000");
    });

    it("accepts a lower-case currency and names it upper-case", async () => {
      stubMeta(undefined, { id: "act_123", currency: "usd" });
      const result = await update({ campaign_id: "1001", spend_cap: 1000 });
      expect(postBody().get("spend_cap")).toBe("100000");
      expect(text(result)).toContain("Spend cap: USD 1,000.00");
      stubMeta(undefined, { id: "act_123", currency: "cop" });
      await expect(update({ campaign_id: "1001", spend_cap: 1000.5 })).rejects.toThrow(/than COP allows/);
    });

    it("converts a whole-unit currency", async () => {
      stubMeta(undefined, { id: "act_123", currency: "COP" });
      await update({ campaign_id: "1001", spend_cap: 500000 });
      expect(postBody().get("spend_cap")).toBe("500000");
    });

    it("remove_spend_cap sends the removal value without reading the currency", async () => {
      stubMeta();
      const result = await update({ campaign_id: "1001", remove_spend_cap: true });
      expect(fetchCallSummary()).toEqual(["POST /1001"]);
      expect(postBody().get("spend_cap")).toBe("922337203685478");
      expect(text(result)).toContain("Spend cap: removed");
    });

    it("refuses spend_cap with remove_spend_cap", async () => {
      stubMeta();
      await expect(update({ campaign_id: "1001", spend_cap: 1000, remove_spend_cap: true })).rejects.toThrow(/not both/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("treats remove_spend_cap false as absent", async () => {
      stubMeta();
      await update({ campaign_id: "1001", spend_cap: 1000, remove_spend_cap: false });
      expect(postBody().get("spend_cap")).toBe("100000");
    });

    it("only remove_spend_cap === true removes", async () => {
      stubMeta();
      await update({ campaign_id: "1001", remove_spend_cap: "yes", name: "sb-x" });
      expect(posts()).toEqual(["POST /1001"]);
      expect(postBody().has("spend_cap")).toBe(false);
      expect(postBody().get("name")).toBe("sb-x");
    });

    it.each(["act_123", "1_2"])("refuses %s as the campaign id of a cap change", async (campaign_id) => {
      stubMeta();
      await expect(update({ campaign_id, spend_cap: 1000 })).rejects.toThrow(/campaign ID/);
      await expect(update({ campaign_id, remove_spend_cap: true })).rejects.toThrow(/campaign ID/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it("still updates other fields on an id it does not check (object type is 253's)", async () => {
      stubMeta();
      await update({ campaign_id: "act_123", name: "sb-x", remove_spend_cap: false });
      expect(posts()).toEqual(["POST /act_123"]);
    });

    it.each([1e-7, 0, "1000", null])("refuses spend_cap %s before any request", async (spend_cap) => {
      stubMeta();
      await expect(update({ campaign_id: "1001", spend_cap })).rejects.toThrow(/plain digits/);
      expect(fetch).not.toHaveBeenCalled();
    });

    it.each([
      ["a failed read", new Error("Unsupported get request")],
      ["no account_id", {}],
      ["an account_id that is not digits", { account_id: "act_1" }],
      ["an account_id with trailing junk", { account_id: "123x" }],
      ["an account_id that is a number, not a string", { account_id: 123 }],
    ])("refuses when the campaign read gives %s", async (_label, campaign) => {
      stubMeta(campaign);
      await expect(update({ campaign_id: "1001", spend_cap: 1000 })).rejects.toThrow(
        campaign instanceof Error ? /Unsupported get request/ : /did not report campaign 1001's ad account/,
      );
      expect(posts()).toEqual([]);
    });

    it.each([
      ["a failed read", new Error("Unsupported get request")],
      ["no currency", {}],
      ["a malformed currency", { currency: "usd " }],
      ["a currency Meta's table lacks", { currency: "XYZ" }],
    ])("refuses when the account read gives %s", async (_label, account) => {
      stubMeta(undefined, account);
      await expect(update({ campaign_id: "1001", spend_cap: 1000 })).rejects.toThrow(
        account instanceof Error ? /Unsupported get request/ : /did not report a known currency for ad account act_123/,
      );
      expect(posts()).toEqual([]);
    });

    it("refuses a cap that converts to the removal value", async () => {
      stubMeta();
      await expect(update({ campaign_id: "1001", spend_cap: 9223372036854.78 })).rejects.toThrow(/remove_spend_cap/);
      expect(posts()).toEqual([]);
    });

    it("refuses a cap with more decimals than the currency allows, after the reads and before the POST", async () => {
      stubMeta(undefined, { id: "act_123", currency: "COP" });
      await expect(update({ campaign_id: "1001", spend_cap: 1000.5 })).rejects.toThrow(/decimal places/);
      expect(posts()).toEqual([]);
    });

    it("sends the cap with the other fields in one POST", async () => {
      stubMeta();
      await update({ campaign_id: "1001", spend_cap: 200, name: "sb-x" });
      expect(posts()).toEqual(["POST /1001"]);
      expect(postBody().get("spend_cap")).toBe("20000");
      expect(postBody().get("name")).toBe("sb-x");
    });

    it("has spend_cap and remove_spend_cap inputs", () => {
      const schema = z.object(tool("ads_update_campaign").schema as z.ZodRawShape);
      expect(schema.safeParse({ campaign_id: "1001", spend_cap: 1000 }).success).toBe(true);
      expect(schema.safeParse({ campaign_id: "1001", remove_spend_cap: true }).success).toBe(true);
      expect(schema.safeParse({ campaign_id: "1001", spend_cap: 0 }).success).toBe(false);
    });
  });

  describe("ads_create_campaign", () => {
    const create = (spend_cap: number) => tool("ads_create_campaign").handler({
      account_id: "act_123", name: "sb-c", objective: "OUTCOME_SALES",
      special_ad_categories: ["NONE"], buying_type: "AUCTION", spend_cap,
    });

    it("refuses the removal value as a spend_cap", async () => {
      stubMeta();
      await expect(create(922337203685478)).rejects.toThrow(/remove_spend_cap/);
      expect(posts()).toEqual([]);
    });

    it("its schema refuses the removal value too", () => {
      const schema = z.object(tool("ads_create_campaign").schema as z.ZodRawShape);
      const args = { account_id: "act_123", name: "sb-c", objective: "OUTCOME_SALES" };
      expect(schema.safeParse({ ...args, spend_cap: 922337203685477 }).success).toBe(true);
      expect(schema.safeParse({ ...args, spend_cap: 922337203685478 }).success).toBe(false);
    });

    it("still sends a spend_cap just under the removal value", async () => {
      stubMeta();
      await create(922337203685477);
      expect(postBody().get("spend_cap")).toBe("922337203685477");
    });
  });
});
