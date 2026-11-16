// 266: the copy paths (ads_duplicate_ad, ads_clone_ad_set_bundle) always
// create PAUSED objects, whatever the caller passes, and their idempotency
// signatures stay the same for a caller who used the default.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerSocialProofTools } from "../../src/tools/social-proof.js";
import { registerAdSetTools } from "../../src/tools/adsets.js";
import { metaApiClient } from "../../src/meta/client.js";
import { getCloneBundleStore, resetCloneBundleStoreForTests } from "../../src/store/clone-bundle-store.js";
import { resetAccountCurrencyCacheForTests } from "../../src/meta/account-currency.js";
import { cleanupTestToken, createMockMcpServer, fakeFirestore, mockFetchResponse, setupTestToken } from "../setup.js";

type TextResult = { content: Array<{ type: string; text: string }> };

/** Answers each request by "METHOD /path" or "/path"; anything else is an empty object. */
function routeFetch(routes: Record<string, unknown>): void {
  vi.stubGlobal("fetch", vi.fn(async (input: string, init?: RequestInit) => {
    const path = new URL(input).pathname.replace(/^\/v[\d.]+/, "");
    const body = routes[`${init?.method ?? "GET"} ${path}`] ?? routes[path] ?? {};
    return mockFetchResponse(body);
  }));
}

function postsTo(pattern: RegExp): URLSearchParams[] {
  return vi.mocked(fetch).mock.calls
    .filter(([url, init]) => init?.method === "POST" && pattern.test(new URL(String(url)).pathname))
    .map(([, init]) => new URLSearchParams(String(init?.body ?? "")));
}

function postCount(): number {
  return vi.mocked(fetch).mock.calls.filter(([, init]) => init?.method === "POST").length;
}

