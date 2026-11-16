import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import * as fake from "../fixtures/meta-ads-guard/fake-guard.mjs";
import {
  ACCOUNT_TOOLS,
  CREATED_TYPE,
  CREATIVE_READ_FIELDS,
  ENDPOINTS,
  IDENTITY_FIELDS,
  TOOL_EXPECTED_TYPES,
  WriteRefusal,
  admittedCreativeSpec,
  deriveAccountLimit,
  deriveCreativeBearing,
  deriveKind,
  matchEndpoint,
  minorAmount,
  objectTypeOf,
  paramsKeys,
  validateDescriptor,
  type Descriptor,
  type ObjectType,
} from "../../src/meta/write-descriptor.js";

const DIR = fileURLToPath(new URL("../fixtures/meta-ads-guard", import.meta.url));
const VENDORED = JSON.parse(readFileSync(join(DIR, "endpoints.json"), "utf8")) as Record<string, unknown>;
const FIXTURES = fake.loadFixtures(join(DIR, "fixtures"));
const WITH_DESCRIPTOR = FIXTURES.filter((f) => f.descriptor);
const byName = (name: string) => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};

describe("ENDPOINTS", () => {
  it("embedded table equals vendored endpoints.json", () => {
    const { coverage: _coverage, ...rest } = VENDORED;
    expect(JSON.parse(JSON.stringify(ENDPOINTS))).toEqual(rest);
  });
});

describe("matchEndpoint, deriveKind, deriveAccountLimit, deriveCreativeBearing", () => {
  it("agree with the fake on every fixture descriptor", () => {
    expect(WITH_DESCRIPTOR.length).toBeGreaterThan(100);
    let matched = 0;
    for (const f of WITH_DESCRIPTOR) {
      const d = f.descriptor as unknown as Descriptor;
      const row = matchEndpoint(d.method, d.path, d.object.type);
      const fakeRow = fake.matchEndpoint(VENDORED, d.method, d.path, d.object.type) as { id: string } | null;
      expect(row?.id ?? null, f.name).toBe(fakeRow?.id ?? null);
      if (row) matched++;
      expect(deriveKind(row, d), f.name).toBe(fake.deriveKind(fakeRow, d));
      expect(deriveAccountLimit(row, d), f.name).toBe(fake.deriveAccountLimit(VENDORED, fakeRow, d));
      expect(deriveCreativeBearing(row, d), f.name).toBe(fake.deriveCreativeBearing(fakeRow, d));
    }
    expect(matched).toBeGreaterThan(100);
  });

  it("match a /vNN.N prefix and a post id, and nothing for an unknown edge", () => {
    expect(matchEndpoint("POST", "/v23.0/act_1/campaigns", "other")?.id).toBe("POST /act_{id}/campaigns");
    expect(matchEndpoint("POST", "/1_2", "page_post")?.id).toBe("POST /{page_post_id}");
    expect(matchEndpoint("POST", "/act_1/nosuchedge", "other")).toBeNull();
  });

  it("derive the refinements", () => {
    const ads = matchEndpoint("POST", "/act_1/ads", "ad");
    const inlinePost = { field: "object_story_id", via: "creative", id: "1_2", owner_page: null, owner_ig: null } as const;
    const base = { params_keys: ["creative"], status: { before: null, after: null } };
    expect(deriveKind(ads, { ...base, identity: [inlinePost] })).toBe("boost");
    expect(deriveKind(ads, { ...base, identity: [{ ...inlinePost, via: "direct" }] })).toBe("create");
    const camp = matchEndpoint("POST", "/1", "campaign");
    const del = { identity: [], status: { before: "PAUSED", after: "DELETED" } } as Pick<Descriptor, "identity" | "status">;
    expect(deriveKind(camp, { ...del, params_keys: ["status", "execution_options"] })).toBe("delete");
    expect(deriveKind(camp, { ...del, params_keys: ["status", "name"] })).toBe("update");
    expect(deriveKind(null, { ...del, params_keys: [] })).toBe("other");
  });

  it("derive account_limit by keys", () => {
    const camps = matchEndpoint("POST", "/act_1/campaigns", "other");
    const adsets = matchEndpoint("POST", "/act_1/adsets", "other");
    const d = (params_keys: string[], type: ObjectType = "campaign", path = "/act_1/campaigns") => ({
      object: { type, id: null, created: true },
      path,
      params_keys,
    });
    expect(deriveAccountLimit(camps, d(["spend_cap"]))).toBe(false);
    expect(deriveAccountLimit(adsets, d(["spend_cap"]))).toBe(true);
    expect(deriveAccountLimit(adsets, d(["billing_event"]))).toBe(false);
    expect(deriveAccountLimit(adsets, d(["Billing_Address"]))).toBe(true);
    expect(deriveAccountLimit(adsets, d(["funding_source"]))).toBe(true);
    expect(deriveAccountLimit(adsets, d(["spend_cap_action"]))).toBe(true);
    expect(deriveAccountLimit(null, d([], "other", "/act_1/nosuchedge"))).toBe(true);
    expect(deriveAccountLimit(null, d([], "other", "/v23.0/act_1/nosuchedge"))).toBe(true);
    expect(deriveAccountLimit(null, d([], "other", "/1/nosuchedge"))).toBe(false);
    expect(deriveAccountLimit(null, d([], "account", "/1/nosuchedge"))).toBe(true);
  });
});

