// The descriptor builder at contract docs/contracts/meta-ads-guard.md@1.1 (spec check 6): what no vendored fixture
// decides alone. `asset_feed_spec` entries (§3.2, C5, C17): an entry only for a leaf whose last key names a kind
// and whose value is a Graph id; the path stays in params_keys either way. `cells`, `creative_asset_groups_spec` and
// `creative_sourcing_spec` are bounded (C10). A cell of ad sets lists their parent campaigns (C13). The creative GET
// reads exactly the keys §3.2, §3.3 and §5 name (C12).
import { describe, expect, it } from "vitest";

import { answerGet } from "../fixtures/meta-ads-guard/harness.js";
import {
  ASSET_FEED_KINDS,
  CREATIVE_READ_FIELDS,
  admittedCreativeSpec,
  buildDescriptor,
  validateDescriptor,
  type GraphGet,
  type IdentityEntry,
  type WriteRequest,
} from "../../src/meta/write-descriptor.js";

interface Call {
  path: string;
  params: Record<string, string | number>;
}

const ACT = "act_9990000000000001";
const ACT_DIGITS = "9990000000000001";
const CAMP = "9994000000000001";
const CAMP2 = "9994000000000002";
const ADSET = "9995000000000001";
const ADSET2 = "9995000000000002";
const STUDY = "9999000000000174";
const BUSINESS = "9999000000000001";
const PAGE = "9991000000000001";
const OTHER_PAGE = "9991000000000003";
const IG = "9992000000000002";
const FORM = "9998000000000860";
const PIXEL = "9993000000000001";

function world(extra: Record<string, unknown> = {}): Map<string, unknown> {
  return new Map(
    Object.entries({
      [`/${ACT}`]: { spend_cap: "500000", amount_spent: "1200", currency: "USD" },
      [`/${CAMP}`]: { account_id: ACT_DIGITS, name: "sb-usb-h1", spend_cap: "100000", effective_status: "PAUSED", buying_type: "AUCTION" },
      [`/${CAMP2}`]: { account_id: ACT_DIGITS, name: "sb-usb-h2", spend_cap: "200000", effective_status: "PAUSED", buying_type: "AUCTION" },
      [`/${ADSET}`]: { campaign_id: CAMP },
      [`/${ADSET2}`]: { campaign_id: CAMP2 },
      [`/${PAGE}`]: { id: PAGE },
      [`/${OTHER_PAGE}`]: { id: OTHER_PAGE },
      [`/${IG}`]: { id: IG },
      [`/${FORM}`]: { page: { id: PAGE } },
      ...extra,
    }),
  );
}

async function build(req: WriteRequest, gets: Map<string, unknown> = world()) {
  const calls: Call[] = [];
  const get: GraphGet = async <T>(path: string, params: Record<string, string | number>): Promise<T> => {
    calls.push({ path, params });
    return answerGet(gets, path, params) as T;
  };
  const d = await buildDescriptor(req, { tool: "ads_test_tool", validateOnly: false, requestId: "r", accounts: new Set() }, get);
  expect(validateDescriptor(d)).toEqual([]);
  return { d, calls };
}

const post = (path: string, params: Record<string, unknown>): WriteRequest => ({ method: "POST", path, params });
const creativeCreate = (assetFeedSpec: unknown, extra: Record<string, unknown> = {}) =>
  post(`/${ACT}/adcreatives`, { name: "c", object_story_spec: { page_id: PAGE }, asset_feed_spec: assetFeedSpec, ...extra });
const feedEntries = (identity: IdentityEntry[]) => identity.filter((e) => e.via === "asset_feed_spec");
const ctaPage = (page: unknown) => ({ bodies: [{ text: "b" }], call_to_actions: [{ type: "LEARN_MORE", value: { page } }] });

describe("ASSET_FEED_KINDS", () => {
  it("is exactly contract §3.2's kinds, each to the field of its kind", () => {
    expect(ASSET_FEED_KINDS).toEqual({
      page: "object_story_spec.page_id",
      page_id: "object_story_spec.page_id",
      instagram_user_id: "object_story_spec.instagram_user_id",
      instagram_actor_id: "object_story_spec.instagram_user_id",
      lead_gen_form_id: "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
      pixel_id: "promoted_object.pixel_id",
    });
  });
});