function toolOf(register: (server: never) => void, name: string) {
  const server = createMockMcpServer();
  register(server as never);
  const tool = server._registeredTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

const allText = (result: unknown) => (result as TextResult).content.map((c) => c.text).join("\n");

// ─── ads_duplicate_ad ──────────────────────────────────────────

const DUPLICATE_SOURCE: Record<string, unknown> = {
  "/3001": { id: "3001", name: "Source ad", account_id: "123", adset_id: "7000", status: "ACTIVE", creative: { id: "4001" } },
  "/4001": { id: "4001", effective_object_story_id: "6001_777", effective_instagram_media_id: "17900000000000001" },
  "/7001": { id: "7001", account_id: "123", name: "Set one" },
};

const duplicate = () => toolOf(registerSocialProofTools as never, "ads_duplicate_ad");

// ─── ads_clone_ad_set_bundle ───────────────────────────────────

const SOURCE_AD_SET = {
  id: "2099", name: "Source", campaign_id: "1001", status: "ACTIVE", effective_status: "ACTIVE",
  daily_budget: "500", optimization_goal: "OFFSITE_CONVERSIONS", billing_event: "IMPRESSIONS",
  targeting: { geo_locations: { countries: ["CL"] } }, destination_type: "WEBSITE",
};
const sourceAd = (id: string) => ({
  id, name: `Source__${id}`, adset_id: "2099", campaign_id: "1001", status: "ACTIVE", effective_status: "ACTIVE",
  creative: { id: `4${id}` }, created_time: "2026-01-01T00:00:00-0000", updated_time: "2026-01-01T00:00:00-0000",
});
const CLONE_ROUTES: Record<string, unknown> = {
  "GET /2099": SOURCE_AD_SET,
  "GET /2099/ads": { data: [sourceAd("3001"), sourceAd("3002")] },
  "POST /act_123/adsets": { id: "20001" },
  "POST /3001/copies": { copied_ad_id: "30001" },
  "POST /3002/copies": { copied_ad_id: "30002" },
  "POST /30001": { success: true },
  "POST /30002": { success: true },
};

const clone = () => toolOf(registerAdSetTools as never, "ads_clone_ad_set_bundle");

interface ClonePayload {
  new_ad_set: { status: string };
  created_ads: Array<{ status: string }>;
}

describe("266: copy paths always create PAUSED", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    resetAccountCurrencyCacheForTests();
    resetCloneBundleStoreForTests(fakeFirestore());
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("ads_duplicate_ad keep_social_proof sends PAUSED when asked for ACTIVE", async () => {
    routeFetch({ ...DUPLICATE_SOURCE, "POST /act_123/ads": { id: "5001" } });
    const result = await duplicate().handler({ ad_id: "3001", ad_set_ids: ["7001"], status: "ACTIVE", idempotency_key: "k1" });
    const [body] = postsTo(/\/act_123\/ads$/);
    expect(body.get("status")).toBe("PAUSED");
    expect(allText(result)).toContain("(PAUSED)");
    expect(allText(result)).not.toContain("ACTIVE");
  });

  it("ads_duplicate_ad copies send status_option PAUSED when asked for ACTIVE", async () => {
    routeFetch({ ...DUPLICATE_SOURCE, "POST /3001/copies": { copied_ad_id: "5101" }, "POST /5101": { success: true } });
    await duplicate().handler({ ad_id: "3001", ad_set_ids: ["7001"], keep_social_proof: false, status: "ACTIVE", idempotency_key: "k1" });
    const [copy] = postsTo(/\/3001\/copies$/);
    expect(copy.get("status_option")).toBe("PAUSED");
  });

  it("ads_duplicate_ad dry run reports PAUSED", async () => {
    routeFetch(DUPLICATE_SOURCE);
    const result = await duplicate().handler({ ad_id: "3001", ad_set_ids: ["7001"], status: "ACTIVE", dry_run: true });
    expect(postCount()).toBe(0);
    expect(allText(result)).toContain("(PAUSED)");
  });

  it("ads_duplicate_ad signature keeps status PAUSED", async () => {
    routeFetch({ ...DUPLICATE_SOURCE, "POST /act_123/ads": { id: "5001" } });
    const claim = vi.spyOn(getCloneBundleStore(), "claim");
    await duplicate().handler({ ad_id: "3001", ad_set_ids: ["7001"], status: "ACTIVE", idempotency_key: "k1" });
    expect(claim).toHaveBeenCalled();
    expect(String(claim.mock.calls[0][1])).toContain('"status":"PAUSED"');
  });

  it("ads_clone_ad_set_bundle creates the ad set and every copy PAUSED", async () => {
    routeFetch(CLONE_ROUTES);
    const result = await clone().handler({
      account_id: "act_123", source_ad_set_id: "2099",
      target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "ACTIVE" },
      creative_overrides: [], dry_run: false, idempotency_key: "k-clone",
    });
    const [adSet] = postsTo(/\/act_123\/adsets$/);
    expect(adSet.get("status")).toBe("PAUSED");
    const copies = postsTo(/\/\d+\/copies$/);
    expect(copies).toHaveLength(2);
    for (const copy of copies) expect(copy.get("status_option")).toBe("PAUSED");
    const payload = JSON.parse((result as TextResult).content[1].text) as ClonePayload;
    expect(payload.new_ad_set.status).toBe("PAUSED");
    expect(payload.created_ads.map((ad) => ad.status)).toEqual(["PAUSED", "PAUSED"]);
  });

  it("ads_clone_ad_set_bundle dry run plans PAUSED", async () => {
    routeFetch(CLONE_ROUTES);
    const result = await clone().handler({
      account_id: "act_123", source_ad_set_id: "2099",
      target_ad_set: { name: "Target", geo_override: { countries: ["CO"] }, status: "ACTIVE" },
      creative_overrides: [], dry_run: true,
    });
    expect(postCount()).toBe(0);
    const payload = JSON.parse((result as TextResult).content[1].text) as ClonePayload;
    expect(payload.new_ad_set.status).toBe("PAUSED");
    expect(payload.created_ads.map((ad) => ad.status)).toEqual(["PAUSED", "PAUSED"]);
  });

  it("ads_clone_ad_set_bundle signature is unchanged for a default payload", async () => {
    routeFetch(CLONE_ROUTES);
    const claim = vi.spyOn(getCloneBundleStore(), "claim");
    // Through the schema, as the MCP server calls it: defaults applied.
    const tool = clone();
    const args = z.object(tool.schema as z.ZodRawShape).parse({
      account_id: "act_123", source_ad_set_id: "2099",
      target_ad_set: { name: "T", geo_override: { countries: ["CL"] }, daily_budget: 900 },
      idempotency_key: "k",
    });
    await tool.handler(args);
    expect(claim).toHaveBeenCalled();
    // What the old schema's parse gave for a caller who left status out:
    // status third, after name and geo_override (adsets.ts:128-137 at f4dbacb).
    expect(claim.mock.calls[0][1]).toBe(JSON.stringify({
      account_id: "act_123",
      source_ad_set_id: "2099",
      target_ad_set: { name: "T", geo_override: { countries: ["CL"] }, status: "PAUSED", daily_budget: 900 },
      creative_overrides: [],
    }));
  });

  it("ads_clone_ad_set_bundle's signature says PAUSED even when a direct caller passes ACTIVE", async () => {
    routeFetch(CLONE_ROUTES);
    const claim = vi.spyOn(getCloneBundleStore(), "claim");
    await clone().handler({
      account_id: "act_123", source_ad_set_id: "2099",
      target_ad_set: { name: "T", geo_override: { countries: ["CL"] }, status: "ACTIVE" },
      creative_overrides: [], dry_run: false, idempotency_key: "k2",
    });
    expect(String(claim.mock.calls[0][1])).toContain('"status":"PAUSED"');
    expect(String(claim.mock.calls[0][1])).not.toContain("ACTIVE");
  });

  describe("copy schemas have no status input", () => {
    it("ads_duplicate_ad has no status input", () => {
      expect("status" in (duplicate().schema as Record<string, unknown>)).toBe(false);
    });

    it("ads_clone_ad_set_bundle's target_ad_set strips status", () => {
      const shape = clone().schema as { target_ad_set: z.ZodTypeAny };
      const parsed = shape.target_ad_set.safeParse({ name: "T", geo_override: { countries: ["CL"] }, status: "ACTIVE" });
      expect(parsed.success).toBe(true);
      expect(parsed.data).not.toHaveProperty("status");
    });
  });
});