describe("paramsKeys", () => {
  it("an attached creative is creative.creative_id", () => {
    expect(paramsKeys({ creative: { creative_id: "1" } })).toEqual(["creative", "creative.creative_id"]);
  });

  it("ig-ok__inline's body gives its fixture params_keys", () => {
    const body = {
      name: "ad",
      adset_id: "9995000000000440",
      status: "PAUSED",
      creative: { object_story_spec: { page_id: "9991000000000002", instagram_user_id: "9992000000000002" } },
    };
    const want = (byName("ig-ok__inline").descriptor as { params_keys: string[] }).params_keys;
    expect(new Set(paramsKeys(body))).toEqual(new Set(want));
    expect(paramsKeys(body)).toHaveLength(want.length);
  });

  it("asset_feed_spec leaf paths drop array indices and de-duplicate", () => {
    const keys = paramsKeys({ asset_feed_spec: { images: [{ hash: "h" }, { hash: "i" }], ad_formats: ["SINGLE_IMAGE"] } });
    expect(keys).toEqual(["asset_feed_spec", "asset_feed_spec.images.hash", "asset_feed_spec.ad_formats"]);
  });

  it("drops access_token", () => {
    expect(paramsKeys({ access_token: "x", name: "n" })).toEqual(["name"]);
  });

  it("an empty bounded object has no path", () => {
    expect(paramsKeys({ object_story_spec: {} })).toEqual(["object_story_spec"]);
  });

  it("an object that is not bounded has no path", () => {
    expect(paramsKeys({ targeting: { method: "x" } })).toEqual(["targeting"]);
  });

  it("a bounded object under an inline creative gets creative.<key>.<path>", () => {
    expect(paramsKeys({ creative: { call_to_action: { type: "LEARN_MORE", value: { link: "l" } } } })).toEqual([
      "creative",
      "creative.call_to_action",
      "creative.call_to_action.type",
      "creative.call_to_action.value.link",
    ]);
  });

  it("a primitive in an array of objects is a leaf at the array's path (fails closed)", () => {
    expect(paramsKeys({ asset_feed_spec: { images: [{ hash: "h" }, "x"] } })).toEqual([
      "asset_feed_spec",
      "asset_feed_spec.images.hash",
      "asset_feed_spec.images",
    ]);
  });

  it("an array of arrays of objects is walked through (indices dropped at every depth)", () => {
    expect(paramsKeys({ asset_feed_spec: { images: [[[{ hash: "h" }]]] } })).toEqual([
      "asset_feed_spec",
      "asset_feed_spec.images.hash",
    ]);
  });

  it("a non-object directly in a bounded key's own array adds no path (Task 4 rule 11 must refuse it)", () => {
    expect(paramsKeys({ objectives: [{ name: "a" }, 3] })).toEqual(["objectives", "objectives.name"]);
  });

  it("a JSON string is a leaf; a creative string has no creative.<k>", () => {
    expect(paramsKeys({ object_story_spec: '{"page_id":"1"}', creative: '{"creative_id":"1"}' })).toEqual([
      "object_story_spec",
      "creative",
    ]);
  });
});

