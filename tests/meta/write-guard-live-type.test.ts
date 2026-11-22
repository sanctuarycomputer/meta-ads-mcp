// Ticket 382: an object's type and a post's Page, from what Graph v27 really answers. The fake below answers as the
// live probes did: no metadata.type, code 100 for a field the kind lacks, 200 without the field on a creative, and
// code 10 for a post's owner.
import { describe, expect, it } from "vitest";

import { classifyMetaError } from "../../src/meta/errors.js";
import { buildDescriptor, validateDescriptor, type Descriptor, type GraphGet, type WriteRequest } from "../../src/meta/write-descriptor.js";

const ACT = "act_9990000000000001";
const ACT_DIGITS = "9990000000000001";
const CAMP = "9994000000000001";
const ADSET = "9995000000000001";
const AD = "9996000000000001";
const CREATIVE = "9997000000000001";
const PAGE = "9991000000000001";
const FOREIGN_PAGE = "9991000000000002";
const NODE = "9998000000000001";
const STORY = `${PAGE}_9998000000000086`;
const FOREIGN_STORY = `${FOREIGN_PAGE}_9998000000000087`;

const metaError = (code: number) => classifyMetaError({ message: "refused", type: "OAuthException", code }).mcpError;

type Node = Record<string, unknown> & { lenient?: boolean };
type Answer = Node | Error;

const CAMPAIGN: Node = { objective: "OUTCOME_LEADS", account_id: ACT_DIGITS, status: "PAUSED", effective_status: "PAUSED", name: "c", buying_type: "AUCTION" };
const ADSET_NODE: Node = { optimization_goal: "LINK_CLICKS", account_id: ACT_DIGITS, status: "PAUSED", campaign_id: CAMP };
const AD_NODE: Node = { adset_id: ADSET, account_id: ACT_DIGITS, status: "PAUSED", campaign_id: CAMP, creative: { id: CREATIVE } };
const CREATIVE_NODE: Node = { lenient: true, account_id: ACT_DIGITS, object_story_spec: { page_id: PAGE } };
const PAGE_NODE: Node = { fan_count: 12 };

const TYPE_FIELDS = ["objective", "optimization_goal", "adset_id", "object_story_spec", "effective_object_story_id", "fan_count"];

// One field the node lacks is code 100, except on a creative, which answers 200 without it.
function liveGet(world: Record<string, Answer>, calls: string[] = []): GraphGet {
  return async <T>(path: string, params: Record<string, string | number>): Promise<T> => {
    calls.push(`${path}?${String(params.fields)}`);
    const answer = world[path];
    if (answer === undefined) throw metaError(100);
    if (answer instanceof Error) throw answer;
    const names = String(params.fields ?? "").replace(/\{[^}]*\}/g, "").split(",").filter(Boolean);
    const out: Record<string, unknown> = { id: path.slice(1) };
    if (params.metadata === 1 && Object.hasOwn(answer, "metadata")) out.metadata = answer.metadata;
    for (const n of names) {
      if (Object.hasOwn(answer, n)) out[n] = answer[n];
      else if (names.length === 1 && TYPE_FIELDS.includes(n) && !answer.lenient) throw metaError(100);
    }
    return out as T;
  };
}

const baseWorld = (extra: Record<string, Answer> = {}): Record<string, Answer> => ({
  [`/${ACT}`]: { spend_cap: "500000", amount_spent: "0", currency: "USD" },
  [`/${CAMP}`]: CAMPAIGN,
  [`/${ADSET}`]: ADSET_NODE,
  [`/${AD}`]: AD_NODE,
  [`/${CREATIVE}`]: CREATIVE_NODE,
  [`/${PAGE}`]: { id: PAGE, fan_count: 12 },
  ...extra,
});

async function build(req: WriteRequest, world: Record<string, Answer>, tool = "ads_test_tool", calls: string[] = []): Promise<Descriptor> {
  const d = await buildDescriptor(req, { tool, validateOnly: false, requestId: "req-1", accounts: new Set([ACT]) }, liveGet(world, calls));
  expect(validateDescriptor(d)).toEqual([]);
  return d;
}

const post = (path: string, params: Record<string, unknown> = { name: "n" }): WriteRequest => ({ method: "POST", path, params });
const typeOf = async (node: Answer): Promise<string> => (await build(post(`/${NODE}`), baseWorld({ [`/${NODE}`]: node }))).object.type;
const storyEntries = (d: Descriptor) => d.identity.filter((e) => e.field === "object_story_id");