describe("asset_feed_spec entries (C5, C17)", () => {
  it("an id at call_to_actions.value.page is an entry: the Page's field, its owner by GET; the path stays", async () => {
    const { d, calls } = await build(creativeCreate(ctaPage(OTHER_PAGE)));
    expect(feedEntries(d.identity)).toEqual([
      { field: "object_story_spec.page_id", via: "asset_feed_spec", id: OTHER_PAGE, owner_page: OTHER_PAGE, owner_ig: null },
    ]);
    expect(d.params_keys).toContain("asset_feed_spec.call_to_actions.value.page");
    expect(calls.filter((c) => c.path === `/${OTHER_PAGE}`).map((c) => c.params)).toEqual([{ fields: "id" }]);
  });

  it("the same leaf holding a non-id gets no entry, and its path stays", async () => {
    const { d, calls } = await build(creativeCreate(ctaPage("x")));
    expect(feedEntries(d.identity)).toEqual([]);
    expect(d.params_keys).toContain("asset_feed_spec.call_to_actions.value.page");
    expect(calls.some((c) => c.path === "/x")).toBe(false);
  });

  it("an id at a path with no listed kind (app_product_page_id) gets no entry, and its path stays", async () => {
    const { d } = await build(creativeCreate({ bodies: [{ text: "b" }], app_product_page_id: OTHER_PAGE }));
    expect(feedEntries(d.identity)).toEqual([]);
    expect(d.params_keys).toContain("asset_feed_spec.app_product_page_id");
  });

  it("an inline creative.asset_feed_spec's id is an entry too", async () => {
    const { d } = await build(post(`/${ACT}/ads`, { name: "a", adset_id: ADSET, status: "PAUSED", creative: { object_story_spec: { page_id: PAGE }, asset_feed_spec: ctaPage(OTHER_PAGE) } }));
    expect(feedEntries(d.identity)).toEqual([
      { field: "object_story_spec.page_id", via: "asset_feed_spec", id: OTHER_PAGE, owner_page: OTHER_PAGE, owner_ig: null },
    ]);
    expect(d.params_keys).toContain("creative.asset_feed_spec.call_to_actions.value.page");
  });

  it("a lead form inside asset_feed_spec is resolved to its Page by GET of the form's page", async () => {
    const { d, calls } = await build(creativeCreate({ call_to_actions: [{ value: { lead_gen_form_id: FORM } }] }));
    expect(feedEntries(d.identity)).toEqual([
      { field: "object_story_spec.link_data.call_to_action.value.lead_gen_form_id", via: "asset_feed_spec", id: FORM, owner_page: PAGE, owner_ig: null },
    ]);
    expect(calls.filter((c) => c.path === `/${FORM}`).map((c) => c.params)).toEqual([{ fields: "page{id}" }]);
  });

  it("an unreadable owner is null", async () => {
    const { d } = await build(creativeCreate(ctaPage(OTHER_PAGE)), world({ [`/${OTHER_PAGE}`]: new Error("down") }));
    expect(feedEntries(d.identity)).toEqual([
      { field: "object_story_spec.page_id", via: "asset_feed_spec", id: OTHER_PAGE, owner_page: null, owner_ig: null },
    ]);
  });

  // One row per kind, each its own leaf name: a kind mapped wrong, or missing, fails its row.
  it.each([
    ["page", OTHER_PAGE, { field: "object_story_spec.page_id", owner_page: OTHER_PAGE, owner_ig: null }],
    ["page_id", OTHER_PAGE, { field: "object_story_spec.page_id", owner_page: OTHER_PAGE, owner_ig: null }],
    ["instagram_user_id", IG, { field: "object_story_spec.instagram_user_id", owner_page: null, owner_ig: IG }],
    ["instagram_actor_id", IG, { field: "object_story_spec.instagram_user_id", owner_page: null, owner_ig: IG }],
    ["lead_gen_form_id", FORM, { field: "object_story_spec.link_data.call_to_action.value.lead_gen_form_id", owner_page: PAGE, owner_ig: null }],
    ["pixel_id", PIXEL, { field: "promoted_object.pixel_id", owner_page: null, owner_ig: null }],
  ] as const)("kind %s", async (kind, id, want) => {
    const { d, calls } = await build(creativeCreate({ link_urls: [{ website_url: "https://example.com", [kind]: id }] }));
    expect(feedEntries(d.identity)).toEqual([{ ...want, via: "asset_feed_spec", id }]);
    expect(d.params_keys).toContain(`asset_feed_spec.link_urls.${kind}`);
    // A pixel has no owner: no GET of it.
    expect(calls.some((c) => c.path === `/${id}`)).toBe(kind !== "pixel_id");
  });

  it("an id beside an object in a kind's array is a leaf at the kind's path (as params_keys has it): an entry", async () => {
    const { d } = await build(creativeCreate({ call_to_actions: [{ value: { page: [{ id: "1" }, OTHER_PAGE] } }] }));
    expect(feedEntries(d.identity).map((e) => [e.field, e.id])).toEqual([["object_story_spec.page_id", OTHER_PAGE]]);
    expect(d.params_keys).toContain("asset_feed_spec.call_to_actions.value.page");
    expect(d.params_keys).toContain("asset_feed_spec.call_to_actions.value.page.id");
  });

  it("a leaf named for an inherited property (toString) is no kind: no entry, and its path stays", async () => {
    const { d } = await build(creativeCreate({ link_urls: [{ toString: OTHER_PAGE }] }));
    expect(feedEntries(d.identity)).toEqual([]);
    expect(d.params_keys).toContain("asset_feed_spec.link_urls.toString");
  });

  it("a kind's id in an array of ids is no Graph id: no entry, and its path stays", async () => {
    const { d } = await build(creativeCreate({ link_urls: [{ page: [OTHER_PAGE] }] }));
    expect(feedEntries(d.identity)).toEqual([]);
    expect(d.params_keys).toContain("asset_feed_spec.link_urls.page");
  });

  it("an attached creative's asset_feed_spec id is no asset_feed_spec entry: the creative is unresolved", async () => {
    const creative = "9997000000000001";
    const gets = world({ [`/${creative}`]: { id: creative, object_story_spec: { page_id: PAGE }, asset_feed_spec: ctaPage(OTHER_PAGE) } });
    const { d } = await build(post(`/${ACT}/ads`, { name: "a", adset_id: ADSET, status: "PAUSED", creative: { creative_id: creative } }), gets);
    expect(feedEntries(d.identity)).toEqual([]);
    expect(d.identity).toContainEqual({ field: "creative_id", via: "creative_id", id: creative, owner_page: null, owner_ig: null });
  });
});

