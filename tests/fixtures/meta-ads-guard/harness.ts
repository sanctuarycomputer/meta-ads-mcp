// The fixture harness (ticket 253, Tasks 4 and 7): each vendored fixture's descriptor inverted into the request
// that produces it and the Graph GET answers the builder reads (src/meta/write-descriptor.ts buildDescriptor).
// The request is decoded params (objects, not form strings; ruling R2). Listings end on a page with no `next`.
// A GET answer gives only the fields asked for (`answerGet`), as Graph does, so a read with too few fields shows.

type Obj = Record<string, unknown>;

interface CampaignEntry {
  id: string | null;
  account_id: string | null;
  created: boolean;
  role: string;
  spend_cap_minor_before: number | null;
  spend_cap_minor_after: number | null;
  name: string | null;
  status_after: string | null;
  buying_type: string | null;
}

interface IdentityEntry {
  field: string;
  via: string;
  id: string;
  owner_page: string | null;
  owner_ig: string | null;
}

export interface FixtureDescriptor {
  tool: string;
  method: "POST" | "DELETE";
  path: string;
  params_keys: string[];
  ad_account: string | null;
  account: { spend_cap_minor: number | null; amount_spent_minor: number | null };
  object: { type: string; id: string | null; created: boolean };
  status: { before: string | null; after: string | null };
  budget: {
    currency: string | null;
    kind_before: string | null;
    kind_after: string | null;
    before_minor: number | null;
    after_minor: number | null;
    end_time: string | null;
  };
  campaigns: CampaignEntry[];
  identity: IdentityEntry[];
  [key: string]: unknown;
}

export interface HarnessFixture {
  name: string;
  descriptor?: FixtureDescriptor | Record<string, unknown>;
  [key: string]: unknown;
}

export interface Scenario {
  method: "POST" | "DELETE";
  path: string;
  /** The request as decoded params (ruling R2). */
  params: Record<string, unknown>;
  /** GET answers by `path`, or `path?after=<cursor>` for a later page; an Error is a failed read. */
  gets: Map<string, unknown>;
  /** GETs the session made before the write; their `act_` ids are the session's accounts (`ctx.accounts`). */
  priorGets?: string[];
}

/**
 * Fixtures the fork does not drive (contract 1.1 §13; ruling m-20261116-114218529), each with the builder rule that
 * rules it out. The three field fixtures of §13 and the two `invalid__` (IP3) exist for the guard alone; the six
 * guard-side fixtures and the three 1.1 ones (§13: `lead-form-no-entry`, `bare-creative`, `bare-creative-on-update`)
 * hold a value no request gives under buildDescriptor's rules (tests/meta/write-guard-descriptor.test.ts builds the
 * nearest request of several and asserts the consistent form). `cross-brand__asset_feed_spec` is driven at 1.1 (C5).
 */
const ASSET_FEED_ID =
  "contract 1.1 §3.2: an asset_feed_spec entry's id sits at a params_keys leaf of its kind, and this one has none";
export const SKIPPED: Readonly<Record<string, string>> = {
  "kind-mismatch": "contract §13: a kind a correct fork never sends",
  "account-limit-flag-wrong": "contract §13: an account_limit a correct fork never sends",
  "vo-mismatch": "contract §13: a validate_only a correct fork never sends",
  "invalid__unknown-identity-field": "ruling m-20261116-111117488 (IP3): tests the guard",
  "invalid__unknown-key": "ruling m-20261116-111117488 (IP3): tests the guard",
  "act-path-other-account": "rule 6: an act_ path's account is the ad_account",
  "identity-key-no-entry": "rule 9: every identity key sent gets an entry",
  "unknown-kind-no-campaign": "rule 8: a campaign object lists self on every row",
  "unresolved-campaign": "rule 8: an unreadable parent campaign id gives no entry",
  "null-ad-account": "rule 7: account facts are read only from a resolved ad_account",
  "lead-form-no-entry": "contract §13: a fork always makes the lead-form entry, unresolved or not",
  "bare-creative": "contract §13: a fork lists creative.creative_id whenever it made a creative_id entry",
  "bare-creative-on-update": "contract §13: a fork lists creative.creative_id whenever it made a creative_id entry",
  "garden3d-mixed-both": ASSET_FEED_ID,
};

