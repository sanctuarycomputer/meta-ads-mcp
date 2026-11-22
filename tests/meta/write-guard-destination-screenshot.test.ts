// Contract docs/contracts/meta-ads-guard.md@1.2 (ticket 383): Graph v27 adds
// `creative_sourcing_spec.destination_screenshot_spec.enroll_status` to every new creative. It is a §5.1 path, so a
// creative as read (creative_id, source_ad) that holds it is admitted; any other path under it is not, and no key set
// or fork tool sends it.
import { describe, expect, it } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { withLiveTypes } from "./live-type-graph.js";
import { answerGet } from "../fixtures/meta-ads-guard/harness.js";
import {
  CREATIVE_READ_FIELDS,
  ENDPOINTS,
  admittedCreativeSpec,
  buildDescriptor,
  keySetMiss,
  validateDescriptor,
  type Descriptor,
  type GraphGet,
  type WriteRequest,
} from "../../src/meta/write-descriptor.js";

const ENROLL = "destination_screenshot_spec.enroll_status";
const SITE_LINKS = ["site_links_spec.site_link_title", "site_links_spec.site_link_url", "site_links_spec.site_link_image_hash"];

const ACT = "act_9990000000000001";
const ACT_DIGITS = "9990000000000001";
const CAMP = "9994000000000001";
const ADSET = "9995000000000001";
const AD = "9996000000000001";
const CREATIVE = "9997000000000001";
const PAGE = "9991000000000001";
const IG = "9992000000000002";
const POST_ID = `${PAGE}_7`;

/**
 * The key shape of creative 1118767330918206 as the deployed CREATIVE_READ_FIELDS read it (ticket 383 notes,
 * 2026-11-22): exactly these eleven keys, made-up values. `creative_sourcing_spec` holds only the screenshot setting.
 */
function liveCreative(sourcing: unknown = { destination_screenshot_spec: { enroll_status: "OPT_IN" } }): Record<string, unknown> {
  return {
    actor_id: PAGE,
    id: CREATIVE,
    instagram_user_id: IG,
    name: "n",
    object_story_spec: {
      page_id: PAGE,
      instagram_user_id: IG,
      link_data: { link: "https://example.com", message: "m", image_hash: "h", call_to_action: { type: "LEARN_MORE", value: { link: "https://example.com" } } },
    },
    degrees_of_freedom_spec: { creative_features_spec: { standard_enhancements: { enroll_status: "OPT_OUT" } } },
    contextual_multi_ads: { enroll_status: "OPT_OUT" },
    creative_sourcing_spec: sourcing,
    portrait_customizations: { specifications: [{ background_color: { default_color: "#000000" } }] },
    url_tags: "utm_source=meta",
    effective_object_story_id: POST_ID,
  };
}

function world(creative: Record<string, unknown>): Map<string, unknown> {
  return new Map<string, unknown>(
    Object.entries({
      [`/${ACT}`]: { spend_cap: "500000", amount_spent: "1200", currency: "USD" },
      [`/${CAMP}`]: { metadata: { type: "campaign" }, account_id: ACT_DIGITS, status: "PAUSED", effective_status: "PAUSED", name: "sb-usb-h1", spend_cap: "100000", buying_type: "AUCTION" },
      [`/${ADSET}`]: { metadata: { type: "adset" }, account_id: ACT_DIGITS, status: "PAUSED", campaign_id: CAMP, daily_budget: "1000" },
      [`/${AD}`]: { metadata: { type: "ad" }, account_id: ACT_DIGITS, status: "PAUSED", adset_id: ADSET, campaign_id: CAMP, creative: { id: CREATIVE } },
      [`/${ADSET}/ads`]: { data: [{ creative: { id: CREATIVE } }] },
      [`/${CREATIVE}`]: creative,
      [`/${POST_ID}`]: { from: { id: PAGE } },
      [`/${PAGE}`]: { id: PAGE },
      [`/${IG}`]: { id: IG },
    }),
  );
}