describe("bounded at 1.1 (C10)", () => {
  it("cells: every cell key's path is in params_keys, an unlisted one (adaccounts) too, for rule 8", async () => {
    const cells = [
      { name: "a", treatment_percentage: 50, campaigns: [CAMP], adaccounts: [ACT] },
      { name: "b", treatment_percentage: 50, campaigns: [CAMP2] },
    ];
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { name: "s", cells }));
    expect(d.params_keys).toEqual(["name", "cells", "cells.name", "cells.treatment_percentage", "cells.campaigns", "cells.adaccounts"]);
    expect(d.campaigns.map((c) => [c.id, c.role])).toEqual([[CAMP, "study-cell"], [CAMP2, "study-cell"]]);
  });

  it("a cell scalar holding an object is a path too, and is not read for campaigns", async () => {
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP], name: { campaigns: [CAMP2] } }] }));
    expect(d.params_keys).toEqual(["cells", "cells.campaigns", "cells.name.campaigns"]);
    expect(d.campaigns.map((c) => c.id)).toEqual([CAMP]);
  });

  it("creative_asset_groups_spec and creative_sourcing_spec leaf paths", async () => {
    const groups = [{ images: [{ hash: "h" }], texts: [{ text: "t", text_type: "PRIMARY_TEXT" }], call_to_action: { type: "SHOP_NOW", value: { link: "https://example.com" } } }];
    const ad = await build(post(`/${ACT}/ads`, { name: "a", adset_id: ADSET, status: "PAUSED", creative_asset_groups_spec: { groups } }));
    expect(ad.d.params_keys).toEqual([
      "name",
      "adset_id",
      "status",
      "creative_asset_groups_spec",
      "creative_asset_groups_spec.groups.images.hash",
      "creative_asset_groups_spec.groups.texts.text",
      "creative_asset_groups_spec.groups.texts.text_type",
      "creative_asset_groups_spec.groups.call_to_action.type",
      "creative_asset_groups_spec.groups.call_to_action.value.link",
    ]);
    const site = await build(post(`/${ACT}/adcreatives`, { name: "c", creative_sourcing_spec: { site_links_spec: [{ site_link_title: "t", site_link_url: "https://example.com" }] } }));
    expect(site.d.params_keys).toEqual([
      "name",
      "creative_sourcing_spec",
      "creative_sourcing_spec.site_links_spec.site_link_title",
      "creative_sourcing_spec.site_links_spec.site_link_url",
    ]);
  });
});

describe("C13: a cell of ad sets lists the ad sets' parent campaigns", () => {
  it("in a study create's body", async () => {
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells: [{ adsets: [ADSET] }, { adsets: [ADSET2] }] }));
    expect(d.campaigns.map((c) => [c.id, c.role])).toEqual([[CAMP, "study-cell"], [CAMP2, "study-cell"]]);
  });

  it("in an existing study's listed cells", async () => {
    const gets = world({
      [`/${STUDY}`]: { metadata: { type: "adstudy" }, business: { id: BUSINESS } },
      [`/${STUDY}/cells`]: { data: [{ adsets: { data: [{ id: ADSET, campaign_id: CAMP }] } }, { adsets: { data: [{ id: ADSET2, campaign_id: CAMP2 }] } }] },
    });
    const { d } = await build(post(`/${STUDY}`, { name: "renamed" }), gets);
    expect(d.campaigns.map((c) => [c.id, c.role])).toEqual([[CAMP, "study-cell"], [CAMP2, "study-cell"]]);
  });
});

describe("C12: the creative GET", () => {
  it("reads interactive_components_spec, which no key set admits from 1.1", () => {
    expect(CREATIVE_READ_FIELDS.split(",")).toContain("interactive_components_spec");
    expect(admittedCreativeSpec({ id: "1", object_story_spec: { page_id: PAGE }, interactive_components_spec: { components: [] } })).toBe(false);
    expect(admittedCreativeSpec({ id: "1", object_story_spec: { page_id: PAGE } })).toBe(true);
  });
});
