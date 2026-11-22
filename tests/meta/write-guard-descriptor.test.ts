// buildDescriptor (ticket 253, Task 4): the descriptor of contract docs/contracts/meta-ads-guard.md@1.1 §3 built
// from a write's request and the fork's GETs. Every vendored fixture with a descriptor that 253 drives is rebuilt
// from its scenario (tests/fixtures/meta-ads-guard/harness.ts) and must `normalise` equal; then one case per rule.
import { describe, expect, it } from "vitest";

import { withLiveTypes } from "./live-type-graph.js";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixtures, normalise } from "../fixtures/meta-ads-guard/fake-guard.mjs";
import { SKIPPED, accountsOf, answerGet, scenarioFor, type Scenario } from "../fixtures/meta-ads-guard/harness.js";
import {
  CREATIVE_READ_FIELDS,
  buildDescriptor,
  validateDescriptor,
  type Descriptor,
  type GraphGet,
  type WriteRequest,
} from "../../src/meta/write-descriptor.js";

const DIR = fileURLToPath(new URL("../fixtures/meta-ads-guard", import.meta.url));
const FIXTURES = loadFixtures(join(DIR, "fixtures"));

interface Call {
  path: string;
  params: Record<string, string | number>;
}
type World = Record<string, unknown>;

function fakeGet(gets: ReadonlyMap<string, unknown>, calls: Call[]): GraphGet {
  return withLiveTypes(async <T>(path: string, params: Record<string, string | number>): Promise<T> => {
    calls.push({ path, params });
    return answerGet(gets, path, params) as T;
  });
}

interface BuildOpts {
  tool?: string;
  accounts?: ReadonlySet<string>;
}

async function build(req: WriteRequest, world: World | Map<string, unknown>, opts: BuildOpts = {}) {
  const calls: Call[] = [];
  const gets = world instanceof Map ? world : new Map(Object.entries(world));
  const d = await buildDescriptor(
    req,
    { tool: opts.tool ?? "ads_test_tool", validateOnly: false, requestId: "req-1", accounts: opts.accounts ?? new Set() },
    fakeGet(gets, calls),
  );
  // Every result passes the contract's field tables.
  expect(validateDescriptor(d)).toEqual([]);
  return { d, calls };
}

const refused = (detail: string): string => `MCP error -32600: write refused: ${detail}`;
const post = (path: string, params: Record<string, unknown> = {}): WriteRequest => ({ method: "POST", path, params });

// A small world: one account, campaign, ad set, ad, creative and Page, all in act_9990000000000001.
const ACT = "act_9990000000000001";
const ACT_DIGITS = "9990000000000001";
const CAMP = "9994000000000001";
const CAMP2 = "9994000000000002";
const ADSET = "9995000000000001";
const ADSET2 = "9995000000000002";
const AD = "9996000000000001";
const CREATIVE = "9997000000000001";
const PAGE = "9991000000000001";
const PAGE2 = "9991000000000002";
const IG = "9992000000000002";
const STUDY = "9999000000000174";
const BUSINESS = "9999000000000001";

function world(extra: World = {}): World {
  return {
    [`/${ACT}`]: { spend_cap: "500000", amount_spent: "1200", currency: "USD" },
    [`/${CAMP}`]: {
      metadata: { type: "campaign" },
      account_id: ACT_DIGITS,
      status: "PAUSED",
      effective_status: "PAUSED",
      name: "sb-usb-h1",
      spend_cap: "100000",
      buying_type: "AUCTION",
    },
    [`/${CAMP2}`]: {
      metadata: { type: "campaign" },
      account_id: ACT_DIGITS,
      status: "ACTIVE",
      effective_status: "ACTIVE",
      name: "sb-usb-h2",
      spend_cap: "200000",
      buying_type: "AUCTION",
    },
    [`/${ADSET}`]: {
      metadata: { type: "adset" },
      account_id: ACT_DIGITS,
      status: "PAUSED",
      campaign_id: CAMP,
      daily_budget: "1000",
    },
    [`/${ADSET2}`]: { metadata: { type: "adset" }, account_id: ACT_DIGITS, status: "ACTIVE", campaign_id: CAMP2 },
    [`/${AD}`]: {
      metadata: { type: "ad" },
      account_id: ACT_DIGITS,
      status: "PAUSED",
      adset_id: ADSET,
      campaign_id: CAMP,
      creative: { id: CREATIVE },
    },
    [`/${CREATIVE}`]: { metadata: { type: "adcreative" }, account_id: ACT_DIGITS, object_story_spec: { page_id: PAGE } },
    [`/${PAGE}`]: { id: PAGE },
    [`/${PAGE2}`]: { id: PAGE2 },
    [`/${IG}`]: { id: IG },
    ...extra,
  };
}

const callTo = (calls: Call[], path: string): Call[] => calls.filter((c) => c.path === path);