// Per-fixture choices the inversion cannot make from the descriptor alone, each with its reason.
const OVERRIDES: Readonly<Record<string, { reason: string; apply: (s: Scenario, d: FixtureDescriptor) => void }>> = {
  "creative-id-unbounded": {
    reason: "ruling R4: a successful creative GET whose spec holds a path no §5.1 list admits, not a failed GET",
    apply: (s, d) => {
      const cid = d.identity.find((e) => e.field === "creative_id")?.id ?? "";
      s.gets.set(`/${cid}`, {
        id: cid,
        object_story_spec: { link_data: { branded_content_sponsor_page_id: "9991000000000002" } },
      });
    },
  },
};

const BOUNDED = new Set([
  "object_story_spec",
  "call_to_action",
  "asset_feed_spec",
  "promoted_object",
  "lookalike_spec",
  "objectives",
  "creative_asset_groups_spec",
  "creative_sourcing_spec",
]);
// Contract 1.1 §3.2: the identity kind a leaf inside asset_feed_spec names, by its last key, and the field of
// that kind its entry carries. The harness's own copy, so the builder's ASSET_FEED_KINDS is checked against it.
const ASSET_FEED_KIND_FIELD: Readonly<Record<string, string>> = {
  page: "object_story_spec.page_id",
  page_id: "object_story_spec.page_id",
  instagram_user_id: "object_story_spec.instagram_user_id",
  instagram_actor_id: "object_story_spec.instagram_user_id",
  lead_gen_form_id: "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
  pixel_id: "promoted_object.pixel_id",
};
const PAGE_FIELDS = new Set(["object_story_spec.page_id", "promoted_object.page_id", "object_id"]);
const IG_FIELDS = new Set(["instagram_user_id", "instagram_actor_id", "object_story_spec.instagram_user_id"]);
const LEAD_FIELDS = new Set([
  "object_story_spec.link_data.call_to_action.value.lead_gen_form_id",
  "object_story_spec.video_data.call_to_action.value.lead_gen_form_id",
]);
const PIXEL_FIELDS = new Set(["promoted_object.pixel_id", "pixel_id", "objectives.adspixels.id"]);
const GRAPH_TYPE: Readonly<Record<string, string>> = {
  campaign: "campaign",
  adset: "adset",
  ad: "ad",
  creative: "adcreative",
  image: "adimage",
  video: "advideo",
  audience: "customaudience",
  custom_conversion: "customconversion",
  study: "adstudy",
  budget_schedule: "budget_schedule",
  page_post: "post",
  account: "adaccount",
  other: "unknown_thing",
};

const UNREADABLE_ID = "9998000000000999";
const isObj = (x: unknown): x is Obj => x !== null && typeof x === "object" && !Array.isArray(x);
const digits = (act: string | null): string | undefined => (act ? act.replace(/^act_/, "") : undefined);
// An object without its null or undefined values: Graph leaves out a field it has no value for.
const present = (o: Obj): Obj => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined));

function setPath(target: Obj, path: string, value: unknown): void {
  const parts = path.split(".");
  let at = target;
  for (const part of parts.slice(0, -1)) {
    if (!isObj(at[part])) at[part] = {};
    at = at[part] as Obj;
  }
  at[parts[parts.length - 1]] = value;
}

