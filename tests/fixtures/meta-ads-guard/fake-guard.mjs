#!/usr/bin/env node
// Fake Meta ads spend guard (docs/contracts/meta-ads-guard.md@1.0 §13). It decides nothing: it answers
// each descriptor with the reply of the fixture whose descriptor matches it, so the fork (253) can build
// and test against the contract before the real guard (255) exists. Node builtins only, so the fork can
// vendor this file with the fixtures.
//
//   node scripts/meta-ads/fake-guard.mjs [--fixtures <dir>]   (descriptor or outcome record on stdin)
//
// Exit 0: a reply or ack was printed. Exit 2: the input is invalid (the printed reply refuses). Exit 3: no
// fixture matches (the printed reply refuses). A `for: "fork"` fixture exits with its own `fake.exit`.
// Exit 1: the fake itself is broken (a fixture without a reply, `--fixtures` without a directory).
import { readdirSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const V = "1.0";
const PATH_RE = /^\/(v\d+\.\d+\/)?[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
const KINDS = ["create", "update", "delete", "copy", "study", "budget-schedule", "post-edit", "boost", "other"];
const OBJECT_TYPES = [
  "campaign",
  "adset",
  "ad",
  "creative",
  "image",
  "video",
  "audience",
  "custom_conversion",
  "study",
  "budget_schedule",
  "page_post",
  "account",
  "other",
];
const STATUSES = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED"];
const EFFECTIVE_STATUSES = ["ACTIVE", "PAUSED", "DELETED", "ARCHIVED", "IN_PROCESS", "WITH_ISSUES"];
const BUDGET_KINDS = ["daily", "lifetime"];
const ROLES = ["self", "parent", "destination", "study-cell"];
const VIAS = ["direct", "creative", "creative_id", "source_ad", "asset_feed_spec"];
// Which owner key carries an identity field's resolution (contract §3.2). The other key is always null.
/** Contract §3.2: each identity field and the owner key that carries its resolution (null: a pixel, none). */
export const OWNER_KEY = {
  "object_story_spec.page_id": "owner_page",
  object_story_id: "owner_page",
  "promoted_object.page_id": "owner_page",
  "object_story_spec.instagram_user_id": "owner_ig",
  instagram_user_id: "owner_ig",
  instagram_actor_id: "owner_ig",
  source_instagram_media_id: "owner_ig",
  object_id: "owner_page",
  creative_id: "owner_page",
  "object_story_spec.link_data.call_to_action.value.lead_gen_form_id": "owner_page",
  "object_story_spec.video_data.call_to_action.value.lead_gen_form_id": "owner_page",
  "promoted_object.pixel_id": null,
  pixel_id: null,
  "objectives.adspixels.id": null,
};

const isObj = (x) => x !== null && typeof x === "object" && !Array.isArray(x);
const isStr = (x) => typeof x === "string" && x.length > 0;
const isMinor = (x) => Number.isSafeInteger(x) && x >= 0;
const orNull = (pred) => (x) => x === null || pred(x);
const oneOf = (list) => (x) => list.includes(x);

// Checks one object against a {key: predicate} shape: every key present, no others.
function checkShape(where, value, shape, problems) {
  if (!isObj(value)) {
    problems.push(`${where} must be an object`);
    return;
  }
  for (const [key, pred] of Object.entries(shape)) {
    if (!Object.hasOwn(value, key)) problems.push(`${where}.${key} is missing`);
    else if (!pred(value[key])) problems.push(`${where}.${key} is invalid: ${JSON.stringify(value[key])}`);
  }
  for (const key of Object.keys(value))
    if (!Object.hasOwn(shape, key)) problems.push(`${where}.${key} is not a contract field`);
}

const TOP = {
  v: (x) => x === V,
  request_id: isStr,
  tool: isStr,
  method: oneOf(["POST", "DELETE"]),
  path: (x) => typeof x === "string" && PATH_RE.test(x),
  params_keys: (x) => Array.isArray(x) && x.every(isStr) && new Set(x).size === x.length,
  ad_account: orNull((x) => typeof x === "string" && /^act_\d+$/.test(x)),
  account: isObj,
  object: isObj,
  status: isObj,
  budget: isObj,
  campaigns: Array.isArray,
  identity: Array.isArray,
  kind: oneOf(KINDS),
  account_limit: (x) => typeof x === "boolean",
  validate_only: (x) => typeof x === "boolean",
};
const ACCOUNT = { spend_cap_minor: orNull(isMinor), amount_spent_minor: orNull(isMinor) };
const OBJECT = { type: oneOf(OBJECT_TYPES), id: orNull(isStr), created: (x) => typeof x === "boolean" };
const STATUS = { before: orNull(oneOf(STATUSES)), after: orNull(oneOf(STATUSES)) };
const BUDGET = {
  currency: orNull((x) => typeof x === "string" && /^[A-Z]{3}$/.test(x)),
  kind_before: orNull(oneOf(BUDGET_KINDS)),
  kind_after: orNull(oneOf(BUDGET_KINDS)),
  before_minor: orNull(isMinor),
  after_minor: orNull(isMinor),
  end_time: orNull(isStr),
};
const CAMPAIGN = {
  id: orNull(isStr),
  account_id: orNull((x) => typeof x === "string" && /^act_\d+$/.test(x)),
  created: (x) => typeof x === "boolean",
  role: oneOf(ROLES),
  spend_cap_minor_before: orNull(isMinor),
  spend_cap_minor_after: orNull(isMinor),
  name: orNull(isStr),
  status_after: orNull(oneOf(EFFECTIVE_STATUSES)),
  buying_type: orNull(isStr),
};
const IDENTITY = {
  field: (x) => Object.hasOwn(OWNER_KEY, x),
  via: oneOf(VIAS),
  id: isStr,
  owner_page: orNull(isStr),
  owner_ig: orNull(isStr),
};

/** Problems with a descriptor against the contract's field tables (§3); empty when it is valid. */
export function validateDescriptor(d) {
  const problems = [];
  checkShape("descriptor", d, TOP, problems);
  if (!isObj(d)) return problems;
  if (isObj(d.account)) checkShape("account", d.account, ACCOUNT, problems);
  if (isObj(d.object)) checkShape("object", d.object, OBJECT, problems);
  if (isObj(d.status)) checkShape("status", d.status, STATUS, problems);
  if (isObj(d.budget)) checkShape("budget", d.budget, BUDGET, problems);
  for (const [i, c] of (Array.isArray(d.campaigns) ? d.campaigns : []).entries()) {
    checkShape(`campaigns[${i}]`, c, CAMPAIGN, problems);
  }
  for (const [i, e] of (Array.isArray(d.identity) ? d.identity : []).entries()) {
    checkShape(`identity[${i}]`, e, IDENTITY, problems);
    if (!isObj(e) || !Object.hasOwn(OWNER_KEY, e.field)) continue;
    // A creative_id entry exists only when the creative's GET failed: unresolved, so its carrier is null too.
    if (e.field === "creative_id" && e.owner_page !== null)
      problems.push(`identity[${i}].owner_page must be null for creative_id`);
    for (const key of ["owner_page", "owner_ig"]) {
      if (key !== OWNER_KEY[e.field] && key in e && e[key] !== null) {
        problems.push(`identity[${i}].${key} must be null for ${e.field}`);
      }
    }
  }
  return problems;
}

/** Problems with an outcome record (§9); empty when it is valid. */
export function validateOutcome(o) {
  const problems = [];
  checkShape(
    "outcome",
    o,
    {
      v: (x) => x === V,
      outcome_for: isStr,
      ok: (x) => typeof x === "boolean",
      meta_id: orNull(isStr),
      error: orNull((x) => typeof x === "string"),
    },
    problems,
  );
  return problems;
}

function canonical(x) {
  if (Array.isArray(x)) return `[${x.map(canonical).join(",")}]`;
  if (isObj(x)) {
    const keys = Object.keys(x).sort();
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(x[k])}`).join(",")}}`;
  }
  return JSON.stringify(x);
}

/** The matching key of a descriptor (§13): no request_id or tool; params_keys, campaigns and identity unordered. */
export function normalise(d) {
  const { request_id: _request, tool: _tool, ...rest } = d;
  const sortBy = (arr) =>
    Array.isArray(arr) ? [...arr].sort((a, b) => canonical(a).localeCompare(canonical(b))) : arr;
  return canonical({
    ...rest,
    params_keys: sortBy(rest.params_keys),
    campaigns: sortBy(rest.campaigns),
    identity: sortBy(rest.identity),
  });
}

/** Every fixture (*.json) in dir, sorted by file name. */
export function loadFixtures(dir) {
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .sort()
    .map((f) => JSON.parse(readFileSync(join(dir, f), "utf8")));
}

// Exit 2 prints both refusal shapes, so a caller that sent either a descriptor or an outcome reads a no.
const invalid = (reason) => `${JSON.stringify({ v: V, allow: false, ack: false, reason, basis: null, receipt: "" })}\n`;
const NO_MATCH = "fake guard: no fixture matches this descriptor";

/** The fake's whole decision for one stdin text. Pure: the CLI only does the I/O. */
export function answer(input, fixtures) {
  const out = (stdout, exit, stderr = "", delayMs = 0) => ({ stdout, stderr, exit, delayMs });
  let msg;
  try {
    msg = JSON.parse(input);
  } catch {
    return out(invalid("invalid input: not JSON"), 2);
  }
  if (isObj(msg) && "outcome_for" in msg) {
    const problems = validateOutcome(msg);
    if (problems.length > 0) return out(invalid(`invalid outcome record: ${problems[0]}`), 2);
    return out(`${JSON.stringify({ v: V, ack: true, receipt: `fake-outcome-${msg.outcome_for}` })}\n`, 0);
  }
  const problems = validateDescriptor(msg);
  if (problems.length > 0) return out(invalid(`invalid descriptor: ${problems[0]}`), 2);
  const key = normalise(msg);
  const hit = fixtures.find((f) => f.descriptor && normalise(f.descriptor) === key);
  if (!hit) {
    return out(`${JSON.stringify({ v: V, allow: false, reason: NO_MATCH, basis: null, receipt: "" })}\n`, 3);
  }
  const named = `fixture: ${hit.name}\n`;
  if (hit.fake) return out(hit.fake.stdout, hit.fake.exit, named, hit.fake.delay_ms ?? 0);
  if (!isObj(hit.reply)) return out("", 1, `fake guard: fixture ${hit.name} has neither reply nor fake\n`);
  return out(`${JSON.stringify(hit.reply)}\n`, 0, named);
}

// `{id}` is digits, or Graph's `<digits>_<digits>` for a Page post or comment (contract §4).
const PATH_PART = { "{act}": "act_\\d+", "{id}": "\\d+(?:_\\d+)?" };

/** The endpoint row for a request (contract §4): method, path pattern (optional /vNN.N prefix), object type. */
export function matchEndpoint(endpoints, method, path, objectType) {
  for (const row of endpoints.rows) {
    if (row.method !== method) continue;
    if (row.object_type !== "any" && row.object_type !== objectType) continue;
    const pattern = row.path
      .split("/")
      .map((part) => PATH_PART[part] ?? part.replace(/[^A-Za-z0-9_]/g, ""))
      .join("/");
    if (new RegExp(`^(/v\\d+\\.\\d+)?${pattern}$`).test(path)) return row;
  }
  return null;
}

const INLINE_POST_FIELDS = ["source_instagram_media_id", "object_story_id"];

/** A request's kind (contract §4): the row's kind, refined where the path alone does not decide. */
export function deriveKind(row, d) {
  if (!row) return "other";
  if (row.refine === "boost-if-inline-post") {
    const inlinePost = d.identity.some((e) => e.via === "creative" && INLINE_POST_FIELDS.includes(e.field));
    return inlinePost ? "boost" : row.kind;
  }
  if (row.refine === "delete-if-status-deleted") {
    const keys = d.params_keys.filter((k) => k !== "execution_options");
    const onlyStatus = keys.length === 1 && keys[0] === "status";
    return onlyStatus && d.status.after === "DELETED" ? "delete" : row.kind;
  }
  return row.kind;
}

/** Whether a write carries a creative, so rule 1's Instagram identity check applies (contract §4). */
export function deriveCreativeBearing(row, d) {
  if (!row) return false;
  if (row.creative_bearing === "always") return true;
  if (row.creative_bearing === "if-creative-key") return d.params_keys.includes("creative");
  return false;
}

/** Whether a request touches the account's limits or billing (contract §4.1, interpretation I2). */
export function deriveAccountLimit(endpoints, row, d) {
  if (d.object.type === "account") return true;
  if (!row) return /^\/(v\d+\.\d+\/)?act_\d+/.test(d.path);
  if (row.account_limit === "always") return true;
  if (row.account_limit === "never") return false;
  const rule = endpoints.account_limit_keys;
  return d.params_keys.some((key) => {
    const k = key.toLowerCase();
    if (rule.except.includes(k)) return false;
    if (k === "spend_cap") return !rule.spend_cap_allowed_rows.includes(row.id);
    return (
      rule.exact.includes(k) || rule.prefix.some((p) => k.startsWith(p)) || rule.contains.some((c) => k.includes(c))
    );
  });
}

function fixturesDir(argv) {
  const i = argv.indexOf("--fixtures");
  if (i >= 0 && !argv[i + 1]) throw new Error("--fixtures needs a directory");
  if (i >= 0) return argv[i + 1];
  return join(dirname(fileURLToPath(import.meta.url)), "..", "..", "docs", "contracts", "meta-ads-guard", "fixtures");
}

async function main() {
  let fixtures;
  try {
    fixtures = loadFixtures(fixturesDir(process.argv.slice(2)));
  } catch (err) {
    process.stderr.write(`fake guard: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const result = answer(Buffer.concat(chunks).toString("utf8"), fixtures);
  if (result.delayMs) await new Promise((resolve) => setTimeout(resolve, result.delayMs));
  process.stderr.write(result.stderr);
  process.stdout.write(result.stdout);
  process.exitCode = result.exit;
}

// Real paths both sides, so the fake runs when reached through a symlinked file or directory (a vendored copy).
const realOrNull = (p) => {
  try {
    return realpathSync(p);
  } catch {
    return null;
  }
};
if (process.argv[1] && realOrNull(process.argv[1]) === realOrNull(fileURLToPath(import.meta.url))) await main();