// ---------------------------------------------------------------------------------------------------------------
describe("every vendored fixture 253 drives", () => {
  const driven = FIXTURES.filter((f) => f.descriptor && !Object.hasOwn(SKIPPED, f.name) && (f.for === "both" || f.for === "fork"));

  it("SKIPPED names exactly the fourteen, each a vendored fixture", () => {
    expect(Object.keys(SKIPPED)).toHaveLength(14);
    const names = new Set(FIXTURES.map((f) => f.name));
    for (const name of Object.keys(SKIPPED)) expect(names.has(name)).toBe(true);
    // + outcome-record, + the three `for: "client"` fixtures (tests/must-fix/client-fixtures.test.ts).
    expect(driven.length + Object.keys(SKIPPED).length + 1 + 3).toBe(FIXTURES.length);
  });

  it.each(driven.map((f) => [f.name, f] as const))("%s: the descriptor built from its scenario is the fixture's", async (_name, f) => {
    const s = scenarioFor(f);
    const { d } = await build(s, s.gets, {
      tool: (f.descriptor as { tool: string }).tool,
      accounts: accountsOf(s),
    });
    expect(JSON.parse(normalise(d))).toEqual(JSON.parse(normalise(f.descriptor)));
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 1: path and object", () => {
  it("a create row's object is the type created, with no GET of the path", async () => {
    const { d, calls } = await build(post(`/${ACT}/campaigns`, { name: "n", status: "PAUSED" }), world());
    expect(d.object).toEqual({ type: "campaign", id: null, created: true });
    expect(calls.some((c) => c.params.metadata !== undefined)).toBe(false);
    expect(d.kind).toBe("create");
  });

  it("any other row's object type comes from a GET of the node, which picks the row", async () => {
    const { d } = await build(post(`/${ADSET}`, { name: "n" }), world());
    expect(d.object).toEqual({ type: "adset", id: ADSET, created: false });
    expect(d.kind).toBe("update");
  });

  it("a copy's object is the source", async () => {
    const { d } = await build(post(`/${AD}/copies`, { adset_id: ADSET }), world());
    expect(d.object).toEqual({ type: "ad", id: AD, created: false });
    expect(d.kind).toBe("copy");
  });

  it("a failed type read is type other, and the row is matched with it", async () => {
    const { d } = await build(post(`/${ADSET}`, { name: "n" }), world({ [`/${ADSET}`]: new Error("down") }));
    expect(d.object).toEqual({ type: "other", id: ADSET, created: false });
    expect(d.kind).toBe("other");
  });

  it("a budget schedule is a create of a budget_schedule under the path's campaign", async () => {
    const { d } = await build(post(`/${CAMP}/budget_schedules`, { budget_value: 5 }), world());
    expect(d.object).toEqual({ type: "budget_schedule", id: null, created: true });
    expect(d.kind).toBe("budget-schedule");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 2: M16", () => {
  it("ads_update_ad_set on a campaign id is refused", async () => {
    await expect(build(post(`/${CAMP}`, { status: "PAUSED" }), world(), { tool: "ads_update_ad_set" })).rejects.toThrow(
      refused(`ads_update_ad_set expects a adset, ${CAMP} is a campaign`),
    );
  });

  it("ads_update_campaign on act_1 is refused before any GET", async () => {
    const calls: Call[] = [];
    const ctx = { tool: "ads_update_campaign", validateOnly: false, requestId: "r", accounts: new Set<string>() };
    const err = await buildDescriptor(post("/act_1", { name: "n" }), ctx, fakeGet(new Map(), calls)).catch((e: Error) => e);
    expect((err as Error).message).toBe(refused("ads_update_campaign expects a campaign, act_1 is a account"));
    expect(calls).toEqual([]);
  });

  it("an account node on a tool outside ACCOUNT_TOOLS with no expected type is refused too", async () => {
    await expect(build(post(`/${ACT}`, { status: "ACTIVE" }), world(), { tool: "ads_activate_entity" })).rejects.toThrow(
      refused(`ads_activate_entity expects a non-account object, ${ACT} is a account`),
    );
  });

  it("an account tool may write the account node", async () => {
    const { d } = await build(
      post(`/${ACT}`, { spend_cap: "100" }),
      world({ [`/${ACT}`]: { metadata: { type: "adaccount" }, spend_cap: "500000", amount_spent: "0", currency: "USD" } }),
      { tool: "ads_update_spend_cap" },
    );
    expect(d.object).toEqual({ type: "account", id: ACT, created: false });
    expect(d.account_limit).toBe(true);
  });

  it("an account edge is not the node: an ad set create on act_ is not M16's", async () => {
    const { d } = await build(post(`/${ACT}/adsets`, { campaign_id: CAMP }), world(), { tool: "ads_create_ad_set" });
    expect(d.object.type).toBe("adset");
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 3: object fields, one GET per type", () => {
  const cases: Array<[string, string, World, string]> = [
    [
      "campaign",
      CAMP,
      {},
      "account_id,status,effective_status,name,spend_cap,buying_type,daily_budget,lifetime_budget,stop_time",
    ],
    ["adset", ADSET, {}, "account_id,status,campaign_id,daily_budget,lifetime_budget,end_time"],
    ["ad", AD, {}, "account_id,status,adset_id,campaign_id,creative{id}"],
    ["creative", CREATIVE, {}, "account_id"],
    ["study", STUDY, { [`/${STUDY}`]: { metadata: { type: "adstudy" }, business: { id: BUSINESS } } }, "business{id}"],
  ];
  it.each(cases)("%s", async (_type, id, extra, fields) => {
    const { calls } = await build(post(`/${id}`, { name: "n" }), world(extra));
    expect(callTo(calls, `/${id}`).map((c) => c.params.fields)).toContain(fields);
  });

  it("a Page post, an account or an unknown type reads no fields beyond its type reads", async () => {
    const post_ = `${PAGE}_9998000000000086`;
    const { calls } = await build(post(`/${post_}`, { message: "m" }), world({ [`/${post_}`]: { metadata: { type: "post" } } }));
    expect(callTo(calls, `/${post_}`)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 4: status", () => {
  it("before is the object's status; after is the status param", async () => {
    const { d } = await build(post(`/${ADSET}`, { status: "ACTIVE" }), world());
    expect(d.status).toEqual({ before: "PAUSED", after: "ACTIVE" });
  });

  it("without a status param, after is before", async () => {
    const { d } = await build(post(`/${ADSET}`, { name: "n" }), world());
    expect(d.status).toEqual({ before: "PAUSED", after: "PAUSED" });
  });

  it("status_option ACTIVE or PAUSED sets after; INHERITED_FROM_SOURCE keeps before", async () => {
    expect((await build(post(`/${AD}/copies`, { status_option: "ACTIVE" }), world())).d.status).toEqual({
      before: "PAUSED",
      after: "ACTIVE",
    });
    expect((await build(post(`/${ADSET2}/copies`, { status_option: "INHERITED_FROM_SOURCE" }), world({ [`/${ADSET2}/ads`]: { data: [] } }))).d.status).toEqual({
      before: "ACTIVE",
      after: "ACTIVE",
    });
  });

  it("a create is before null, and after null when it sends no status", async () => {
    const { d } = await build(post(`/${ACT}/ads`, { adset_id: ADSET, name: "n" }), world());
    expect(d.status).toEqual({ before: null, after: null });
  });

  it("an unreadable object is before null", async () => {
    const { d } = await build(post(`/${ADSET}`, { status: "PAUSED" }), world({ [`/${ADSET}`]: { metadata: { type: "adset" } } }));
    expect(d.status).toEqual({ before: null, after: "PAUSED" });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 5: budget", () => {
  const adsetWith = (b: World) => world({ [`/${ADSET}`]: { metadata: { type: "adset" }, account_id: ACT_DIGITS, status: "PAUSED", campaign_id: CAMP, ...b } });

  it("before is whichever budget reads above zero; after is the param sent", async () => {
    const { d } = await build(post(`/${ADSET}`, { daily_budget: 2500 }), adsetWith({ daily_budget: "0", lifetime_budget: "50000" }));
    expect(d.budget).toEqual({
      currency: "USD",
      kind_before: "lifetime",
      kind_after: "daily",
      before_minor: 50000,
      after_minor: 2500,
      end_time: null,
    });
  });

  it("neither above zero: the one field returned; both or neither: null", async () => {
    expect((await build(post(`/${ADSET}`, { name: "n" }), adsetWith({ daily_budget: "0" }))).d.budget).toMatchObject({
      kind_before: "daily",
      before_minor: 0,
      kind_after: "daily",
      after_minor: 0,
    });
    expect((await build(post(`/${ADSET}`, { name: "n" }), adsetWith({ daily_budget: "0", lifetime_budget: "0" }))).d.budget).toMatchObject({
      kind_before: null,
      before_minor: null,
    });
    expect((await build(post(`/${ADSET}`, { name: "n" }), adsetWith({}))).d.budget).toMatchObject({ kind_before: null, kind_after: null });
  });

  // lifetime_budget sent alone (final review R1): served tools send it so (ads_update_campaign, ads_update_ad_set,
  // ads_create_campaign, ads_create_ad_set), and the guard decides a raise or a cut from it.
  describe("lifetime_budget sent alone", () => {
    const campWith = (b: World) =>
      world({ [`/${CAMP}`]: { metadata: { type: "campaign" }, account_id: ACT_DIGITS, status: "PAUSED", effective_status: "PAUSED", name: "c", buying_type: "AUCTION", ...b } });

    it.each([
      ["campaign", () => campWith({ lifetime_budget: "50000" }), CAMP],
      ["ad set", () => adsetWith({ lifetime_budget: "50000" }), ADSET],
    ] as const)("an update that raises the lifetime budget (%s)", async (_kind, w, id) => {
      const { d } = await build(post(`/${id}`, { lifetime_budget: 80000 }), w());
      expect(d.budget).toMatchObject({ kind_before: "lifetime", before_minor: 50000, kind_after: "lifetime", after_minor: 80000 });
    });

    it.each([
      ["campaign", () => campWith({ lifetime_budget: "50000" }), CAMP],
      ["ad set", () => adsetWith({ lifetime_budget: "50000" }), ADSET],
    ] as const)("an update that cuts the lifetime budget (%s)", async (_kind, w, id) => {
      const { d } = await build(post(`/${id}`, { lifetime_budget: 20000 }), w());
      expect(d.budget).toMatchObject({ kind_before: "lifetime", before_minor: 50000, kind_after: "lifetime", after_minor: 20000 });
    });

    it("an update that moves a daily ad set to a lifetime budget", async () => {
      const { d } = await build(post(`/${ADSET}`, { lifetime_budget: 70000 }), adsetWith({ daily_budget: "1000" }));
      expect(d.budget).toMatchObject({ kind_before: "daily", before_minor: 1000, kind_after: "lifetime", after_minor: 70000 });
    });

    it.each([
      ["campaign", post(`/${ACT}/campaigns`, { name: "n", status: "PAUSED", lifetime_budget: 30000 })],
      ["ad set", post(`/${ACT}/adsets`, { campaign_id: CAMP, name: "n", status: "PAUSED", lifetime_budget: 30000 })],
    ] as const)("a create (%s)", async (_kind, req) => {
      const { d } = await build(req, world());
      expect(d.object.created).toBe(true);
      expect(d.budget).toMatchObject({ kind_before: null, before_minor: null, kind_after: "lifetime", after_minor: 30000 });
    });
  });

  it("both budgets sent: kind_after and after_minor null", async () => {
    const { d } = await build(post(`/${ADSET}`, { daily_budget: 100, lifetime_budget: 5000 }), adsetWith({ daily_budget: "1000" }));
    expect(d.budget).toMatchObject({ kind_before: "daily", before_minor: 1000, kind_after: null, after_minor: null });
  });

  it("amounts go through minorAmount", async () => {
    const { d } = await build(post(`/${ADSET}`, { daily_budget: "12.50" }), adsetWith({ daily_budget: "1000" }));
    expect(d.budget).toMatchObject({ kind_before: "daily", before_minor: 1000, kind_after: "daily", after_minor: null });
  });

  it("end_time is the end_time or stop_time param on a campaign or ad set", async () => {
    expect((await build(post(`/${CAMP}`, { stop_time: "2026-12-31" }), world())).d.budget.end_time).toBe("2026-12-31");
    expect((await build(post(`/${ADSET}`, { end_time: "2027-01-01" }), world())).d.budget.end_time).toBe("2027-01-01");
  });

  it("every other type's amounts, kinds and end_time are null; currency still comes from the account", async () => {
    const { d } = await build(post(`/${AD}`, { daily_budget: 100, end_time: "2027-01-01" }), world());
    expect(d.budget).toEqual({ currency: "USD", kind_before: null, kind_after: null, before_minor: null, after_minor: null, end_time: null });
  });

  it("a currency that is not three capitals is null", async () => {
    const { d } = await build(post(`/${ADSET}`, { name: "n" }), world({ [`/${ACT}`]: { currency: "usd" } }));
    expect(d.budget.currency).toBeNull();
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 6: ad_account", () => {
  it("the path's act_ first", async () => {
    const { d } = await build(post(`/${ACT}/adsets`, { campaign_id: CAMP }), world());
    expect(d.ad_account).toBe(ACT);
  });

  it("else the object's account_id, normalised", async () => {
    const { d } = await build(post(`/${ADSET}`, { name: "n" }), world());
    expect(d.ad_account).toBe(ACT);
  });

  it("a study: the first cell's campaign's account, in body order", async () => {
    const other = "9994000000000009";
    const { d } = await build(
      post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [other] }, { campaigns: [CAMP] }] }),
      world({ [`/${other}`]: { account_id: "9990000000000009" } }),
    );
    expect(d.ad_account).toBe("act_9990000000000009");
  });

  it("a Page post: the one account the session read, else null", async () => {
    const postId = `${PAGE}_9998000000000086`;
    const w = world({ [`/${postId}`]: { metadata: { type: "post" } } });
    expect((await build(post(`/${postId}`, { message: "m" }), w, { accounts: new Set([ACT]) })).d.ad_account).toBe(ACT);
    expect((await build(post(`/${postId}`, { message: "m" }), w, { accounts: new Set([ACT, "act_2"]) })).d.ad_account).toBeNull();
  });

  it("a budget schedule: its campaign's account", async () => {
    const { d } = await build(post(`/${CAMP}/budget_schedules`, { budget_value: 5 }), world());
    expect(d.ad_account).toBe(ACT);
  });

  it("an object with no account and no campaign: null, and no account GET", async () => {
    const { d, calls } = await build(post(`/${CREATIVE}`, { name: "n" }), world({ [`/${CREATIVE}`]: { metadata: { type: "adcreative" } } }));
    expect(d.ad_account).toBeNull();
    expect(d.account).toEqual({ spend_cap_minor: null, amount_spent_minor: null });
    expect(calls.some((c) => c.params.fields === "spend_cap,amount_spent,currency")).toBe(false);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 7: account", () => {
  it("one GET of spend_cap,amount_spent,currency, amounts through minorAmount", async () => {
    const { d, calls } = await build(post(`/${ADSET}`, { name: "n" }), world({ [`/${ACT}`]: { spend_cap: "5.5", amount_spent: "1200", currency: "USD" } }));
    expect(callTo(calls, `/${ACT}`).map((c) => c.params)).toEqual([{ fields: "spend_cap,amount_spent,currency" }]);
    expect(d.account).toEqual({ spend_cap_minor: null, amount_spent_minor: 1200 });
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 8: campaigns", () => {
  const entry = (over: Partial<Descriptor["campaigns"][number]>) => ({
    id: CAMP,
    account_id: ACT,
    created: false,
    role: "parent",
    spend_cap_minor_before: 100000,
    spend_cap_minor_after: 100000,
    name: "sb-usb-h1",
    status_after: "PAUSED",
    buying_type: "AUCTION",
    ...over,
  });

  it("each existing campaign: one GET of its five fields", async () => {
    const { d, calls } = await build(post(`/${ADSET}`, { name: "n" }), world());
    expect(callTo(calls, `/${CAMP}`).map((c) => c.params.fields)).toEqual(["account_id,name,spend_cap,effective_status,buying_type"]);
    expect(d.campaigns).toEqual([entry({})]);
  });

  it("self on a campaign create, from the params", async () => {
    const { d } = await build(post(`/${ACT}/campaigns`, { status: "PAUSED", spend_cap: 150000, buying_type: "AUCTION" }), world());
    expect(d.campaigns).toEqual([
      entry({ id: null, created: true, role: "self", spend_cap_minor_before: null, spend_cap_minor_after: 150000, name: null, buying_type: "AUCTION" }),
    ]);
  });

  it("a fractional spend_cap on a campaign create is null", async () => {
    const { d } = await build(post(`/${ACT}/campaigns`, { spend_cap: "100.5" }), world());
    expect(d.campaigns[0]).toMatchObject({ spend_cap_minor_after: null, status_after: null, buying_type: null });
  });

  it("self on a campaign update: spend_cap and status sent set the after values", async () => {
    const { d } = await build(post(`/${CAMP}`, { spend_cap: 150000 }), world());
    expect(d.campaigns).toEqual([entry({ role: "self", spend_cap_minor_after: 150000 })]);
    const s = await build(post(`/${CAMP}`, { status: "ACTIVE" }), world());
    expect(s.d.campaigns).toEqual([entry({ role: "self", status_after: "ACTIVE" })]);
  });

  it("remove_spend_cap (922337203685478) is spend_cap_minor_after null", async () => {
    const { d } = await build(post(`/${CAMP}`, { spend_cap: "922337203685478" }), world());
    expect(d.campaigns[0].spend_cap_minor_after).toBeNull();
  });

  it("parent on an ad create: GET the ad set's campaign_id", async () => {
    const { d, calls } = await build(post(`/${ACT}/ads`, { adset_id: ADSET2, status: "PAUSED" }), world());
    expect(callTo(calls, `/${ADSET2}`).map((c) => c.params)).toEqual([{ fields: "campaign_id" }]);
    expect(d.campaigns.map((c) => [c.id, c.role])).toEqual([[CAMP2, "parent"]]);
  });

  it("parent on an ad set create: params.campaign_id; on an ad update: the ad's campaign_id", async () => {
    expect((await build(post(`/${ACT}/adsets`, { campaign_id: CAMP2 }), world())).d.campaigns.map((c) => c.id)).toEqual([CAMP2]);
    expect((await build(post(`/${AD}`, { name: "n" }), world())).d.campaigns.map((c) => c.id)).toEqual([CAMP]);
  });

  it("destination: params.campaign_id, else adset_id's campaign, else the source's own", async () => {
    const empty = { [`/${ADSET}/ads`]: { data: [] } };
    const role = (d: Descriptor) => d.campaigns.map((c) => [c.id, c.role]);
    expect(role((await build(post(`/${ADSET}/copies`, { campaign_id: CAMP2 }), world(empty))).d)).toEqual([[CAMP2, "destination"]]);
    expect(role((await build(post(`/${AD}/copies`, { adset_id: ADSET2 }), world())).d)).toEqual([[CAMP2, "destination"]]);
    expect(role((await build(post(`/${AD}/copies`, {}), world())).d)).toEqual([[CAMP, "destination"]]);
  });

  it("a campaign copy's destination is the campaign it creates", async () => {
    const { d } = await build(post(`/${CAMP}/copies`, { status_option: "PAUSED" }), world({ [`/${CAMP}/ads`]: { data: [] } }));
    expect(d.campaigns).toEqual([
      entry({ id: null, created: true, role: "destination", spend_cap_minor_before: null, spend_cap_minor_after: null, name: null, buying_type: null }),
    ]);
  });

  it("study-cell on a create: each cell's campaigns, and each cell's ad sets' campaigns", async () => {
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP] }, { adsets: [ADSET2] }] }), world());
    expect(d.campaigns.map((c) => [c.id, c.role])).toEqual([
      [CAMP, "study-cell"],
      [CAMP2, "study-cell"],
    ]);
  });

  it("study-cell on an edit or cancel: GET /{study}/cells, paged", async () => {
    const w = world({
      [`/${STUDY}`]: { metadata: { type: "adstudy" }, business: { id: BUSINESS } },
      [`/${STUDY}/cells`]: { data: [{ campaigns: { data: [{ id: CAMP }] } }], paging: { next: "n", cursors: { after: "c1" } } },
      [`/${STUDY}/cells?after=c1`]: { data: [{ adsets: { data: [{ campaign_id: CAMP2 }] } }] },
    });
    const { d, calls } = await build({ method: "DELETE", path: `/${STUDY}`, params: {} }, w);
    expect(callTo(calls, `/${STUDY}/cells`)[0].params).toEqual({ fields: "campaigns{id},adsets{campaign_id}", limit: 100 });
    expect(d.campaigns.map((c) => c.id)).toEqual([CAMP, CAMP2]);
    expect(d.kind).toBe("delete");
    expect(d.ad_account).toBe(ACT);
  });

  it("an unreadable parent campaign id: no entry", async () => {
    const { d } = await build(post(`/${ADSET}`, { status: "ACTIVE" }), world({ [`/${ADSET}`]: { metadata: { type: "adset" }, account_id: ACT_DIGITS } }));
    expect(d.campaigns).toEqual([]);
  });

  it("a known campaign id whose GET fails: listed with the id, every other field null", async () => {
    const { d } = await build(post(`/${ADSET}`, { name: "n" }), world({ [`/${CAMP}`]: new Error("down") }));
    expect(d.campaigns).toEqual([
      entry({ account_id: null, spend_cap_minor_before: null, spend_cap_minor_after: null, name: null, status_after: null, buying_type: null }),
    ]);
  });

  it("a row of kind other still lists the object's own campaign (§3.1)", async () => {
    const { d } = await build(post(`/${CAMP}/insights`, { level: "ad" }), world());
    expect(d.kind).toBe("other");
    expect(d.campaigns.map((c) => [c.id, c.role])).toEqual([[CAMP, "self"]]);
    const a = await build(post(`/${ADSET}/adlabels`, { adlabels: "x" }), world());
    expect(a.d.campaigns.map((c) => [c.id, c.role])).toEqual([[CAMP, "parent"]]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 9: identity", () => {
  const ad = (creative: unknown) => post(`/${ACT}/ads`, { adset_id: ADSET, status: "PAUSED", creative });

  it("a Page id is the Page itself, by GET {fields:id}", async () => {
    const { d, calls } = await build(post(`/${ACT}/adcreatives`, { object_story_spec: { page_id: PAGE2 } }), world());
    expect(callTo(calls, `/${PAGE2}`)[0].params).toEqual({ fields: "id" });
    expect(d.identity).toEqual([{ field: "object_story_spec.page_id", via: "direct", id: PAGE2, owner_page: PAGE2, owner_ig: null }]);
  });

  it("a post by from{id}, Instagram media by owner{id}, a lead form by page{id}, an Instagram account itself", async () => {
    const postId = "9998000000000072";
    const media = "9998000000000008";
    const form = "9998000000000821";
    const w = world({
      [`/${postId}`]: { from: { id: PAGE } },
      [`/${media}`]: { owner: { id: IG } },
      [`/${form}`]: { page: { id: PAGE2 } },
    });
    const { d, calls } = await build(
      ad({
        object_story_id: postId,
        source_instagram_media_id: media,
        instagram_user_id: IG,
        object_story_spec: { page_id: PAGE, link_data: { call_to_action: { value: { lead_gen_form_id: form } } } },
      }),
      w,
    );
    expect(callTo(calls, `/${postId}`)[0].params).toEqual({ fields: "from{id}" });
    expect(callTo(calls, `/${media}`)[0].params).toEqual({ fields: "owner{id}" });
    expect(callTo(calls, `/${form}`)[0].params).toEqual({ fields: "page{id}" });
    expect(d.identity).toEqual(
      expect.arrayContaining([
        { field: "object_story_id", via: "creative", id: postId, owner_page: PAGE, owner_ig: null },
        { field: "source_instagram_media_id", via: "creative", id: media, owner_page: null, owner_ig: IG },
        { field: "instagram_user_id", via: "creative", id: IG, owner_page: null, owner_ig: IG },
        { field: "object_story_spec.page_id", via: "creative", id: PAGE, owner_page: PAGE, owner_ig: null },
        {
          field: "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
          via: "creative",
          id: form,
          owner_page: PAGE2,
          owner_ig: null,
        },
      ]),
    );
    expect(d.identity).toHaveLength(5);
    expect(d.kind).toBe("boost");
  });

  it("a pixel needs no GET; both owners null", async () => {
    const pixel = "9993000000000001";
    const { d, calls } = await build(post(`/${ACT}/customconversions`, { pixel_id: pixel }), world());
    expect(callTo(calls, `/${pixel}`)).toEqual([]);
    expect(d.identity).toEqual([{ field: "pixel_id", via: "direct", id: pixel, owner_page: null, owner_ig: null }]);
  });

  it("a study objective's pixel, through the objectives array", async () => {
    const pixel = "9993000000000002";
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP] }], objectives: [{ adspixels: [{ id: pixel }] }] }), world());
    expect(d.identity).toEqual([{ field: "objectives.adspixels.id", via: "direct", id: pixel, owner_page: null, owner_ig: null }]);
  });

  it("an id whose GET fails is an entry with a null owner", async () => {
    const { d } = await build(post(`/${ACT}/adcreatives`, { object_story_spec: { page_id: "9991000000000009" } }), world());
    expect(d.identity).toEqual([{ field: "object_story_spec.page_id", via: "direct", id: "9991000000000009", owner_page: null, owner_ig: null }]);
  });

  it("P2-1: an attached creative is read with exactly CREATIVE_READ_FIELDS, each identity field found an entry", async () => {
    const w = world({ [`/${CREATIVE}`]: { actor_id: PAGE, instagram_actor_id: IG, object_story_spec: { page_id: PAGE } } });
    const { d, calls } = await build(ad({ creative_id: CREATIVE }), w);
    expect(callTo(calls, `/${CREATIVE}`).map((c) => c.params)).toEqual([{ fields: CREATIVE_READ_FIELDS }]);
    expect(d.identity).toEqual(
      expect.arrayContaining([
        { field: "object_story_spec.page_id", via: "creative_id", id: PAGE, owner_page: PAGE, owner_ig: null },
        { field: "instagram_actor_id", via: "creative_id", id: IG, owner_page: null, owner_ig: IG },
      ]),
    );
    expect(d.identity).toHaveLength(2);
  });

  it("a top-level creative_id is read the same way", async () => {
    const { d } = await build(post(`/${AD}`, { creative_id: CREATIVE }), world({ [`/${CREATIVE}`]: new Error("down") }));
    expect(d.identity).toEqual([{ field: "creative_id", via: "creative_id", id: CREATIVE, owner_page: null, owner_ig: null }]);
  });

  it("a creative GET's effective_object_story_id is an object_story_id entry", async () => {
    const postId = "9998000000000007";
    const w = world({ [`/${CREATIVE}`]: { effective_object_story_id: postId }, [`/${postId}`]: { from: { id: PAGE2 } } });
    const { d } = await build(ad({ creative_id: CREATIVE }), w);
    expect(d.identity).toEqual([{ field: "object_story_id", via: "creative_id", id: postId, owner_page: PAGE2, owner_ig: null }]);
  });

  it("a failed creative GET gives the unresolved creative_id entry", async () => {
    const { d } = await build(ad({ creative_id: CREATIVE }), world({ [`/${CREATIVE}`]: new Error("down") }));
    expect(d.identity).toEqual([{ field: "creative_id", via: "creative_id", id: CREATIVE, owner_page: null, owner_ig: null }]);
  });

  it("P2: an attached creative with branded_content gives the unresolved creative_id entry too", async () => {
    const w = world({ [`/${CREATIVE}`]: { object_story_spec: { page_id: PAGE }, branded_content: { sponsor: PAGE2 } } });
    const { d } = await build(ad({ creative_id: CREATIVE }), w);
    expect(d.identity).toEqual(
      expect.arrayContaining([
        { field: "creative_id", via: "creative_id", id: CREATIVE, owner_page: null, owner_ig: null },
        { field: "object_story_spec.page_id", via: "creative_id", id: PAGE, owner_page: PAGE, owner_ig: null },
      ]),
    );
    expect(d.identity).toHaveLength(2);
  });

  it("R4: a successful creative GET whose spec holds an unadmitted path gives the unresolved entry", async () => {
    const w = world({ [`/${CREATIVE}`]: { object_story_spec: { link_data: { branded_content_sponsor_page_id: PAGE2 } } } });
    const { d } = await build(ad({ creative_id: CREATIVE }), w);
    expect(d.identity).toEqual([{ field: "creative_id", via: "creative_id", id: CREATIVE, owner_page: null, owner_ig: null }]);
  });

  it("copies: an ad source's creative{id}, read with CREATIVE_READ_FIELDS, via source_ad", async () => {
    const { d, calls } = await build(post(`/${AD}/copies`, { adset_id: ADSET }), world());
    expect(callTo(calls, `/${CREATIVE}`).map((c) => c.params)).toEqual([{ fields: CREATIVE_READ_FIELDS }]);
    expect(d.identity).toEqual([{ field: "object_story_spec.page_id", via: "source_ad", id: PAGE, owner_page: PAGE, owner_ig: null }]);
  });

  it("copies: an ad source with no readable creative{id} is the unresolved entry, with the ad's id", async () => {
    const w = world({ [`/${AD}`]: { metadata: { type: "ad" }, account_id: ACT_DIGITS, status: "PAUSED", campaign_id: CAMP } });
    const { d } = await build(post(`/${AD}/copies`, {}), w);
    expect(d.identity).toEqual([{ field: "creative_id", via: "source_ad", id: AD, owner_page: null, owner_ig: null }]);
  });

  it("copies: a listed ad with no creative{id} is the unresolved entry, with the source's id", async () => {
    const { d } = await build(post(`/${ADSET}/copies`, {}), world({ [`/${ADSET}/ads`]: { data: [{ id: AD }] } }));
    expect(d.identity).toEqual([{ field: "creative_id", via: "source_ad", id: ADSET, owner_page: null, owner_ig: null }]);
  });

  it("P2: a copy source whose creative has branded_content gives the unresolved creative_id entry", async () => {
    const w = world({ [`/${CREATIVE}`]: { branded_content: { sponsor: PAGE2 } } });
    const { d } = await build(post(`/${AD}/copies`, { adset_id: ADSET }), w);
    expect(d.identity).toEqual([{ field: "creative_id", via: "source_ad", id: CREATIVE, owner_page: null, owner_ig: null }]);
  });

  it("copies: an ad set source's ads by GET /{id}/ads {fields:creative{id}, limit:100}", async () => {
    const c2 = "9997000000000002";
    const w = world({
      [`/${ADSET}/ads`]: { data: [{ creative: { id: CREATIVE } }, { creative: { id: c2 } }] },
      [`/${c2}`]: { object_story_spec: { page_id: PAGE2 } },
    });
    const { d, calls } = await build(post(`/${ADSET}/copies`, { campaign_id: CAMP }), w);
    expect(callTo(calls, `/${ADSET}/ads`)[0].params).toEqual({ fields: "creative{id}", limit: 100 });
    expect(d.identity.map((e) => [e.field, e.via, e.id])).toEqual([
      ["object_story_spec.page_id", "source_ad", PAGE],
      ["object_story_spec.page_id", "source_ad", PAGE2],
    ]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 10: listings fail closed", () => {
  const unresolvedSource = (id: string) => ({ field: "creative_id", via: "source_ad", id, owner_page: null, owner_ig: null });
  const ads = (n: number, from = 0) => Array.from({ length: n }, (_, i) => ({ creative: { id: CREATIVE }, n: from + i }));

  describe.each([
    ["an ad set copy", ADSET, { campaign_id: CAMP }],
    ["a campaign copy", CAMP, {}],
  ])("%s", (_label, source, params) => {
    it("a failed page", async () => {
      const w = world({
        [`/${source}/ads`]: { data: ads(1), paging: { next: "n", cursors: { after: "c1" } } },
        [`/${source}/ads?after=c1`]: new Error("down"),
      });
      const { d } = await build(post(`/${source}/copies`, params), w);
      expect(d.identity).toContainEqual(unresolvedSource(source));
    });

    it("a next without a cursor", async () => {
      const w = world({ [`/${source}/ads`]: { data: ads(1), paging: { next: "n" } } });
      const { d } = await build(post(`/${source}/copies`, params), w);
      expect(d.identity).toContainEqual(unresolvedSource(source));
    });

    it("a repeated cursor", async () => {
      const w = world({
        [`/${source}/ads`]: { data: ads(1), paging: { next: "n", cursors: { after: "c1" } } },
        [`/${source}/ads?after=c1`]: { data: [], paging: { next: "n", cursors: { after: "c1" } } },
      });
      const { d, calls } = await build(post(`/${source}/copies`, params), w);
      expect(d.identity).toContainEqual(unresolvedSource(source));
      // Stopped at the repeat, not by the page cap.
      expect(callTo(calls, `/${source}/ads`)).toHaveLength(2);
    });

    it("201 ads, past the bound of 200", async () => {
      const w = world({
        [`/${source}/ads`]: { data: ads(100), paging: { next: "n", cursors: { after: "c1" } } },
        [`/${source}/ads?after=c1`]: { data: ads(100, 100), paging: { next: "n", cursors: { after: "c2" } } },
        [`/${source}/ads?after=c2`]: { data: ads(1, 200) },
      });
      const { d } = await build(post(`/${source}/copies`, params), w);
      expect(d.identity).toContainEqual(unresolvedSource(source));
    });

    it("200 ads that end: complete, no unresolved entry", async () => {
      const w = world({
        [`/${source}/ads`]: { data: ads(100), paging: { next: "n", cursors: { after: "c1" } } },
        [`/${source}/ads?after=c1`]: { data: ads(100, 100) },
      });
      const { d } = await build(post(`/${source}/copies`, params), w);
      expect(d.identity).toEqual([{ field: "object_story_spec.page_id", via: "source_ad", id: PAGE, owner_page: PAGE, owner_ig: null }]);
    });
  });

  const nullCell = {
    id: null,
    account_id: null,
    created: false,
    role: "study-cell",
    spend_cap_minor_before: null,
    spend_cap_minor_after: null,
    name: null,
    status_after: null,
    buying_type: null,
  };
  const studyWorld = (cells: World) => world({ [`/${STUDY}`]: { metadata: { type: "adstudy" }, business: { id: BUSINESS } }, ...cells });

  it("a study edit with 51 cells adds an unresolved study-cell campaign", async () => {
    const cells = Array.from({ length: 51 }, () => ({ campaigns: { data: [{ id: CAMP }] } }));
    const { d } = await build(post(`/${STUDY}`, { name: "n" }), studyWorld({ [`/${STUDY}/cells`]: { data: cells } }));
    expect(d.campaigns).toContainEqual(nullCell);
    expect(d.campaigns.some((c) => c.id === CAMP)).toBe(true);
  });

  it("a study edit whose cells read fails adds an unresolved study-cell campaign", async () => {
    const { d } = await build(post(`/${STUDY}`, { name: "n" }), studyWorld({ [`/${STUDY}/cells`]: new Error("down") }));
    expect(d.campaigns).toEqual([nullCell]);
    expect(d.ad_account).toBeNull();
  });

  it("a cell whose nested campaigns Meta cut short adds one too", async () => {
    const cell = { campaigns: { data: [{ id: CAMP }], paging: { next: "n" } } };
    const { d } = await build(post(`/${STUDY}`, { name: "n" }), studyWorld({ [`/${STUDY}/cells`]: { data: [cell] } }));
    expect(d.campaigns).toContainEqual(nullCell);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 11: unreadable values are refused", () => {
  const cases: Array<[string, WriteRequest, string]> = [
    ["creative not json", post(`/${ACT}/ads`, { creative: "not json" }), "creative is not an object"],
    ["creative an array", post(`/${ACT}/ads`, { creative: [{ creative_id: CREATIVE }] }), "creative is not an object"],
    ["promoted_object:[1]", post(`/${ACT}/adsets`, { promoted_object: [1] }), "promoted_object is not an object"],
    ["promoted_object a string", post(`/${ACT}/adsets`, { promoted_object: "x" }), "promoted_object is not an object"],
    ["inline object_story_spec:'x'", post(`/${ACT}/ads`, { creative: { object_story_spec: "x" } }), "creative.object_story_spec is not an object"],
    ["inline asset_feed_spec [{}, 2]", post(`/${ACT}/ads`, { creative: { asset_feed_spec: [{}, 2] } }), "creative.asset_feed_spec is not an object"],
    ["cells:'x'", post(`/${BUSINESS}/ad_studies`, { cells: "x" }), "cells is not an object"],
    ["cells [1]", post(`/${BUSINESS}/ad_studies`, { cells: [1] }), "cells is not an object"],
    ["objectives:{}", post(`/${BUSINESS}/ad_studies`, { objectives: {} }), "objectives is not an object"],
    ["an empty key deep in a bounded object", post(`/${ACT}/adcreatives`, { object_story_spec: { link_data: [{ "": "x" }] } }), "object_story_spec is not an object"],
    ["an empty key in a creative", post(`/${ACT}/ads`, { creative: { name: "n", x: { "": 1 } } }), "creative is not an object"],
    ["an empty key in a cell", post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP], "": 1 }] }), "cells is not an object"],
  ];
  it.each(cases)("%s", async (_label, req, detail) => {
    await expect(build(req, world())).rejects.toThrow(refused(detail));
  });

  it("a bounded array of objects is readable", async () => {
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP] }], objectives: [{ name: "o" }] }), world());
    // Contract 1.1 C10: cells is bounded, so its leaf paths are params_keys too.
    expect(d.params_keys).toEqual(["cells", "cells.campaigns", "objectives", "objectives.name"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------
describe("rule 12: assembly", () => {
  it("params_keys, validate_only from execution_options, request_id and tool from ctx", async () => {
    const { d } = await build(post(`/${CAMP}`, { status: "ACTIVE", execution_options: ["validate_only"] }), world(), { tool: "ads_update_campaign" });
    expect(d.params_keys).toEqual(["status", "execution_options"]);
    expect(d.validate_only).toBe(true);
    expect(d.request_id).toBe("req-1");
    expect(d.tool).toBe("ads_update_campaign");
    expect(d.kind).toBe("update");
    expect(d.account_limit).toBe(false);
  });

  it("a status-only DELETED is a delete; an account edge key is account_limit", async () => {
    expect((await build(post(`/${AD}`, { status: "DELETED" }), world())).d.kind).toBe("delete");
    expect((await build(post(`/${ACT}/campaigns`, { spend_cap_action: "delete" }), world())).d.account_limit).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Each skipped fixture but contract §13's three and the two invalid__ (ruling m-20261116-114218529): its
// scenario's nearest request builds the consistent form.
describe("skipped fixtures build their consistent form", () => {
  const fixture = (name: string) => {
    const f = FIXTURES.find((x) => x.name === name);
    if (!f) throw new Error(name);
    return f;
  };
  const run = async (name: string, edit?: (s: Scenario) => void) => {
    const f = fixture(name);
    const s = scenarioFor(f);
    edit?.(s);
    return (await build(s, s.gets, { tool: (f.descriptor as { tool: string }).tool, accounts: accountsOf(s) })).d;
  };

  it("act-path-other-account: the act_ path's account is ad_account", async () => {
    const d = await run("act-path-other-account");
    expect(d.ad_account).toBe("act_9990000000000002");
    expect(d.object).toEqual({ type: "creative", id: null, created: true });
    expect(d.identity).toEqual([
      { field: "object_story_spec.page_id", via: "direct", id: "9991000000000001", owner_page: "9991000000000001", owner_ig: null },
    ]);
  });

  it("identity-key-no-entry: the instagram_user_id sent gets an entry, unresolved", async () => {
    const d = await run("identity-key-no-entry");
    expect(d.params_keys).toContain("instagram_user_id");
    expect(d.identity).toContainEqual({ field: "instagram_user_id", via: "direct", id: "9998000000000999", owner_page: null, owner_ig: null });
    expect(d.identity).toHaveLength(2);
  });

  it("unknown-kind-no-campaign: the campaign object lists itself as self", async () => {
    const d = await run("unknown-kind-no-campaign");
    expect(d.kind).toBe("other");
    expect(d.campaigns).toHaveLength(1);
    expect(d.campaigns[0].id).toBe("9994000000000240");
    expect(d.campaigns[0].role).toBe("self");
    expect(d.campaigns[0].account_id).toBe(ACT);
    expect(d.campaigns[0].created).toBe(false);
  });

  it("unresolved-campaign: an ad set whose campaign_id can't be read gives campaigns: []", async () => {
    const d = await run("unresolved-campaign");
    expect(d.object).toEqual({ type: "adset", id: "9995000000000083", created: false });
    expect(d.campaigns).toEqual([]);
    expect(d.ad_account).toBe(ACT);
  });

  // Final 1, GA1: an ad set that can't show its own account is `other`, so its typed tool is refused at build. The
  // fixture stays for the guard; the fork no longer builds an `adset` with a null account.
  it("null-ad-account: no account anywhere is refused for a typed tool, and reads no account facts", async () => {
    const calls: Call[] = [];
    const f = fixture("null-ad-account");
    const s = scenarioFor(f);
    // The nearest request: the parent campaign's account unreadable too, so nothing resolves the account.
    const camp = s.gets.get("/9994000000000950") as Record<string, unknown>;
    s.gets.set("/9994000000000950", { ...camp, account_id: undefined });
    await expect(
      buildDescriptor(s, { tool: "ads_update_ad_set", validateOnly: false, requestId: "r", accounts: new Set() }, fakeGet(s.gets, [])),
    ).rejects.toThrow("is a other");
    const d = await buildDescriptor(s, { tool: "ads_test_tool", validateOnly: false, requestId: "r", accounts: new Set() }, fakeGet(s.gets, calls));
    expect(validateDescriptor(d)).toEqual([]);
    expect(d.object.type).toBe("other");
    expect(d.ad_account).toBeNull();
    expect(d.account).toEqual({ spend_cap_minor: null, amount_spent_minor: null });
    expect(d.budget.currency).toBeNull();
    expect(calls.some((c) => c.params.fields === "spend_cap,amount_spent,currency")).toBe(false);
  });

  // Contract 1.1 §3.2 (C5): an asset_feed_spec entry comes from a leaf of its kind, whose path is in params_keys.
  // This fixture's entries have no such leaf (only asset_feed_spec.bodies.text), so its nearest request has none.
  it("garden3d-mixed-both: asset_feed_spec entries with no leaf of their kind are not built", async () => {
    const d = await run("garden3d-mixed-both");
    expect(d.params_keys.filter((k) => k.startsWith("asset_feed_spec."))).toEqual(["asset_feed_spec.bodies.text"]);
    expect(d.identity.some((e) => e.via === "asset_feed_spec")).toBe(false);
    expect(d.identity.every((e) => e.via === "direct")).toBe(true);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// Fix round 1 (review task-4): a request value present but unreadable refuses (T4-1, T4-3); every destination
// key a copy sends is a destination (T4-2); guards with no deciding test (T4-5).
describe("T4-1: an id present but not a readable id refuses", () => {
  const big = 2 ** 60; // past 2^53: not a safe integer
  const cases: Array<[string, WriteRequest, string]> = [
    ["an attached creative_id past 2^53", post(`/${ACT}/ads`, { adset_id: ADSET, creative: { creative_id: big } }), "creative.creative_id is not an id"],
    ["an attached creative_id in an array", post(`/${AD}`, { creative: { creative_id: [CREATIVE] } }), "creative.creative_id is not an id"],
    ["a top-level creative_id true", post(`/${AD}`, { creative_id: true }), "creative_id is not an id"],
    ["a top-level creative_id empty", post(`/${AD}`, { creative_id: "" }), "creative_id is not an id"],
    ["one unreadable value of a multi-valued field", post(`/${ACT}/adcreatives`, { object_id: [PAGE, 1.5] }), "object_id is not an id"],
    ["an object where a Page id goes", post(`/${ACT}/adcreatives`, { object_story_spec: { page_id: { id: PAGE } } }), "object_story_spec.page_id is not an id"],
    ["an inline creative's Instagram id null", post(`/${ACT}/ads`, { adset_id: ADSET, creative: { instagram_user_id: null } }), "creative.instagram_user_id is not an id"],
    ["a pixel id false", post(`/${ACT}/customconversions`, { pixel_id: false }), "pixel_id is not an id"],
    ["a study objective's pixel not digits", post(`/${BUSINESS}/ad_studies`, { objectives: [{ adspixels: [{ id: "abc" }] }] }), "objectives.adspixels.id is not an id"],
    ["a parent campaign_id not an id", post(`/${ACT}/adsets`, { campaign_id: "x" }), "campaign_id is not an id"],
    ["a parent adset_id fractional", post(`/${ACT}/ads`, { adset_id: 1.5 }), "adset_id is not an id"],
    ["a copy destination campaign_id empty", post(`/${ADSET}/copies`, { campaign_id: "" }), "campaign_id is not an id"],
    ["a study cell campaign id not digits", post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: ["x"] }] }), "cells.campaigns is not an id"],
    ["a study cell ad set id past 2^53", post(`/${BUSINESS}/ad_studies`, { cells: [{ adsets: [big] }] }), "cells.adsets is not an id"],
  ];
  it.each(cases)("%s", async (_label, req, detail) => {
    const calls: Call[] = [];
    const ctx = { tool: "ads_test_tool", validateOnly: false, requestId: "r", accounts: new Set<string>() };
    const err = await buildDescriptor(req, ctx, fakeGet(new Map(Object.entries(world())), calls)).catch((e: Error) => e);
    expect((err as Error).message).toBe(refused(detail));
    // Refused before any read.
    expect(calls).toEqual([]);
  });

  it("an identity value Graph reports unreadable makes its creative unresolved", async () => {
    const w = world({ [`/${CREATIVE}`]: { object_story_spec: { page_id: 1.5 }, instagram_actor_id: IG } });
    const { d } = await build(post(`/${ACT}/ads`, { adset_id: ADSET, creative: { creative_id: CREATIVE } }), w);
    expect(d.identity).toEqual(
      expect.arrayContaining([
        { field: "creative_id", via: "creative_id", id: CREATIVE, owner_page: null, owner_ig: null },
        { field: "instagram_actor_id", via: "creative_id", id: IG, owner_page: null, owner_ig: IG },
      ]),
    );
    expect(d.identity).toHaveLength(2);
  });

  it("an unreadable actor_id in a creative as read makes it unresolved too", async () => {
    const w = world({ [`/${CREATIVE}`]: { actor_id: [PAGE] } });
    const { d } = await build(post(`/${AD}/copies`, { adset_id: ADSET }), w);
    expect(d.identity).toEqual([{ field: "creative_id", via: "source_ad", id: CREATIVE, owner_page: null, owner_ig: null }]);
  });
});

describe("T4-2: every destination key a copy sends is a destination", () => {
  const dest = (d: Descriptor) => d.campaigns.filter((c) => c.role === "destination").map((c) => c.id);

  it("an ad copy with adset_id and campaign_id lists both campaigns", async () => {
    const { d } = await build(post(`/${AD}/copies`, { adset_id: ADSET2, campaign_id: CAMP, status_option: "ACTIVE" }), world());
    expect(dest(d)).toEqual([CAMP, CAMP2]);
  });

  it("an ad set copy with only adset_id lists that ad set's campaign and its own, where it lands", async () => {
    const { d } = await build(post(`/${ADSET2}/copies`, { adset_id: ADSET }), world({ [`/${ADSET2}/ads`]: { data: [] } }));
    expect(dest(d)).toEqual([CAMP2, CAMP]);
  });

  it("an ad copy with only campaign_id lists that campaign and its own", async () => {
    const { d } = await build(post(`/${AD}/copies`, { campaign_id: CAMP2 }), world());
    expect(dest(d)).toEqual([CAMP, CAMP2]);
  });

  it("an ad set copy by campaign_id and an ad copy by adset_id list only the deciding key's", async () => {
    expect(dest((await build(post(`/${ADSET}/copies`, { campaign_id: CAMP2 }), world({ [`/${ADSET}/ads`]: { data: [] } }))).d)).toEqual([CAMP2]);
    expect(dest((await build(post(`/${AD}/copies`, { adset_id: ADSET2 }), world())).d)).toEqual([CAMP2]);
  });

  it("a campaign copy sending campaign_id lists it beside the campaign it creates", async () => {
    const { d } = await build(post(`/${CAMP}/copies`, { campaign_id: CAMP2 }), world({ [`/${CAMP}/ads`]: { data: [] } }));
    expect(d.campaigns.map((c) => [c.id, c.created])).toEqual([
      [null, true],
      [CAMP2, false],
    ]);
  });

  it("an adset_id whose campaign can't be read refuses", async () => {
    await expect(build(post(`/${AD}/copies`, { adset_id: ADSET2 }), world({ [`/${ADSET2}`]: new Error("down") }))).rejects.toThrow(
      refused(`the campaign of adset_id ${ADSET2} can't be read`),
    );
  });
});

describe("T4-3: a study cell or other read value of the wrong shape refuses", () => {
  const cases: Array<[string, WriteRequest, string]> = [
    ["a cell's campaigns not an array", post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP] }, { campaigns: CAMP2 }] }), "cells.campaigns is not a list of ids"],
    ["a cell's adsets not an array", post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP] }, { adsets: ADSET2 }] }), "cells.adsets is not a list of ids"],
    ["a cell campaign object with more than its id", post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [{ id: CAMP, x: 1 }] }] }), "cells.campaigns is not an id"],
    ["a status that is not a status", post(`/${ADSET}`, { status: "LIVE" }), "status is not a status"],
    ["a status_option that is not one", post(`/${AD}/copies`, { status_option: "LIVE" }), "status_option is not a status option"],
    ["an end_time object", post(`/${ADSET}`, { end_time: {} }), "end_time is not a time"],
    ["a stop_time true", post(`/${CAMP}`, { stop_time: true }), "stop_time is not a time"],
  ];
  it.each(cases)("%s", async (_label, req, detail) => {
    await expect(build(req, world())).rejects.toThrow(refused(detail));
  });

  // Contract 1.1 C10: cells is bounded, so a cell key the builder doesn't read (cells.adaccounts) and a scalar key
  // holding an object are paths for the guard (rule 8), not refusals here: tests/must-fix/builder-1-1.test.ts.
  it("a cell's campaigns as id objects, and its scalar keys, are read", async () => {
    const cells = [{ id: "1", name: "a", treatment_percentage: 50, campaigns: [{ id: CAMP }] }, { adsets: [ADSET2] }];
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells }), world());
    expect(d.campaigns.map((c) => c.id)).toEqual([CAMP, CAMP2]);
  });
});

