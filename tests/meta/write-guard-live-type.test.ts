// Ticket 382: an object's type and a post's Page, from what Graph v27 really answers. The fake below answers as the
// live probes did: no metadata.type, code 100 for a field the kind lacks, 200 without the field on a creative, and
// code 10 for a post's owner.
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";

import { MetaApiClient } from "../../src/meta/client.js";
import { classifyMetaError } from "../../src/meta/errors.js";
import { buildDescriptor, validateDescriptor, type Descriptor, type GraphGet, type WriteRequest } from "../../src/meta/write-descriptor.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

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
const CODE_10_WORDING = "MCP error -32600: Insufficient permissions for this operation. (Meta: ";

// A 200 whose body is not an object.
class Raw {
  constructor(readonly value: unknown) {}
}
type Node = Record<string, unknown> & { lenient?: boolean; failing?: Record<string, Error | Raw> };
type Answer = Node | Error | Raw;

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
    if (answer instanceof Raw) return answer.value as T;
    const names = String(params.fields ?? "").replace(/\{[^}]*\}/g, "").split(",").filter(Boolean);
    const lost = names.length === 1 ? answer.failing?.[names[0]] : undefined;
    if (lost instanceof Error) throw lost;
    if (lost instanceof Raw) return lost.value as T;
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
    ["a creative holding both story fields is one kind", { lenient: true, object_story_spec: { page_id: PAGE }, effective_object_story_id: STORY }, "creative"],
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

  it("a probe answering 200 with no usable value is neither a match nor a clean miss", async () => {
    for (const value of [null, "", {}, [], ["x"], false, true]) expect(await typeOf({ ...CAMPAIGN, fan_count: value })).toBe("other");
  });

  it("a refused read or a network error is other", async () => {
    expect(await typeOf(metaError(10))).toBe("other");
    expect(await typeOf(new Error("socket hang up"))).toBe("other");
  });

  it("a creative's 200 with the field absent is no match", async () => {
    expect(await typeOf({ lenient: true, account_id: ACT_DIGITS })).toBe("other");
  });

  it.each([
    ["campaign and ad set", { ...CAMPAIGN, optimization_goal: "Y" }],
    ["ad and creative", { ...AD_NODE, object_story_spec: { page_id: PAGE } }],
    ["campaign and a Page", { ...CAMPAIGN, fan_count: 3 }],
  ])("two kinds matching is other: %s", async (_name, node) => {
    expect(await typeOf(node)).toBe("other");
  });

  it("a campaign answering fan_count 0 is other", async () => {
    expect(await typeOf({ ...CAMPAIGN, fan_count: 0 })).toBe("other");
  });
});

describe("every probe must answer (382 final 1, GB4)", () => {
  const failures: Array<[string, Error]> = [
    ["a network error", new Error("socket hang up")],
    ["a rate limit", classifyMetaError({ message: "limit", type: "OAuthException", code: 4 }).mcpError],
    ["code 10", metaError(10)],
    ["object not found (code 100, subcode 33)", classifyMetaError({ message: "gone", type: "OAuthException", code: 100, error_subcode: 33 }).mcpError],
    ["a plain Error with code 100's wording", new Error("MCP error -32602: Invalid parameter: x")],
    ["another code quoting code 100's wording", classifyMetaError({ message: "MCP error -32602: Invalid parameter: x", type: "", code: 190 }).mcpError],
  ];
  const nodes: Array<[string, Node, string]> = [
    ["campaign", CAMPAIGN, "optimization_goal"],
    ["ad set", ADSET_NODE, "adset_id"],
    ["ad", AD_NODE, "fan_count"],
    ["creative", CREATIVE_NODE, "adset_id"],
  ];
  const cases = nodes.flatMap(([kind, node, field]) => failures.map(([why, err]) => [kind, why, node, field, err] as const));

  it.each(cases)("a %s with %s on another kind's probe is other", async (_kind, _why, node, field, err) => {
    expect(await typeOf({ ...node, failing: { [field]: err } })).toBe("other");
  });

  it("a creative whose probe answers 200 with a body that is no object is other", async () => {
    expect(await typeOf({ ...CREATIVE_NODE, failing: { adset_id: new Raw(null) } })).toBe("other");
  });

  it("a creative holding a story field with no usable value is other", async () => {
    expect(await typeOf({ ...CREATIVE_NODE, effective_object_story_id: null })).toBe("other");
  });

  it.each([
    ["campaign", { ...CAMPAIGN, objective: 7 }],
    ["ad set", { ...ADSET_NODE, optimization_goal: 7 }],
    ["ad", { ...AD_NODE, adset_id: 7 }],
    ["creative", { ...CREATIVE_NODE, effective_object_story_id: 7 }],
  ])("a %s whose type field answers a number is other", async (_kind, node) => {
    expect(await typeOf(node)).toBe("other");
  });

  it.each([
    ["campaign", CAMPAIGN],
    ["ad set", ADSET_NODE],
    ["ad", AD_NODE],
  ])("a %s that answers 200 without another kind's field is other", async (_kind, node) => {
    expect(await typeOf({ ...node, lenient: true })).toBe("other");
  });

  it("a node of no probed kind that answers 200 without the fields is other, whatever metadata says", async () => {
    expect(await typeOf({ lenient: true, metadata: { type: "customaudience" } })).toBe("other");
  });
});