async function build(req: WriteRequest, gets: Map<string, unknown>): Promise<Descriptor> {
  const get: GraphGet = withLiveTypes(async <T>(path: string, params: Record<string, string | number>): Promise<T> => answerGet(gets, path, params) as T);
  const d = await buildDescriptor(req, { tool: "ads_test_tool", validateOnly: false, requestId: "req-1", accounts: new Set() }, get);
  expect(validateDescriptor(d)).toEqual([]);
  return d;
}

const post = (path: string, params: Record<string, unknown>): WriteRequest => ({ method: "POST", path, params });
// Every fromCreative call site: a creative{creative_id} (an ad create, and an ad update as ads_update_ad sends it), a
// top-level creative_id, an ad copy's source creative, and each ad listed under an ad set copy.
const WRITES: ReadonlyArray<readonly [string, WriteRequest, string]> = [
  ["ad create, creative.creative_id", post(`/${ACT}/ads`, { adset_id: ADSET, status: "PAUSED", creative: { creative_id: CREATIVE } }), "creative_id"],
  ["ad update, creative.creative_id", post(`/${AD}`, { creative: { creative_id: CREATIVE } }), "creative_id"],
  ["top-level creative_id", post(`/${AD}`, { creative_id: CREATIVE }), "creative_id"],
  ["ad copy, source creative", post(`/${AD}/copies`, { adset_id: ADSET }), "source_ad"],
  ["ad set copy, listed ad's creative", post(`/${ADSET}/copies`, { campaign_id: CAMP }), "source_ad"],
];
const unresolved = (d: Descriptor) => d.identity.filter((e) => e.field === "creative_id");
const SITE_LINK = { site_link_title: "t", site_link_url: "https://example.com", site_link_image_hash: "h" };

describe("admittedCreativeSpec: the destination screenshot setting (contract 1.2 §5.1)", () => {
  it("S1: admits the live creative's key shape, enroll_status alone in creative_sourcing_spec", () => {
    expect(Object.keys(liveCreative()).sort()).toEqual(
      ["actor_id", "id", "instagram_user_id", "name", "object_story_spec", "degrees_of_freedom_spec", "contextual_multi_ads", "creative_sourcing_spec", "portrait_customizations", "url_tags", "effective_object_story_id"].sort(),
    );
    expect(admittedCreativeSpec(liveCreative())).toBe(true);
  });

  it("S2: admits enroll_status beside the site-link paths", () => {
    const sourcing = {
      site_links_spec: [{ site_link_title: "t", site_link_url: "https://example.com", site_link_image_hash: "h" }],
      destination_screenshot_spec: { enroll_status: "OPT_OUT" },
    };
    expect(admittedCreativeSpec(liveCreative(sourcing))).toBe(true);
  });

  it("S3: refuses every other path under destination_screenshot_spec, and an id-bearing path beside it", () => {
    const refusedShapes: Record<string, unknown> = {
      "a sibling key beside enroll_status": { destination_screenshot_spec: { enroll_status: "OPT_IN", screenshot_id: "9998000000000001" } },
      "a sibling key alone": { destination_screenshot_spec: { screenshot_url: "https://example.com" } },
      "a path under enroll_status": { destination_screenshot_spec: { enroll_status: { id: "9998000000000001" } } },
      "an empty destination_screenshot_spec": { destination_screenshot_spec: {} },
      "enroll_status at the wrong depth": { enroll_status: "OPT_IN" },
      "a catalog beside it": { destination_screenshot_spec: { enroll_status: "OPT_IN" }, associated_product_set_id: "9998000000000002" },
      "an unparsed string": JSON.stringify({ destination_screenshot_spec: { enroll_status: "OPT_IN" } }),
      "null": null,
    };
    for (const [name, sourcing] of Object.entries(refusedShapes)) expect(admittedCreativeSpec(liveCreative(sourcing)), name).toBe(false);
  });
});

describe("admittedCreativeSpec: site links on a creative as read (contract §3.2, §5.1)", () => {
  it("S10: admits site-link paths alone, with no screenshot setting", () => {
    expect(admittedCreativeSpec(liveCreative({ site_links_spec: [SITE_LINK] }))).toBe(true);
  });

  it("S11: refuses an unlisted path under site_links_spec, alone and beside the setting", () => {
    const bad = { site_links_spec: [{ ...SITE_LINK, site_link_id: "9998000000000003" }] };
    expect(admittedCreativeSpec(liveCreative(bad))).toBe(false);
    expect(admittedCreativeSpec(liveCreative({ ...bad, destination_screenshot_spec: { enroll_status: "OPT_IN" } }))).toBe(false);
  });
});