describe("admittedCreativeSpec", () => {
  const ok = {
    id: "9993000000000001",
    account_id: "9990000000000002",
    actor_id: "9991000000000002",
    effective_object_story_id: "9991000000000002_1",
    object_story_spec: { page_id: "9991000000000002", link_data: { link: "https://example.com", message: "m" } },
    instagram_user_id: "9992000000000002",
  };

  it("is true for an ig-ok__creative_id-shaped spec", () => {
    expect(admittedCreativeSpec(ok)).toBe(true);
  });

  it("is false for branded_content, destination_spec, a sponsor page path", () => {
    expect(admittedCreativeSpec({ ...ok, branded_content: { x: 1 } })).toBe(false);
    expect(admittedCreativeSpec({ ...ok, destination_spec: { x: 1 } })).toBe(false);
    expect(
      admittedCreativeSpec({
        ...ok,
        object_story_spec: { page_id: "1", link_data: { link: "l", branded_content_sponsor_page_id: "2" } },
      }),
    ).toBe(false);
  });

  it("admits instagram_actor_id, id and account_id", () => {
    expect(admittedCreativeSpec({ ...ok, instagram_actor_id: "9992000000000002" })).toBe(true);
  });

  it("is false for an empty bounded object, and for a non-object directly in a bounded array", () => {
    expect(admittedCreativeSpec({ ...ok, object_story_spec: {} })).toBe(false);
    expect(admittedCreativeSpec({ ...ok, asset_feed_spec: [{ images: [{ hash: "h" }] }] })).toBe(true);
    expect(admittedCreativeSpec({ ...ok, asset_feed_spec: [{ images: [{ hash: "h" }] }, "x"] })).toBe(false);
  });

  it("is false for creative_id and for an unparsed bounded object", () => {
    expect(admittedCreativeSpec({ ...ok, creative_id: "1" })).toBe(false);
    expect(admittedCreativeSpec({ ...ok, object_story_spec: '{"page_id":"1"}' })).toBe(false);
    expect(admittedCreativeSpec({ ...ok, call_to_action: { type: "X", value: { page: "1" } } })).toBe(false);
  });
});

describe("CREATIVE_READ_FIELDS", () => {
  const fields = CREATIVE_READ_FIELDS.split(",");
  it("is exactly ruling R1's 30 fields", () => {
    expect(fields).toEqual([
      "name",
      "object_story_spec",
      "object_story_id",
      "source_instagram_media_id",
      "instagram_user_id",
      "asset_feed_spec",
      "url_tags",
      "degrees_of_freedom_spec",
      "contextual_multi_ads",
      "object_id",
      "call_to_action",
      "image_crops",
      "interactive_components_spec",
      "portrait_customizations",
      "categorization_criteria",
      "link_url",
      "platform_customizations",
      "adlabels",
      "effective_object_story_id",
      "actor_id",
      "instagram_actor_id",
      "branded_content",
      "facebook_branded_content",
      "instagram_branded_content",
      "product_set_id",
      "template_url_spec",
      "applink_treatment",
      "creative_sourcing_spec",
      "destination_spec",
      "wamo_whatsapp_identity_spec",
    ]);
  });

  it("excludes creative_id and includes each contract §5 left-out key", () => {
    expect(fields).not.toContain("creative_id");
    for (const k of [
      "branded_content",
      "facebook_branded_content",
      "instagram_branded_content",
      "product_set_id",
      "template_url_spec",
      "applink_treatment",
      "creative_sourcing_spec",
      "destination_spec",
      "wamo_whatsapp_identity_spec",
      "effective_object_story_id",
      "actor_id",
      "instagram_actor_id",
      "object_story_spec",
      "asset_feed_spec",
      "instagram_user_id",
    ]) {
      expect(fields).toContain(k);
    }
    expect(new Set(fields).size).toBe(fields.length);
  });
});

describe("minorAmount", () => {
  it.each([
    [1000, 1000],
    ["1000", 1000],
    [0, 0],
    [-0, 0],
    [-1, null],
    [1.5, null],
    ["1e3", null],
    ["10.0", null],
    ["", null],
    [Number.NaN, null],
    ["922337203685478", null],
    [922337203685478, null],
    ["9007199254740993", null],
    ["12345678901234567", null],
    [null, null],
    [undefined, null],
    [{}, null],
  ])("%j → %j", (v, want) => {
    expect(minorAmount(v)).toBe(want);
  });
});

describe("objectTypeOf", () => {
  it.each([
    ["campaign", "campaign"],
    ["adcampaign_group", "campaign"],
    ["adset", "adset"],
    ["adcampaign", "adset"],
    ["ad", "ad"],
    ["adgroup", "ad"],
    ["adcreative", "creative"],
    ["adimage", "image"],
    ["advideo", "video"],
    ["video", "video"],
    ["customaudience", "audience"],
    ["customconversion", "custom_conversion"],
    ["adstudy", "study"],
    ["ad_study", "study"],
    ["budget_schedule", "budget_schedule"],
    ["post", "page_post"],
    ["page_post", "page_post"],
    ["pagepost", "page_post"],
    ["adaccount", "account"],
    ["page", "other"],
    [undefined, "other"],
    [42, "other"],
    ["toString", "other"],
  ])("%j → %j", (v, want) => {
    expect(objectTypeOf(v)).toBe(want);
  });
});