describe("a campaign, ad set or ad must show its own account (382 final 1, GA1)", () => {
  const lookAlikes: Array<[string, Node]> = [
    ["campaign", { objective: "X" }],
    ["adset", { optimization_goal: "Y", campaign_id: CAMP }],
    ["ad", { adset_id: ADSET, campaign_id: CAMP }],
  ];
  const malformed = ["abc", `${ACT_DIGITS} `, ` ${ACT_DIGITS}`, "act_x"];
  const accounts: Array<[string, Node]> = [
    ["absent", {}],
    ["null", { account_id: null }],
    ["empty", { account_id: "" }],
    ["a safe-integer number", { account_id: 123456789 }],
    ...malformed.map((s): [string, Node] => [`the malformed string ${JSON.stringify(s)}`, { account_id: s }]),
  ];
  const cases = lookAlikes.flatMap(([kind, node]) => accounts.map(([name, account]) => [kind, name, { ...node, ...account }] as const));

  it.each(cases)("a %s look-alike with its account %s is other", async (_kind, _name, node) => {
    expect(await typeOf(node)).toBe("other");
  });

  it.each(lookAlikes.flatMap(([kind, node]) => malformed.map((s) => [kind, s, { ...node, account_id: s }] as const)))(
    "a %s look-alike with the account %j takes none from its parent campaign",
    async (_kind, _account, node) => {
      const d = await build(post(`/${NODE}`), baseWorld({ [`/${NODE}`]: node }));
      expect(d.ad_account).toBeNull();
      expect(d.campaigns).toEqual([]);
    },
  );

  it.each(lookAlikes)("a %s look-alike takes no account from its parent campaign", async (_kind, node) => {
    const d = await build(post(`/${NODE}`), baseWorld({ [`/${NODE}`]: node }));
    expect(d.ad_account).toBeNull();
    expect(d.campaigns).toEqual([]);
  });

  it("a failed own-fields read is other", async () => {
    const calls: string[] = [];
    const get = liveGet(baseWorld(), calls);
    const lossy: GraphGet = async <T>(path: string, params: Record<string, string | number>): Promise<T> => {
      if (path === `/${CAMP}` && String(params.fields).includes("account_id")) throw new Error("socket hang up");
      return get<T>(path, params);
    };
    const d = await buildDescriptor(post(`/${CAMP}`), { tool: "ads_test_tool", validateOnly: false, requestId: "req-1", accounts: new Set([ACT]) }, lossy);
    expect(d.object.type).toBe("other");
  });
});