describe("object.type from a type-revealing field (382)", () => {
  it.each([
    ["campaign by objective", CAMPAIGN, "campaign"],
    ["ad set by optimization_goal", ADSET_NODE, "adset"],
    ["ad by adset_id", AD_NODE, "ad"],
    ["creative by object_story_spec", CREATIVE_NODE, "creative"],
    ["creative by effective_object_story_id", { lenient: true, effective_object_story_id: STORY }, "creative"],
    ["a Page is detected and reported as other", PAGE_NODE, "other"],
  ])("%s", async (_name, node, want) => {
    expect(await typeOf(node)).toBe(want);
  });

  it("an act_<digits> path is account with every read failing", async () => {
    const d = await build(post(`/${ACT}`, { name: "n" }), { [`/${ACT}`]: new Error("down") }, "ads_update_entity");
    expect(d.object).toEqual({ type: "account", id: ACT, created: false });
  });

  it.each(["ads_update_entity", "ads_update_spend_cap"])("the account tool %s does not make a digits node an account", async (tool) => {
    const d = await build(post(`/${CAMP}`), baseWorld(), tool);
    expect(d.object.type).toBe("campaign");
  });

  it("metadata cannot name a kind that has a probe", async () => {
    for (const type of ["campaign", "adset", "ad", "adcreative", "adaccount"]) {
      expect(await typeOf({ metadata: { type } })).toBe("other");
    }
  });

  it("reads each type field alone, and no metadata once a kind matches", async () => {
    const calls: string[] = [];
    await build(post(`/${ADSET}`), baseWorld(), "ads_test_tool", calls);
    const own = calls.filter((c) => c.startsWith(`/${ADSET}?`)).map((c) => c.split("?")[1]);
    expect(own.slice(0, 6)).toEqual(TYPE_FIELDS);
    expect(own).not.toContain("id");
  });

  it("a kind with no probe costs the six reads and one metadata read", async () => {
    const calls: string[] = [];
    await build(post(`/${NODE}`), baseWorld({ [`/${NODE}`]: { metadata: { type: "post" } } }), "ads_test_tool", calls);
    const own = calls.filter((c) => c.startsWith(`/${NODE}?`)).map((c) => c.split("?")[1]);
    expect(own).toEqual([...TYPE_FIELDS, "id"]);
  });

  it("metadata still names a kind with no probe", async () => {
    expect(await typeOf({ metadata: { type: "customaudience" } })).toBe("audience");
  });
});

describe("type detection fails closed (382)", () => {
  it.each(["objective", "optimization_goal", "adset_id", "object_story_spec", "effective_object_story_id"])(
    "%s holding no usable value is no match",
    async (field) => {
      for (const value of [null, "", {}, [], ["x"], false, true]) expect(await typeOf({ lenient: true, [field]: value })).toBe("other");
    },
  );

  it("fan_count holding no usable value is no second kind", async () => {
    for (const value of [null, "", {}, [], ["x"], false, true]) expect(await typeOf({ objective: "X", fan_count: value })).toBe("campaign");
  });

  it("a refused read or a network error is other", async () => {
    expect(await typeOf(metaError(10))).toBe("other");
    expect(await typeOf(new Error("socket hang up"))).toBe("other");
  });

  it("a creative's 200 with the field absent is no match", async () => {
    expect(await typeOf({ lenient: true, account_id: ACT_DIGITS })).toBe("other");
  });

  it.each([
    ["campaign and ad set", { objective: "X", optimization_goal: "Y" }],
    ["ad and creative", { adset_id: ADSET, object_story_spec: { page_id: PAGE } }],
    ["campaign and a Page", { objective: "X", fan_count: 3 }],
  ])("two kinds matching is other: %s", async (_name, node) => {
    expect(await typeOf(node)).toBe("other");
  });

  it("fan_count 0 is present, so it still counts as a second kind", async () => {
    expect(await typeOf({ objective: "X", fan_count: 0 })).toBe("other");
  });
});

describe("rule 2 (M16) on live types (382)", () => {
  const kinds = [
    ["campaign", CAMP, "ads_update_campaign"],
    ["adset", ADSET, "ads_update_ad_set"],
    ["ad", AD, "ads_update_ad"],
    ["creative", CREATIVE, "ads_update_ad_creative"],
  ] as const;
  const pairs = kinds.flatMap(([, , tool]) => kinds.filter((k) => k[2] !== tool).map(([type, id]) => [tool, type, id] as const));

  it("covers all 12 ordered pairs", () => expect(pairs).toHaveLength(12));

  it.each(pairs)("%s refuses a %s", async (tool, type, id) => {
    await expect(build(post(`/${id}`), baseWorld(), tool)).rejects.toThrow(`${id} is a ${type}`);
  });

  it.each(kinds)("the %s tool still writes its own type", async (type, id, tool) => {
    expect((await build(post(`/${id}`), baseWorld(), tool)).object.type).toBe(type);
  });
});