/** The GET answer for one read: only the fields asked for (and `id`, which Graph always returns). */
export function answerGet(gets: ReadonlyMap<string, unknown>, path: string, params: Record<string, string | number>): unknown {
  const key = params.after === undefined ? path : `${path}?after=${params.after}`;
  if (!gets.has(key)) throw new Error(`fake Graph: nothing at ${key}`);
  const answer = gets.get(key);
  if (answer instanceof Error) throw answer;
  const names = topLevelFields(String(params.fields ?? ""));
  const pick = (o: unknown): unknown => {
    if (!isObj(o)) return o;
    const out: Obj = {};
    if ("id" in o) out.id = o.id;
    for (const n of names) if (n in o) out[n] = o[n];
    if ((params.metadata === 1 || params.metadata === "1") && "metadata" in o) out.metadata = o.metadata;
    return out;
  };
  if (isObj(answer) && Array.isArray(answer.data)) return { ...answer, data: answer.data.map(pick) };
  return pick(answer);
}

// "a,b{c,d},e" → ["a", "b", "e"].
function topLevelFields(fields: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = "";
  for (const ch of fields) {
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (ch === "," && depth === 0) {
      out.push(cur);
      cur = "";
    } else if (depth === 0 && ch !== "}") cur += ch;
  }
  if (cur) out.push(cur);
  return out.map((f) => f.trim()).filter(Boolean);
}