describe("what decides the path's type (382 final 1, GA2)", () => {
  it("a node that is no Graph id is other, with no read", async () => {
    const calls: string[] = [];
    const d = await build(post("/not_a_graph_id"), baseWorld({ "/not_a_graph_id": CAMPAIGN }), "ads_test_tool", calls);
    expect(d.object.type).toBe("other");
    expect(calls.filter((c) => c.startsWith("/not_a_graph_id?"))).toEqual([]);
  });

  it("an act_<digits> edge is account, with no type read", async () => {
    const calls: string[] = [];
    const d = await build(post(`/${ACT}/not_an_edge`), baseWorld({ [`/${ACT}`]: { ...CAMPAIGN, spend_cap: "500000" } }), "ads_test_tool", calls);
    expect(d.object.type).toBe("account");
    expect(calls.filter((c) => c === `/${ACT}?objective`)).toEqual([]);
  });

  it("a version prefix is not the node", async () => {
    expect((await build(post(`/v27.0/${CAMP}`), baseWorld())).object).toEqual({ type: "campaign", id: CAMP, created: false });
  });

  it("two kinds do not fall through to metadata", async () => {
    expect(await typeOf({ objective: "X", optimization_goal: "Y", metadata: { type: "adstudy" } })).toBe("other");
  });

  it("a Page does not fall through to metadata", async () => {
    expect(await typeOf({ fan_count: 12, metadata: { type: "adstudy" } })).toBe("other");
    expect(await typeOf({ fan_count: "12", metadata: { type: "adstudy" } })).toBe("other");
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

  it.each(kinds)("the %s tool refuses a node whose detection failed closed", async (_type, _id, tool) => {
    await expect(build(post(`/${NODE}`), baseWorld({ [`/${NODE}`]: new Error("down") }), tool)).rejects.toThrow(`${NODE} is a other`);
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
    ["another code whose Meta text quotes code 10's wording", classifyMetaError({ message: `${CODE_10_WORDING}x)`, type: "", code: 100 }).mcpError],
    ["a plain Error with code 10's whole wording", new Error(`${CODE_10_WORDING}x)`)],
  ])("%s on from{id} stays unresolved", async (_name, answer) => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, answer)));
    expect(e.owner_page).toBeNull();
  });

  it("code 10 as the real client rethrows it still takes the Page from the prefix", async () => {
    setupTestToken();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ error: { code: 10, type: "OAuthException", message: "refused" } }, { status: 400 })));
    try {
      const thrown = await new MetaApiClient({ maxRetries: 0 }).get(`/${STORY}`, { fields: "from{id}" }).catch((err: unknown) => err);
      expect(thrown).toBeInstanceOf(McpError);
      const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, thrown as Error)));
      expect(e.owner_page).toBe(PAGE);
    } finally {
      vi.unstubAllGlobals();
      cleanupTestToken();
    }
  });

  it.each([
    ["another account", { account_id: "9990000000000002" }],
    ["no account", { account_id: undefined }],
    ["a null account", { account_id: null }],
    ["a numeric account", { account_id: 9990000000000001 }],
    ["an account read that fails", { failing: { account_id: new Error("socket hang up") } }],
  ])("a creative with %s takes no Page from the prefix", async (_name, account) => {
    for (const req of [attach, copy]) {
      const [e] = storyEntries(await build(req, withStory({ effective_object_story_id: STORY, ...account })));
      expect(e.owner_page).toBeNull();
    }
  });

  it("the creative's account must be a string, even when its digits equal the write's account", async () => {
    const SMALL = "act_123456789";
    const smallAttach = post(`/${SMALL}/ads`, { name: "n", adset_id: ADSET, creative: { creative_id: CREATIVE } });
    const world = (account_id: unknown) => ({
      ...withStory({ effective_object_story_id: STORY, account_id }),
      [`/${SMALL}`]: { spend_cap: "500000", amount_spent: "0", currency: "USD" },
    });
    expect(storyEntries(await build(smallAttach, world("123456789")))[0].owner_page).toBe(PAGE);
    expect(storyEntries(await build(smallAttach, world(123456789)))[0].owner_page).toBeNull();
  });

  it("a write with no account takes no Page from the prefix, whatever string the creative's account is", async () => {
    const req = post(`/${NODE}`, { creative: { creative_id: CREATIVE } });
    const d = await build(req, withStory({ effective_object_story_id: STORY, account_id: "x" }));
    expect(d.ad_account).toBeNull();
    expect(storyEntries(d)[0]).toMatchObject({ id: STORY, owner_page: null });
  });

  it("a stored object_story_id with no effective id takes no Page from the prefix", async () => {
    const [e] = storyEntries(await build(attach, withStory({ object_story_id: STORY })));
    expect(e).toMatchObject({ id: STORY, owner_page: null });
  });

  it.each([[null], [false], [[]], ["x"]])("a from{id} read answering the non-object %j stays unresolved", async (body) => {
    const [e] = storyEntries(await build(attach, withStory({ effective_object_story_id: STORY }, new Raw(body))));
    expect(e.owner_page).toBeNull();
  });

  it("the reported id under another identity field takes no Page from its prefix", async () => {
    const d = await build(attach, withStory({ effective_object_story_id: STORY, object_story_spec: { page_id: STORY } }));
    const entry = d.identity.find((e) => e.field === "object_story_spec.page_id");
    expect(entry).toMatchObject({ id: STORY, owner_page: null });
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