describe("validateDescriptor", () => {
  it("is empty on every valid fixture descriptor and non-empty on both invalid__ ones", () => {
    let invalid = 0;
    for (const f of WITH_DESCRIPTOR) {
      const problems = validateDescriptor(f.descriptor);
      expect(problems, f.name).toEqual(fake.validateDescriptor(f.descriptor));
      if (f.name.startsWith("invalid__")) {
        invalid++;
        expect(problems.length, f.name).toBeGreaterThan(0);
      } else {
        expect(problems, f.name).toEqual([]);
      }
    }
    expect(invalid).toBe(2);
  });

  it("refuses a non-object and a wrong carrier key", () => {
    expect(validateDescriptor(null)).toEqual(["descriptor must be an object"]);
    const d = structuredClone(byName("ig-ok__inline").descriptor) as { identity: Record<string, unknown>[] };
    d.identity[0].owner_ig = "1";
    expect(validateDescriptor(d)).toEqual(fake.validateDescriptor(d));
    expect(validateDescriptor(d)).toContain("identity[0].owner_ig must be null for object_story_spec.page_id");
  });

  it("refuses a resolved creative_id entry and duplicate params_keys, as the fake does", () => {
    const base = byName("ig-ok__creative_id").descriptor as Record<string, unknown>;
    const cid = structuredClone(base) as { identity: Record<string, unknown>[] };
    cid.identity.push({ field: "creative_id", via: "creative_id", id: "1", owner_page: "2", owner_ig: null });
    expect(validateDescriptor(cid)).toEqual(["identity[2].owner_page must be null for creative_id"]);
    expect(validateDescriptor(cid)).toEqual(fake.validateDescriptor(cid));
    const dup = { ...structuredClone(base), params_keys: ["name", "name"] };
    expect(validateDescriptor(dup)).toEqual(['descriptor.params_keys is invalid: ["name","name"]']);
    expect(validateDescriptor(dup)).toEqual(fake.validateDescriptor(dup));
  });
});

describe("tables", () => {
  it("CREATED_TYPE maps each create row", () => {
    expect(CREATED_TYPE).toEqual({
      "POST /act_{id}/campaigns": "campaign",
      "POST /act_{id}/adsets": "adset",
      "POST /act_{id}/ads": "ad",
      "POST /act_{id}/adcreatives": "creative",
      "POST /act_{id}/adimages": "image",
      "POST /act_{id}/advideos": "video",
      "POST /act_{id}/customaudiences": "audience",
      "POST /act_{id}/customconversions": "custom_conversion",
      "POST /{business_id}/ad_studies": "study",
      "POST /{campaign_id}/budget_schedules": "budget_schedule",
    });
    const ids = new Set(ENDPOINTS.rows.map((r) => r.id));
    for (const id of Object.keys(CREATED_TYPE)) expect(ids.has(id), id).toBe(true);
  });

  it("IDENTITY_FIELDS: direct and creative fields are contract §3.2 fields; none under asset_feed_spec", () => {
    const want = [
      "object_id",
      "object_story_id",
      "instagram_user_id",
      "instagram_actor_id",
      "source_instagram_media_id",
      "pixel_id",
      "object_story_spec.page_id",
      "object_story_spec.instagram_user_id",
      "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
      "object_story_spec.video_data.call_to_action.value.lead_gen_form_id",
      "promoted_object.page_id",
      "promoted_object.pixel_id",
      "objectives.adspixels.id",
    ];
    expect([...IDENTITY_FIELDS.direct].sort()).toEqual([...want].sort());
    expect([...IDENTITY_FIELDS.creative].sort()).toEqual([...want].sort());
    for (const f of IDENTITY_FIELDS.direct) {
      expect(Object.hasOwn(fake.OWNER_KEY, f), f).toBe(true);
      expect(f.startsWith("asset_feed_spec"), f).toBe(false);
    }
  });

  it("TOOL_EXPECTED_TYPES and ACCOUNT_TOOLS", () => {
    expect(TOOL_EXPECTED_TYPES).toEqual({
      ads_update_campaign: ["campaign"],
      ads_delete_campaign: ["campaign"],
      ads_update_ad_set: ["adset"],
      ads_delete_ad_set: ["adset"],
      ads_update_ad: ["ad"],
      ads_delete_ad: ["ad"],
      ads_update_ad_creative: ["creative"],
      ads_experiment_abtest_update_test: ["study"],
      ads_update_custom_audience: ["audience"],
      ads_delete_custom_audience: ["audience"],
    });
    expect([...ACCOUNT_TOOLS].sort()).toEqual(["ads_update_entity", "ads_update_spend_cap"]);
  });
});

describe("WriteRefusal", () => {
  it("is an McpError InvalidRequest saying write refused", () => {
    const e = new WriteRefusal("no reason");
    expect(e).toBeInstanceOf(McpError);
    expect(e.code).toBe(ErrorCode.InvalidRequest);
    expect(e.message).toBe(`MCP error ${ErrorCode.InvalidRequest}: write refused: no reason`);
    expect(e.name).toBe("WriteRefusal");
  });
});
