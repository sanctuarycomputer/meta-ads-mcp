// 266: every single-request create sends status PAUSED, whatever the
// caller passes. The spend guard lets a create through as non-spending only
// when it is PAUSED; turning an object on is a separate, guarded update.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerCampaignTools } from "../../src/tools/campaigns.js";
import { registerAdSetTools } from "../../src/tools/adsets.js";
import { registerAdTools } from "../../src/tools/ads.js";
import { registerBulkAdTools } from "../../src/tools/bulk-ads.js";
import { registerInstagramTools, setBoostRecoveryWaitsForTests } from "../../src/tools/instagram.js";
import { metaApiClient } from "../../src/meta/client.js";
import { resetAccountCurrencyCacheForTests } from "../../src/meta/account-currency.js";
import { cleanupTestToken, createMockMcpServer, mockFetchResponse, setupTestToken } from "../setup.js";

// Bulk ads checks each video URL resolves to a public address; stub only DNS.
vi.mock("../../src/utils/url-guard.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/utils/url-guard.js")>();
  return {
    ...actual,
    assertSafePublicUrl: (raw: string) => actual.assertSafePublicUrl(raw, { resolve: async () => [{ address: "93.184.216.34" }] }),
  };
});

type TextResult = { content: Array<{ type: string; text: string }> };
type Register = (server: never) => void;

function toolOf(register: Register, name: string) {
  const server = createMockMcpServer();
  register(server as never);
  const tool = server._registeredTools.find((t) => t.name === name);
  if (!tool) throw new Error(`tool ${name} not registered`);
  return tool;
}

/** A recording fetch: every POST gets an id, GETs answer from `gets` by path suffix. */
function recordingFetch(gets: Array<[RegExp, unknown]> = []) {
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (init?.method === "POST") return mockFetchResponse({ id: "9001" });
    const hit = gets.find(([pattern]) => pattern.test(path));
    return hit ? mockFetchResponse(hit[1]) : mockFetchResponse({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 });
  }));
}

/** The bodies of the POSTs sent to paths matching `pattern`. */
function postsTo(pattern: RegExp): URLSearchParams[] {
  return vi.mocked(fetch).mock.calls
    .filter(([url, init]) => init?.method === "POST" && pattern.test(new URL(String(url)).pathname))
    .map(([, init]) => new URLSearchParams(String(init?.body ?? "")));
}

function text(result: unknown): string {
  return (result as TextResult).content.map((c) => c.text).join("\n");
}

const CAMPAIGN_ARGS = {
  account_id: "act_123", name: "sb-campaign", objective: "OUTCOME_SALES",
  special_ad_categories: ["NONE"], buying_type: "AUCTION",
};
const AD_SET_ARGS = {
  account_id: "act_123", campaign_id: "1001", name: "sb-ad-set", destination_type: "WEBSITE",
  optimization_goal: "LINK_CLICKS", billing_event: "IMPRESSIONS", targeting: { geo_locations: { countries: ["US"] } },
};
const AD_ARGS = { account_id: "act_123", name: "sb-ad", ad_set_id: "2001", creative_id: "4001" };
const BULK_ARGS = {
  account_id: "act_123", ad_set_id: "2001", page_id: "789", max_wait_seconds: 0,
  videos: [{ file_url: "https://cdn.example/a.mp4" }, { file_url: "https://cdn.example/b.mp4" }],
};

const VIDEO_READY: [RegExp, unknown] = [/\/9001$/, {
  status: { video_status: "ready" },
  thumbnails: { data: [{ uri: "https://cdn.example/t.jpg", is_preferred: true }] },
}];