describe("the descriptor of a write that reads such a creative (contract 1.2 §3.2)", () => {
  it.each(WRITES)("S12 %s: site links alone leave no unresolved creative_id entry", async (_name, req) => {
    const d = await build(req, world(liveCreative({ site_links_spec: [SITE_LINK] })));
    expect(unresolved(d)).toEqual([]);
  });

  it.each(WRITES)("S13 %s: an unlisted site-link path leaves it unresolved", async (_name, req, via) => {
    const sourcing = { site_links_spec: [{ ...SITE_LINK, site_link_id: "9998000000000003" }] };
    const d = await build(req, world(liveCreative(sourcing)));
    expect(unresolved(d)).toEqual([{ field: "creative_id", via, id: CREATIVE, owner_page: null, owner_ig: null }]);
  });

  it.each(WRITES)("S4 %s: the live creative leaves no unresolved creative_id entry", async (_name, req) => {
    const d = await build(req, world(liveCreative()));
    expect(unresolved(d)).toEqual([]);
    expect(d.identity.length).toBeGreaterThan(0);
    for (const e of d.identity) expect(e.owner_page ?? e.owner_ig, `${e.field} ${e.via}`).not.toBeNull();
  });

  it.each(WRITES)("S5 %s: a sibling key under destination_screenshot_spec leaves it unresolved", async (_name, req, via) => {
    const sourcing = { destination_screenshot_spec: { enroll_status: "OPT_IN", screenshot_id: "9998000000000001" } };
    const d = await build(req, world(liveCreative(sourcing)));
    expect(unresolved(d)).toEqual([{ field: "creative_id", via, id: CREATIVE, owner_page: null, owner_ig: null }]);
  });

  it.each(WRITES)("S6 %s: an id-bearing path beside it leaves it unresolved", async (_name, req, via) => {
    const sourcing = { destination_screenshot_spec: { enroll_status: "OPT_IN" }, associated_product_set_id: "9998000000000002" };
    const d = await build(req, world(liveCreative(sourcing)));
    expect(unresolved(d)).toEqual([{ field: "creative_id", via, id: CREATIVE, owner_page: null, owner_ig: null }]);
  });
});

describe("the path is read, never sent (contract 1.2 §5.1)", () => {
  it("S7: §5.1 lists it under creative_sourcing_spec beside the three site-link paths, and the table is 1.2", () => {
    expect(ENDPOINTS.v).toBe("1.2");
    expect(ENDPOINTS.sub_keys.creative_sourcing_spec).toEqual([...SITE_LINKS, ENROLL]);
  });

  it("S8: no key set names it, the creative GET's fields are unchanged, and no fork tool builds it", () => {
    for (const row of ENDPOINTS.rows) {
      for (const k of Object.values(row.keys).flat()) expect(k.includes("destination_screenshot"), `${row.id} ${k}`).toBe(false);
    }
    expect(CREATIVE_READ_FIELDS.split(",")).not.toContain("destination_screenshot_spec");
    expect(CREATIVE_READ_FIELDS.split(",")).toContain("creative_sourcing_spec");
    const src = fileURLToPath(new URL("../../src", import.meta.url));
    const files = readdirSync(src, { recursive: true, encoding: "utf8" }).filter((f) => f.endsWith(".ts") && f !== join("meta", "write-descriptor.ts"));
    for (const f of files) expect(readFileSync(join(src, f), "utf8").includes("destination_screenshot"), f).toBe(false);
  });

  it("S9: an inline creative's creative_sourcing_spec path still misses the ad create's key set", () => {
    const d = { method: "POST", path: `/${ACT}/ads`, object: { type: "ad" }, params_keys: ["creative", `creative.creative_sourcing_spec.${ENROLL}`] } as unknown as Descriptor;
    expect(keySetMiss(d)).toEqual({ key: `creative.creative_sourcing_spec.${ENROLL}`, row: "POST /act_{id}/ads" });
  });
});