describe("T4-5: guards with a deciding test", () => {
  const nullCell = { id: null, account_id: null, created: false, role: "study-cell", spend_cap_minor_before: null, spend_cap_minor_after: null, name: null, status_after: null, buying_type: null };
  const studyWorld = (cells: unknown) =>
    world({ [`/${STUDY}`]: { metadata: { type: "adstudy" }, business: { id: BUSINESS } }, [`/${STUDY}/cells`]: { data: cells } });

  it("GRAPH_ID: an id Graph reports that is not Graph-shaped is never put in a GET path", async () => {
    const odd = `${CAMP}/../${CAMP2}`;
    const { d, calls } = await build(post(`/${ADSET}`, { name: "n" }), world({ [`/${ADSET}`]: { metadata: { type: "adset" }, account_id: ACT_DIGITS, campaign_id: odd } }));
    expect(calls.some((c) => c.path.includes(".."))).toBe(false);
    expect(d.campaigns).toEqual([{ ...nullCell, id: odd, role: "parent" }]);
  });

  it("a listed cell whose adsets edge Meta cut short adds the null entry", async () => {
    const { d } = await build(post(`/${STUDY}`, { name: "n" }), studyWorld([{ adsets: { data: [{ campaign_id: CAMP }], paging: { next: "n" } } }]));
    expect(d.campaigns).toContainEqual(nullCell);
  });

  it("a listed cell ad set with no campaign_id adds the null entry", async () => {
    const { d } = await build(post(`/${STUDY}`, { name: "n" }), studyWorld([{ campaigns: { data: [{ id: CAMP }] } }, { adsets: { data: [{}] } }]));
    expect(d.campaigns).toContainEqual(nullCell);
    expect(d.campaigns).toHaveLength(2);
  });

  it("identity entries are de-duplicated by field, via and id", async () => {
    const { d } = await build(post(`/${ACT}/adcreatives`, { object_id: [PAGE, PAGE] }), world());
    expect(d.identity).toEqual([{ field: "object_id", via: "direct", id: PAGE, owner_page: PAGE, owner_ig: null }]);
  });

  it("study-cell campaigns are de-duplicated by id", async () => {
    const { d } = await build(post(`/${BUSINESS}/ad_studies`, { cells: [{ campaigns: [CAMP] }, { campaigns: [CAMP] }] }), world());
    expect(d.campaigns.map((c) => c.id)).toEqual([CAMP]);
  });
});