describe("266: single-request creates always send PAUSED", () => {
  beforeEach(() => {
    setupTestToken();
    metaApiClient.resetForTests();
    resetAccountCurrencyCacheForTests();
    setBoostRecoveryWaitsForTests([0, 0]);
  });

  afterEach(() => {
    cleanupTestToken();
    vi.restoreAllMocks();
  });

  it("ads_create_campaign sends PAUSED when asked for ACTIVE", async () => {
    recordingFetch();
    const result = await toolOf(registerCampaignTools, "ads_create_campaign").handler({ ...CAMPAIGN_ARGS, status: "ACTIVE" });
    const [body] = postsTo(/\/act_123\/campaigns$/);
    expect(body.get("status")).toBe("PAUSED");
    expect(text(result)).toContain("Status: PAUSED");
  });

  it("ads_create_ad_set sends PAUSED when asked for ACTIVE", async () => {
    recordingFetch();
    const result = await toolOf(registerAdSetTools, "ads_create_ad_set").handler({ ...AD_SET_ARGS, status: "ACTIVE" });
    const [body] = postsTo(/\/act_123\/adsets$/);
    expect(body.get("status")).toBe("PAUSED");
    expect(text(result)).toContain("Status: PAUSED");
  });

  it("ads_create_ad sends PAUSED when asked for ACTIVE", async () => {
    recordingFetch();
    const result = await toolOf(registerAdTools, "ads_create_ad").handler({ ...AD_ARGS, status: "ACTIVE" });
    const [body] = postsTo(/\/act_123\/ads$/);
    expect(body.get("status")).toBe("PAUSED");
    expect(text(result)).toContain("Status: PAUSED");
  });

  it("ads_bulk_create_video_ads sends PAUSED on every ad when asked for ACTIVE", async () => {
    recordingFetch([VIDEO_READY]);
    const result = await toolOf(registerBulkAdTools, "ads_bulk_create_video_ads").handler({ ...BULK_ARGS, status: "ACTIVE" });
    const bodies = postsTo(/\/act_123\/ads$/);
    expect(bodies).toHaveLength(2);
    for (const body of bodies) expect(body.get("status")).toBe("PAUSED");
    expect(text(result)).toContain("with status PAUSED");
  });

  it("ads_boost_ig_post sends PAUSED whatever it is given", async () => {
    recordingFetch([
      [/\/2001\/ads$/, { data: [] }],
      [/\/2001$/, { id: "2001", account_id: "123" }],
      [/\/9001$/, { id: "9001", creative: { id: "4001" } }],
      [/\/1784$/, { id: "1784", media_type: "IMAGE", media_product_type: "FEED", boost_eligibility_info: { eligible_to_boost: true } }],
    ]);
    const result = await toolOf(registerInstagramTools, "ads_boost_ig_post").handler({
      account_id: "123", ad_set_id: "2001", instagram_media_id: "1784", instagram_account_id: "1780", status: "ACTIVE",
    });
    const [body] = postsTo(/\/act_123\/ads$/);
    expect(body.get("status")).toBe("PAUSED");
    expect(text(result)).toContain("PAUSED");
    expect(text(result)).toContain("ads_update_ad status ACTIVE");
    expect(text(result)).not.toContain("ads_activate_entity");
  });

  it("ads_boost_ig_post's lost-answer reply points at the guarded update", async () => {
    let posted = false;
    vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
      const { pathname: path, searchParams } = new URL(url);
      if (init?.method === "POST") { posted = true; throw new TypeError("fetch failed"); }
      if (/\/2001\/ads$/.test(path)) {
        const tag = JSON.parse(searchParams.get("filtering")!)[0].value as string;
        return mockFetchResponse({ data: posted ? [{ id: "5009", name: `Earlier ${tag}`, creative: { id: "4009" } }] : [] });
      }
      if (/\/2001$/.test(path)) return mockFetchResponse({ id: "2001", account_id: "123" });
      if (/\/1784$/.test(path)) return mockFetchResponse({ id: "1784", media_type: "IMAGE", media_product_type: "FEED", boost_eligibility_info: { eligible_to_boost: true } });
      return mockFetchResponse({ error: { code: 100, message: "Unsupported get request." } }, { status: 400 });
    }));
    const result = await toolOf(registerInstagramTools, "ads_boost_ig_post").handler({
      account_id: "123", ad_set_id: "2001", instagram_media_id: "1784", instagram_account_id: "1780",
    });
    expect(text(result)).toMatch(/answer was lost, but the ad exists/);
    expect(text(result)).toContain("ads_update_ad status ACTIVE");
    expect(text(result)).not.toContain("ads_activate_entity");
  });

  it("ads_delete_ad's dynamic-creative refusal points at the ad set update, not ads_activate_entity", async () => {
    recordingFetch([[/\/3001$/, { id: "3001", adset: { id: "2001", is_dynamic_creative: true } }]]);
    await expect(toolOf(registerAdTools, "ads_delete_ad").handler({ ad_id: "3001" }))
      .rejects.toThrow(/ads_update_ad_set status PAUSED/);
  });

  describe("create schemas have no status input", () => {
    const cases: Array<[string, Register, Record<string, unknown>]> = [
      ["ads_create_campaign", registerCampaignTools, CAMPAIGN_ARGS],
      ["ads_create_ad_set", registerAdSetTools, AD_SET_ARGS],
      ["ads_create_ad", registerAdTools, AD_ARGS],
      ["ads_bulk_create_video_ads", registerBulkAdTools, BULK_ARGS],
    ];
    for (const [name, register, args] of cases) {
      it(`${name} strips a status argument`, () => {
        const shape = toolOf(register, name).schema as z.ZodRawShape;
        expect("status" in shape).toBe(false);
        const parsed = z.object(shape).safeParse({ ...args, status: "ACTIVE" });
        expect(parsed.success).toBe(true);
        expect(parsed.data).not.toHaveProperty("status");
      });
    }
  });
});