/** A fixture's request and GET answers, by inverting buildDescriptor's rules (Task 4) over its descriptor. */
export function scenarioFor(fixture: HarnessFixture): Scenario {
  if (!fixture.descriptor) throw new Error(`fixture ${fixture.name} has no descriptor`);
  const d = fixture.descriptor as FixtureDescriptor;
  const gets = new Map<string, unknown>();
  const put = (path: string, o: Obj): void => {
    const was = gets.get(path);
    gets.set(path, { ...(isObj(was) ? was : {}), ...present(o) });
  };
  const fail = (path: string): void => {
    gets.set(path, new Error(`fake Graph: ${path} unreadable`));
  };

  const keys = d.params_keys;
  const has = (k: string): boolean => keys.includes(k);
  const byRole = (role: string): CampaignEntry | undefined => d.campaigns.find((c) => c.role === role);
  const parent = byRole("parent");
  const destination = byRole("destination");
  const self = byRole("self");
  const synthAdset = (campaignId: string): string => `9995${campaignId.slice(4)}`;
  const base = d.object.id && /^\d+$/.test(d.object.id) ? d.object.id : (parent?.id ?? self?.id ?? "9990000000000000");
  const synthCreative = (i = 0): string => `9997${base.slice(4)}${i}`;
  const entryFor = (field: string, via: string): IdentityEntry | undefined =>
    d.identity.find((e) => e.field === field && e.via === via);

  // ---- params ----
  // An identity field sent with no entry in the fixture: an id no GET can read (identity-key-no-entry).
  const isIdentity = (path: string): boolean =>
    PAGE_FIELDS.has(path) || IG_FIELDS.has(path) || LEAD_FIELDS.has(path) || PIXEL_FIELDS.has(path) ||
    path === "object_story_id" || path === "source_instagram_media_id";
  const leaf = (path: string, via: string): unknown =>
    entryFor(path, via)?.id ?? (isIdentity(path) ? UNREADABLE_ID : "x");
  const bounded = (key: string, prefix: string, via: string): unknown => {
    const value: Obj = {};
    for (const k of keys) {
      if (!k.startsWith(`${prefix}${key}.`)) continue;
      const sub = k.slice(`${prefix}${key}.`.length);
      setPath(value, sub, leaf(`${key}.${sub}`, via));
    }
    // An id `via: asset_feed_spec` sits at the params_keys leaf of its kind (contract 1.1 §3.2, C5): each entry
    // takes the first unused leaf whose last key names a kind of its field. Every other leaf holds "x", a non-id.
    if (key === "asset_feed_spec") {
      const free = keys
        .filter((k) => k.startsWith(`${prefix}${key}.`))
        .map((k) => k.slice(`${prefix}${key}.`.length));
      for (const e of d.identity.filter((x) => x.via === "asset_feed_spec")) {
        const at = free.findIndex((sub) => ASSET_FEED_KIND_FIELD[sub.split(".").pop() ?? ""] === e.field);
        if (at >= 0) setPath(value, free.splice(at, 1)[0], e.id);
      }
    }
    return key === "objectives" ? [value] : value;
  };
  const params: Record<string, unknown> = {};
  const creativeIds: string[] = [];
  for (const key of keys) {
    if (key.includes(".")) continue;
    params[key] = paramValue(key);
  }

  function paramValue(key: string): unknown {
    if (key === "creative") {
      if (has("creative.creative_id")) {
        const cid = entryFor("creative_id", "creative_id")?.id ?? synthCreative();
        creativeIds.push(cid);
        return { creative_id: cid };
      }
      const creative: Obj = {};
      for (const k of keys) {
        if (!k.startsWith("creative.")) continue;
        const ck = k.slice("creative.".length);
        if (ck.includes(".")) continue;
        creative[ck] = BOUNDED.has(ck) ? bounded(ck, "creative.", "creative") : leaf(ck, "creative");
      }
      return creative;
    }
    if (BOUNDED.has(key)) return bounded(key, "", "direct");
    switch (key) {
      case "status":
        return d.status.after;
      case "status_option":
        return d.status.after === "ACTIVE" || d.status.after === "PAUSED" ? d.status.after : "INHERITED_FROM_SOURCE";
      case "daily_budget":
      case "lifetime_budget":
        return d.budget.after_minor ?? "x";
      case "spend_cap":
        return self?.spend_cap_minor_after ?? 922337203685478;
      case "end_time":
      case "stop_time":
        return d.budget.end_time ?? "2026-12-31T00:00:00-0500";
      case "campaign_id":
        return (destination ?? parent)?.id ?? "x";
      case "adset_id": {
        const c = destination ?? parent;
        return c?.id ? synthAdset(c.id) : "x";
      }
      case "buying_type":
        return self?.buying_type ?? "x";
      case "execution_options":
        return ["validate_only"];
      case "cells": {
        // Contract 1.1 C10: each cell carries every cells.* path the fixture lists; a cell's campaigns are its
        // study-cell campaign, any other path a scalar.
        const cell = (i: number, campaignId: string | null): Obj => {
          const out: Obj = {};
          for (const k of keys) {
            if (!k.startsWith("cells.")) continue;
            const sub = k.slice("cells.".length);
            if (sub === "campaigns") {
              if (campaignId) out.campaigns = [campaignId];
            }
            else if (sub === "name") out.name = `cell ${i + 1}`;
            else if (sub === "treatment_percentage") out.treatment_percentage = 50;
            else setPath(out, sub, "x");
          }
          return out;
        };
        return d.object.created
          ? d.campaigns.filter((c) => c.role === "study-cell").map((c, i) => cell(i, c.id))
          : [cell(0, null)];
      }
      default:
        return leaf(key, "direct");
    }
  }

  // ---- the written object ----
  if (!d.object.created && d.object.id) {
    const o: Obj = { metadata: { type: GRAPH_TYPE[d.object.type] } };
    const budget = d.budget.kind_before ? { [`${d.budget.kind_before}_budget`]: String(d.budget.before_minor) } : {};
    if (d.object.type === "campaign") {
      Object.assign(o, budget, { account_id: digits(self?.account_id ?? d.ad_account), status: d.status.before });
    } else if (d.object.type === "adset") {
      const campaignId = parent?.id ?? (has("campaign_id") || has("adset_id") ? undefined : destination?.id);
      Object.assign(o, budget, { account_id: digits(d.ad_account), status: d.status.before, campaign_id: campaignId });
    } else if (d.object.type === "ad") {
      const campaignId = parent?.id ?? destination?.id;
      Object.assign(o, {
        account_id: digits(d.ad_account),
        status: d.status.before,
        campaign_id: campaignId,
        adset_id: campaignId ? synthAdset(campaignId) : undefined,
      });
    } else if (d.object.type === "creative") {
      Object.assign(o, { account_id: digits(d.ad_account) });
    } else if (d.object.type === "study") {
      Object.assign(o, { business: { id: "9999000000000001" } });
    }
    put(`/${d.object.id}`, o);
  }

  // ---- campaigns ----
  for (const c of d.campaigns) {
    if (!c.id || c.created) continue;
    put(`/${c.id}`, {
      account_id: digits(c.account_id),
      name: c.name,
      spend_cap: c.spend_cap_minor_before === null ? null : String(c.spend_cap_minor_before),
      effective_status: c.status_after,
      buying_type: c.buying_type,
    });
  }
  if (d.object.created && parent?.id && has("adset_id")) put(`/${synthAdset(parent.id)}`, { campaign_id: parent.id });
  if (destination?.id && has("adset_id")) put(`/${synthAdset(destination.id)}`, { campaign_id: destination.id });
  if (d.object.type === "study" && !d.object.created && d.object.id) {
    put(`/${d.object.id}/cells`, {
      data: d.campaigns.filter((c) => c.role === "study-cell").map((c) => ({ campaigns: { data: [{ id: c.id }] } })),
    });
  }

  // ---- the account ----
  if (d.ad_account) {
    put(`/${d.ad_account}`, {
      spend_cap: d.account.spend_cap_minor === null ? null : String(d.account.spend_cap_minor),
      amount_spent: d.account.amount_spent_minor === null ? null : String(d.account.amount_spent_minor),
      currency: d.budget.currency,
    });
  }

  // ---- identity ----
  const owner = (e: IdentityEntry): void => {
    if (e.field === "creative_id" || PIXEL_FIELDS.has(e.field)) return;
    const carrier = e.owner_page ?? e.owner_ig;
    if (carrier === null) return fail(`/${e.id}`);
    if (PAGE_FIELDS.has(e.field) || IG_FIELDS.has(e.field)) put(`/${e.id}`, { id: carrier });
    else if (e.field === "object_story_id") put(`/${e.id}`, { from: { id: carrier } });
    else if (e.field === "source_instagram_media_id") put(`/${e.id}`, { owner: { id: carrier } });
    else if (LEAD_FIELDS.has(e.field)) put(`/${e.id}`, { page: { id: carrier } });
  };
  for (const e of d.identity) owner(e);

  // A creative as read: each entry's field at its own path in the spec.
  const spec = (cid: string, entries: IdentityEntry[]): void => {
    const s: Obj = { id: cid, name: "creative" };
    for (const e of entries) setPath(s, e.field, e.id);
    put(`/${cid}`, s);
  };
  for (const cid of creativeIds) {
    const entries = d.identity.filter((e) => e.via === "creative_id");
    if (entries.some((e) => e.field === "creative_id")) fail(`/${cid}`);
    else spec(cid, entries);
  }
  if (/\/copies$/.test(d.path) && d.object.id) {
    const entries = d.identity.filter((e) => e.via === "source_ad");
    if (d.object.type === "ad") {
      const cid = synthCreative();
      put(`/${d.object.id}`, { creative: { id: cid } });
      spec(cid, entries);
    } else {
      // A deep copy: one creative per ad, each holding at most one value of a field.
      const groups: IdentityEntry[][] = [];
      for (const e of entries) {
        const g = groups.find((x) => !x.some((y) => y.field === e.field));
        if (g) g.push(e);
        else groups.push([e]);
      }
      const ids = groups.map((_, i) => synthCreative(i));
      groups.forEach((g, i) => spec(ids[i], g));
      put(`/${d.object.id}/ads`, { data: ids.map((id) => ({ creative: { id } })) });
    }
  }

  const scenario: Scenario = { method: d.method, path: d.path, params, gets };
  if (d.object.type === "page_post" && d.ad_account) scenario.priorGets = [`/${d.ad_account}/ads`];
  OVERRIDES[fixture.name]?.apply(scenario, d);
  return scenario;
}

/** The session's accounts: every `act_` id in its prior GETs. */
export function accountsOf(s: Scenario): Set<string> {
  const out = new Set<string>();
  for (const p of s.priorGets ?? []) for (const m of p.matchAll(/act_\d+/g)) out.add(m[0]);
  return out;
}