describe("a post's owner Page (382)", () => {
  const withStory = (creative: Node, storyAnswer: Answer = metaError(10)): Record<string, Answer> =>
    baseWorld({ [`/${CREATIVE}`]: { lenient: true, account_id: ACT_DIGITS, ...creative }, [`/${STORY}`]: storyAnswer });
  const attach = post(`/${ACT}/ads`, { name: "n", adset_id: ADSET, creative: { creative_id: CREATIVE } });
  const copy = post(`/${AD}/copies`, { adset_id: ADSET });

  it("a creative's effective id takes its Page from the prefix on code 10", async () => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY })));
    expect(e).toMatchObject({ via: "creative_id", id: STORY, owner_page: PAGE });
  });

  it("so does a copy's source ad's creative", async () => {
    const [e] = storyEntries(await build(copy, withStory({ effective_object_story_id: STORY })));
    expect(e).toMatchObject({ via: "source_ad", id: STORY, owner_page: PAGE });
  });

  it("the same id under object_story_id and effective_object_story_id resolves", async () => {
    const entries = storyEntries(await build(attach, withStory({ object_story_id: STORY, effective_object_story_id: STORY })));
    expect(entries).toHaveLength(1);
    expect(entries[0].owner_page).toBe(PAGE);
  });

  it("a stored object_story_id that differs from the effective id stays unresolved", async () => {
    const other = `${PAGE}_9998000000000099`;
    const entries = storyEntries(
      await build(attach, { ...withStory({ object_story_id: other, effective_object_story_id: STORY }), [`/${other}`]: metaError(10) }),
    );
    expect(entries.find((e) => e.id === other)?.owner_page).toBeNull();
    expect(entries.find((e) => e.id === STORY)?.owner_page).toBe(PAGE);
  });

  it("a readable from{id} still decides, over the prefix", async () => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, { from: { id: FOREIGN_PAGE } })));
    expect(e.owner_page).toBe(FOREIGN_PAGE);
  });

  it("a 200 from from{id} with no from stays unresolved, with no prefix fallback", async () => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, {})));
    expect(e.owner_page).toBeNull();
  });

  it("a 200 carrying from with no id stays unresolved, with no prefix fallback", async () => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, { from: {} })));
    expect(e.owner_page).toBeNull();
  });

  it.each([
    ["code 100", metaError(100)],
    ["code 190", metaError(190)],
    ["a network error", new Error("Insufficient permissions for this operation.")],
  ])("%s on from{id} stays unresolved", async (_name, answer) => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, answer)));
    expect(e.owner_page).toBeNull();
  });

  it("a typed object_story_id with the brand's prefix stays unresolved, top-level", async () => {
    const d = await build(post(`/${ACT}/adcreatives`, { name: "n", object_story_id: STORY }), withStory({}));
    expect(storyEntries(d)).toEqual([{ field: "object_story_id", via: "direct", id: STORY, owner_page: null, owner_ig: null }]);
  });

  it("and in an inline creative", async () => {
    const d = await build(post(`/${ACT}/ads`, { name: "n", adset_id: ADSET, creative: { object_story_id: STORY } }), withStory({}));
    expect(storyEntries(d)).toEqual([{ field: "object_story_id", via: "creative", id: STORY, owner_page: null, owner_ig: null }]);
  });

  it("a typed id beside a creative with the same effective id stays unresolved", async () => {
    const d = await build(
      post(`/${ACT}/ads`, { name: "n", adset_id: ADSET, object_story_id: STORY, creative: { creative_id: CREATIVE } }),
      withStory({ effective_object_story_id: STORY }),
    );
    expect(storyEntries(d).find((e) => e.via === "direct")?.owner_page).toBeNull();
    expect(storyEntries(d).find((e) => e.via === "creative_id")?.owner_page).toBe(PAGE);
  });

  it.each(["1_2_3", "_2", "1_", "123456", `${STORY}\n`, `a${STORY}`])("effective id %j resolves to no Page", async (id) => {
    const d = await build(attach, baseWorld({ [`/${CREATIVE}`]: { lenient: true, account_id: ACT_DIGITS, effective_object_story_id: id }, [`/${id}`]: metaError(10) }));
    for (const e of storyEntries(d)) expect(e.owner_page).toBeNull();
  });

  it("a post on another Page carries that Page, for rule 1 to refuse", async () => {
    const d = await build(attach, baseWorld({
      [`/${CREATIVE}`]: { lenient: true, account_id: ACT_DIGITS, effective_object_story_id: FOREIGN_STORY },
      [`/${FOREIGN_STORY}`]: metaError(10),
    }));
    expect(storyEntries(d)[0].owner_page).toBe(FOREIGN_PAGE);
  });
});
