// The client's guarded write path (ticket 253, Task 5): sendWrite through the real gate (RealWriteGate and a
// GuardRunner running a stub guard, contract docs/contracts/meta-ads-guard.md §2, §8, §9, §10), never the
// pass-through gate tests/setup-write-gate.ts gives the singleton.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";

import { MetaApiClient, metaApiClient } from "../../src/meta/client.js";
import { withPageToken } from "../../src/meta/page-token.js";
import * as wd from "../../src/meta/write-descriptor.js";
import { matchEndpoint, type Descriptor } from "../../src/meta/write-descriptor.js";
import { GuardRunner, RealWriteGate, callContext, newCallContext, type CallContext } from "../../src/meta/write-guard.js";
import { registerAudienceTools } from "../../src/tools/audiences.js";
import { hashToken } from "../../src/auth/token-store.js";
import { loadFixtures } from "../fixtures/meta-ads-guard/fake-guard.mjs";
import { accountsOf, answerGet, scenarioFor } from "../fixtures/meta-ads-guard/harness.js";
import { TEST_APP_SECRET, cleanupTestToken, createMockMcpServer, mockFetchResponse, setupTestToken } from "../setup.js";
import { createHmac } from "node:crypto";
import { PASS } from "../setup-write-gate.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STUBS = join(ROOT, "tests/fixtures/meta-ads-guard/stubs");
const FIXTURES = loadFixtures(join(ROOT, "tests/fixtures/meta-ads-guard/fixtures"));
const stub = (name: string, ...args: string[]) => ["node", join(STUBS, `${name}.mjs`), ...args].join(" ");
const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

const ACT = "act_9990000000000001";
const CAMP = "9994000000000001";
const AD = "9996000000000001";

// ---- the fake Graph: GETs answered from a world, writes from `onWrite`, every call recorded ----

interface Sent {
  method: string;
  path: string;
  query: URLSearchParams;
  init?: RequestInit;
}
let calls: Sent[];
let world: Map<string, unknown>;
let onWrite: (c: Sent, n: number) => Promise<Response> | Response;

const graphError = (message: string) =>
  mockFetchResponse({ error: { code: 100, type: "OAuthException", message } }, { status: 400 });

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const c: Sent = { method: init?.method ?? "GET", path: url.pathname.replace(/^\/v\d+\.\d+/, ""), query: url.searchParams, init };
      calls.push(c);
      if (c.method !== "GET") return onWrite(c, calls.filter((x) => x.method !== "GET").length);
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== "appsecret_proof") params[k] = v;
      try {
        return mockFetchResponse(answerGet(world, c.path, params));
      } catch (e) {
        return graphError((e as Error).message);
      }
    }),
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");

// ---- the guard's record: every message the stub read, one JSON object per line ----

let dir: string;
let log: string;
const records = (): Array<Record<string, unknown>> =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const descriptors = () => records().filter((r) => !("outcome_for" in r)) as unknown as Descriptor[];
const outcomes = () => records().filter((r) => "outcome_for" in r);

function clientWith(cmd: string, opts: { timeout?: number; maxRetries?: number } = {}): MetaApiClient {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", META_WRITE_GUARD_CMD: cmd };
  return new MetaApiClient({
    maxRetries: 0,
    ...opts,
    writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env, cwd: ROOT, timeoutMs: 15_000 })),
  });
}

function inCall<T>(tool: string, work: (ctx: CallContext) => Promise<T>, validateOnly = false, accounts: Iterable<string> = []) {
  const ctx = newCallContext(tool, validateOnly);
  for (const a of accounts) ctx.accounts.add(a);
  return { ctx, run: callContext.run(ctx, () => work(ctx)) };
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal, got a resolve");
}

// A small world: a campaign, an ad and their account.
function smallWorld(): Map<string, unknown> {
  return new Map<string, unknown>([
    [`/${CAMP}`, { id: CAMP, metadata: { type: "campaign" }, account_id: "9990000000000001", name: "c", status: "PAUSED", effective_status: "PAUSED", buying_type: "AUCTION", spend_cap: "100000" }],
    [`/${AD}`, { id: AD, metadata: { type: "ad" }, account_id: "9990000000000001", status: "PAUSED", campaign_id: CAMP }],
    [`/${ACT}`, { id: ACT, metadata: { type: "adaccount" }, spend_cap: "500000", amount_spent: "0", currency: "USD" }],
  ]);
}

beforeEach(() => {
  setupTestToken();
  calls = [];
  world = smallWorld();
  onWrite = () => mockFetchResponse({ success: true });
  installFetch();
  dir = mkdtempSync(join(tmpdir(), "wg-client-"));
  log = join(dir, "guard.log");
});

afterEach(() => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

describe("a guarded write, through the real gate", () => {
  it("reads, asks the guard, sends one POST, and records one outcome with the same request_id", async () => {
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "renamed" }));
    await expect(run).resolves.toEqual({ success: true });

    const methods = calls.map((c) => c.method);
    expect(methods.filter((m) => m === "POST")).toHaveLength(1);
    expect(methods.indexOf("POST")).toBe(methods.length - 1);
    expect(methods.slice(0, -1).length).toBeGreaterThan(0);
    const [d] = descriptors();
    expect(descriptors()).toHaveLength(1);
    expect(d).toMatchObject({ tool: "ads_update_campaign", method: "POST", path: `/${CAMP}`, params_keys: ["name"], object: { type: "campaign", id: CAMP } });
    expect(outcomes()).toEqual([{ v: "1.0", outcome_for: d.request_id, ok: true, meta_id: null, error: null }]);
    expect(ctx.sent).toEqual([
      { method: "POST", path: `/${CAMP}`, label: matchEndpoint("POST", `/${CAMP}`, "campaign")?.validate_only ?? null, ok: true, answer: '{"success":true}' },
    ]);
    expect(ctx.refusal).toBeNull();
    expect(ctx.accounts.has(ACT)).toBe(true);
  });

  it("gives Meta's id to the outcome", async () => {
    onWrite = () => mockFetchResponse({ id: "120000000000777" });
    const client = clientWith(stub("record", log));
    await inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" })).run;
    expect(outcomes()).toEqual([expect.objectContaining({ ok: true, meta_id: "120000000000777", error: null })]);
  });

  it("sends one outcome when Meta fails retryably twice and then answers", async () => {
    vi.spyOn(MetaApiClient.prototype as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
    onWrite = (_c, n) => (n < 3 ? mockFetchResponse({ message: "busy" }, { status: 503 }) : mockFetchResponse({ success: true }));
    const client = clientWith(stub("record", log), { maxRetries: 3 });
    await expect(inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" })).run).resolves.toEqual({ success: true });
    expect(writes()).toHaveLength(3);
    expect(descriptors()).toHaveLength(1);
    expect(outcomes()).toEqual([expect.objectContaining({ outcome_for: descriptors()[0].request_id, ok: true })]);
  });

  it("records ok:false with the message when the transport times out", async () => {
    onWrite = (c) =>
      new Promise<Response>((_, reject) => {
        c.init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    const client = clientWith(stub("record", log), { timeout: 100 });
    const { ctx, run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    expect(await refusalOf(run)).toBe("Request timeout after 100ms");
    expect(outcomes()).toEqual([{ v: "1.0", outcome_for: descriptors()[0].request_id, ok: false, meta_id: null, error: "Request timeout after 100ms" }]);
    expect(ctx.sent).toEqual([expect.objectContaining({ ok: false, answer: "Request timeout after 100ms" })]);
    expect(ctx.refusal).toBeNull();
  });

  it("refuses a write with no tool context, before the guard and any request", async () => {
    const client = clientWith(stub("record", log));
    expect(await refusalOf(client.postForm(`/${CAMP}`, { name: "x" }))).toBe(refused("no tool context"));
    expect(calls).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  it("refuses every later write in a call after one refusal, without asking the guard again", async () => {
    const s = scenarioFor(FIXTURES.find((f: { name: string }) => f.name === "cross-brand__source-ad"));
    world = s.gets;
    const cid = [...world.keys()].find((k) => k !== `/${AD}` && /^\/9997/.test(k))!;
    world.set(cid, new Error("fake Graph: the creative is unreadable"));
    for (const [k, v] of smallWorld()) if (!world.has(k)) world.set(k, v);
    const client = clientWith(stub("refuse-unresolved", log));
    const { ctx, run } = inCall("ads_duplicate_ad", async () => {
      const first = await refusalOf(client.postForm(s.path, s.params as Record<string, string>));
      const second = await refusalOf(client.postForm(`/${CAMP}`, { name: "x" }));
      return [first, second];
    });
    const [first, second] = await run;
    const reason = `rule 1: creative ${cid.slice(1)} (source_ad) is unresolved`;
    expect(first).toBe(refused(`guard denied: ${reason}`));
    expect(second).toBe(first);
    expect(ctx.refusal).toBe(first);
    expect(records()).toHaveLength(1);
    expect(writes()).toEqual([]);
  });

  it("after a validate_only write, a later write is stopped, which sets no refusal", async () => {
    const client = clientWith(stub("record", log));
    const vo = inCall("ads_update_campaign", async () => {
      await client.postForm(`/${CAMP}`, { name: "x" });
      return refusalOf(client.postForm(`/${CAMP}`, { name: "y" }));
    }, true);
    expect(await vo.run).toBe(refused("validate_only: later steps need the first write's result and were not sent"));
    expect(vo.ctx.refusal).toBeNull();
    expect(vo.ctx.validateOnlyStop).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(descriptors()).toHaveLength(1);
  });

  it("keeps the ack warning on the context", async () => {
    const nack = Buffer.from(JSON.stringify({ v: "1.0", allow: true, reason: "ok", basis: null, receipt: "r" }) + "\n").toString("base64url");
    const client = clientWith(stub("reply", nack));
    const { ctx, run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    await run;
    expect(ctx.warnings).toHaveLength(1);
    expect(ctx.warnings[0]).toMatch(/^guard outcome record for [0-9a-f-]{36} was not acknowledged$/);
  });
});

describe("static", () => {
  // client.ts's only lines naming the seam: its declaration in the config type and the constructor's read of it.
  const SEAM_LINES = [
    "writeGateForTests?: (get: GraphGet) => WriteGate;",
    "this.writeGate = config?.writeGateForTests ? config.writeGateForTests(get) : new RealWriteGate(get);",
  ];
  // The one other `ForTests` line in client.ts, older than the guard and unrelated to it (it resets the rate state).
  const OTHER_FOR_TESTS = ["resetForTests(): void {"];

  function srcFiles(): string[] {
    const files: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else files.push(p);
      }
    };
    walk(join(ROOT, "src"));
    return files;
  }
  const clientLines = () => readFileSync(join(ROOT, "src/meta/client.ts"), "utf8").split("\n").map((l) => l.trim());

  it("no file under src/ but client.ts mentions writeGateForTests", () => {
    const mentions = srcFiles()
      .filter((f) => relative(ROOT, f) !== "src/meta/client.ts")
      .flatMap((f) =>
        readFileSync(f, "utf8")
          .split("\n")
          .filter((l) => l.includes("writeGateForTests"))
          .map((l) => `${relative(ROOT, f)}: ${l.trim()}`),
      );
    expect(mentions).toEqual([]);
  });

  it("client.ts mentions writeGateForTests on exactly its declaration and the constructor's read, by any syntax", () => {
    // Shorthand ({ writeGateForTests }), a computed or quoted key, or a local of that name each add a line.
    expect(clientLines().filter((l) => l.includes("writeGateForTests"))).toEqual(SEAM_LINES);
    // A name built from pieces still spells ForTests somewhere.
    expect(clientLines().filter((l) => l.includes("ForTests"))).toEqual([...SEAM_LINES, ...OTHER_FOR_TESTS]);
  });

  it("the singleton is built with no argument, and is the only MetaApiClient src/ builds", () => {
    // No config means no spread and no gate-shaped argument can reach the constructor.
    expect(clientLines().filter((l) => l.includes("export const metaApiClient"))).toEqual([
      "export const metaApiClient = new MetaApiClient();",
    ]);
    const builds = srcFiles().flatMap((f) =>
      readFileSync(f, "utf8")
        .split("\n")
        .filter((l) => /new\s+MetaApiClient\b|MetaApiClient\s*\(/.test(l))
        .map((l) => `${relative(ROOT, f)}: ${l.trim()}`),
    );
    expect(builds).toEqual(["src/meta/client.ts: export const metaApiClient = new MetaApiClient();"]);
  });
});

describe("audiences.ts", () => {
  const unshare = async () => {
    const server = createMockMcpServer();
    registerAudienceTools(server as never);
    const tool = server._registeredTools.find((t: { name: string }) => t.name === "ads_unshare_custom_audience")!;
    return inCall("ads_unshare_custom_audience", () => tool.handler({ audience_id: "8001", ad_account_ids: ["act_1", "2"] }));
  };

  // The tool's own handler, on the singleton client and its pass-through gate (tests/setup-write-gate.ts): the
  // query-to-params rule is the client's encoding, which no gate changes.
  it("unshares with adaccounts in the query params", async () => {
    world.set("/8001", { id: "8001", metadata: { type: "customaudience" } });
    await (await unshare()).run;
    expect(writes()).toHaveLength(1);
    const [w] = writes();
    expect(w.method).toBe("DELETE");
    expect(w.path).toBe("/8001/adaccounts");
    expect(w.query.get("adaccounts")).toBe('["1","2"]');
  });

  // Its real-gate twin (T5-2's swap): DELETE /{id}/adaccounts has an empty key set, so with an allowing guard the
  // client refuses it after the allow (M11, ruled a-20261116-154225089; the real guard refuses that row, rule 8).
  it("through the real gate and an allowing guard, the client refuses adaccounts, zero Graph writes", async () => {
    world.set("/8001", { id: "8001", metadata: { type: "customaudience" } });
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", META_WRITE_GUARD_CMD: stub("record", log) };
    const singleton = metaApiClient as unknown as { writeGate: unknown };
    const pass = singleton.writeGate;
    singleton.writeGate = new RealWriteGate(
      (path, params) => metaApiClient.get(path, params),
      new GuardRunner({ env, cwd: ROOT, timeoutMs: 15_000 }),
    );
    const reason = "adaccounts is not a key of DELETE /{id}/adaccounts";
    let msg: string;
    try {
      msg = await refusalOf((await unshare()).run);
    } finally {
      singleton.writeGate = pass;
    }
    expect(msg).toBe(refused(reason));
    expect(writes()).toEqual([]);
    expect(descriptors()).toEqual([expect.objectContaining({ method: "DELETE", path: "/8001/adaccounts", params_keys: ["adaccounts"] })]);
    expect(outcomes()).toEqual([{ v: "1.0", outcome_for: descriptors()[0].request_id, ok: false, meta_id: null, error: reason }]);
  });
});

describe("P8: execution_options on the wire under validate_only, equal to the descriptor's params_keys", () => {
  const formKeys = (body: unknown) => [...new URLSearchParams(String(body)).keys()].sort();

  it("post (JSON): an array", async () => {
    const client = clientWith(stub("record", log));
    await inCall("ads_update_campaign", () => client.post(`/${CAMP}`, { name: "x" }), true).run;
    const body = JSON.parse(String(writes()[0].init?.body)) as Record<string, unknown>;
    expect(body.execution_options).toEqual(["validate_only"]);
    expect(Object.keys(body).sort()).toEqual([...descriptors()[0].params_keys].sort());
    expect(descriptors()[0].validate_only).toBe(true);
  });

  it("postForm: the string", async () => {
    const client = clientWith(stub("record", log));
    await inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }), true).run;
    const body = writes()[0].init?.body;
    expect(new URLSearchParams(String(body)).get("execution_options")).toBe('["validate_only"]');
    expect(formKeys(body)).toEqual([...descriptors()[0].params_keys].sort());
  });

  it("postMultipart: the string, appended to the caller's form, its names equal to params_keys", async () => {
    const client = clientWith(stub("record", log));
    // The file under name, a key of POST /{campaign_id}'s set (M11 refuses any other after the allow).
    const form = new FormData();
    form.append("name", new Blob(["x"]), "a.json");
    await inCall("ads_update_campaign", () => client.postMultipart(`/${CAMP}`, form), true).run;
    const sent = writes()[0].init?.body as FormData;
    expect(sent.get("execution_options")).toBe('["validate_only"]');
    expect([...sent.keys()].sort()).toEqual([...descriptors()[0].params_keys].sort());
    expect(sent.get("name")).toBeInstanceOf(Blob);
  });

  it("delete: in the query", async () => {
    const client = clientWith(stub("record", log));
    await inCall("ads_delete_ad", () => client.delete(`/${AD}`), true).run;
    const w = writes()[0];
    expect(w.query.get("execution_options")).toBe('["validate_only"]');
    expect([...w.query.keys()].filter((k) => k !== "appsecret_proof").sort()).toEqual([...descriptors()[0].params_keys].sort());
    expect(w.init?.body).toBeUndefined();
  });

  it("delete with formBody: in the body", async () => {
    const client = clientWith(stub("record", log));
    await inCall("ads_delete_ad", () => client.delete(`/${AD}`, undefined, undefined, { formBody: true }), true).run;
    const w = writes()[0];
    expect([...w.query.keys()]).toEqual(["appsecret_proof"]);
    expect(new URLSearchParams(String(w.init?.body)).get("execution_options")).toBe('["validate_only"]');
    expect(formKeys(w.init?.body)).toEqual([...descriptors()[0].params_keys].sort());
    expect((w.init?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
  });
});

describe("postForm sends the decoded value re-encoded, the one the descriptor saw, never the caller's text (R3)", () => {
  const FIRST = "9991000000000009";
  const LAST = "9991000000000001";
  it.each([
    ["a duplicate key", `{"object_story_spec":{"page_id":"${FIRST}","page_id":"${LAST}","link_data":{"name":"x"}}}`],
    ["non-canonical spacing", `  { "object_story_spec" : { "page_id" : "${LAST}" , "link_data" : { "name" : "x" } } }`],
  ])("%s", async (_name, creative) => {
    const client = clientWith(stub("record", log));
    await inCall("ads_create_ad", () => client.postForm(`/${ACT}/ads`, { name: "x", creative })).run;
    expect(writes()).toHaveLength(1);
    const wire = new URLSearchParams(String(writes()[0].init?.body)).get("creative");
    expect(wire).toBe(`{"object_story_spec":{"page_id":"${LAST}","link_data":{"name":"x"}}}`);
    expect(wire).not.toBe(creative);
    expect(wire).not.toContain(FIRST);
    // The descriptor described that page, and only it.
    const pages = descriptors()[0].identity.filter((e) => e.field === "object_story_spec.page_id").map((e) => e.id);
    expect(pages).toEqual([LAST]);
  });
});

describe("delete, the other form sender, also sends a decoded JSON field re-encoded (R3 sibling)", () => {
  // The pass-through gate: DELETE /{ad_id} admits no key, so the real gate refuses call_to_action there (M11).
  it.each([[false], [true]])("formBody %s", async (formBody) => {
    const client = new MetaApiClient({ maxRetries: 0, writeGateForTests: PASS });
    const text = ' { "type" : "a" , "type" : "b" } ';
    await inCall("ads_delete_ad", () => client.delete(`/${AD}`, { call_to_action: text }, undefined, formBody ? { formBody: true } : undefined)).run;
    expect(writes()).toHaveLength(1);
    const w = writes()[0];
    const sent = formBody ? new URLSearchParams(String(w.init?.body)).get("call_to_action") : w.query.get("call_to_action");
    expect(sent).toBe('{"type":"b"}');
  });
});

describe("P11: refusals through the real gate, zero Graph writes, the caller's text", () => {
  const cases: Array<[string, string, string, Record<string, string>, string]> = [
    ["ads_update_ad_set on a campaign id", "ads_update_ad_set", `/${CAMP}`, { name: "x" }, `ads_update_ad_set expects a adset, ${CAMP} is a campaign`],
    ["ads_update_campaign on an ad id", "ads_update_campaign", `/${AD}`, { name: "x" }, `ads_update_campaign expects a campaign, ${AD} is a ad`],
    ["a non-account tool on an account node", "ads_update_campaign", `/${ACT}`, { name: "x" }, `ads_update_campaign expects a campaign, ${ACT} is a account`],
    ["an unparseable creative", "ads_create_ad", `/${ACT}/ads`, { name: "x", creative: "{not json" }, "creative is not valid JSON"],
    ["a caller-supplied execution_options", "ads_update_campaign", `/${CAMP}`, { name: "x", execution_options: '["validate_only"]' }, "execution_options is set by the server for validate_only, never by the caller"],
  ];
  it.each(cases)("%s", async (_name, tool, path, params, detail) => {
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall(tool, () => client.postForm(path, params));
    expect(await refusalOf(run)).toBe(refused(detail));
    expect(ctx.refusal).toBe(refused(detail));
    expect(writes()).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  // Ruling R3: the refusing stub only, so its refusal shows.
  it.each([
    ["cross-brand__source-ad, its creative unreadable", "cross-brand__source-ad", "creative"],
    ["adset-deep-copy-two-brands, its ads listing failed", "adset-deep-copy-two-brands", "listing"],
  ])("a failed read: %s", async (_name, fixture, broken) => {
    const f = FIXTURES.find((x: { name: string }) => x.name === fixture);
    const s = scenarioFor(f);
    world = s.gets;
    const source = s.path.split("/")[1];
    let unresolved: string;
    if (broken === "creative") {
      const key = [...world.keys()].find((k) => /^\/9997/.test(k))!;
      world.set(key, new Error("fake Graph: unreadable"));
      unresolved = key.slice(1);
    } else {
      world.set(`/${source}/ads`, new Error("fake Graph: unreadable"));
      unresolved = source;
    }
    const client = clientWith(stub("refuse-unresolved", log));
    const tool = (f.descriptor as { tool: string }).tool;
    const { run } = inCall(tool, () => client.postForm(s.path, s.params as Record<string, string>), false, accountsOf(s));
    expect(await refusalOf(run)).toBe(refused(`guard denied: rule 1: creative ${unresolved} (source_ad) is unresolved`));
    expect(writes()).toEqual([]);
    expect(outcomes()).toEqual([]);
  });

  it("IP3: a builder that returns an invalid descriptor is refused as invalid descriptor", async () => {
    const good = (FIXTURES.find((x: { name: string }) => x.name === "a-paused-create").descriptor) as Descriptor;
    vi.spyOn(wd, "buildDescriptor").mockResolvedValue({ ...good, request_id: "" });
    const client = clientWith(stub("record", log));
    const { run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    expect(await refusalOf(run)).toBe(refused('invalid descriptor: descriptor.request_id is invalid: ""'));
    expect(writes()).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });
});

describe("P15(c): a guard that exits 0 before reading stdin", () => {
  it("refuses as output (ruling R3), with zero writes and no unhandled EPIPE", async () => {
    const client = clientWith(stub("epipe"));
    const { run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    expect(await refusalOf(run)).toBe(refused("guard output: exit 0 with no reply line"));
    expect(writes()).toEqual([]);
  });
});

describe("P14", () => {
  it("two writes in one call get two request_ids, each with its own outcome", async () => {
    const client = clientWith(stub("record", log));
    await inCall("ads_update_campaign", async () => {
      await client.postForm(`/${CAMP}`, { name: "a" });
      await client.postForm(`/${CAMP}`, { name: "b" });
    }).run;
    const ids = descriptors().map((d) => d.request_id);
    expect(ids).toHaveLength(2);
    expect(new Set(ids).size).toBe(2);
    expect(outcomes().map((o) => o.outcome_for)).toEqual(ids);
  });

  it("an outcome after a circuit-breaker refusal is ok:false", async () => {
    const client = clientWith(stub("record", log));
    const breaker = (client as unknown as { circuitBreaker: { trip: (c: unknown, k: unknown) => void } }).circuitBreaker;
    // The circuit opens after the guard allowed the write and before it is sent.
    const check = RealWriteGate.prototype.check;
    vi.spyOn(RealWriteGate.prototype, "check").mockImplementation(async function (this: RealWriteGate, ...args) {
      const allowed = await check.apply(this, args);
      breaker.trip(
        { tokenHash: hashToken("test-access-token"), accountId: CAMP, type: "ads_management" },
        { category: "abuse_signal", mcpError: new Error("abuse") },
      );
      return allowed;
    });
    const { run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    const msg = await refusalOf(run);
    expect(msg).toMatch(/Circuit open/);
    expect(writes()).toEqual([]);
    expect(outcomes()).toEqual([expect.objectContaining({ outcome_for: descriptors()[0].request_id, ok: false, meta_id: null, error: msg })]);
  });

  it("a write inside withPageToken is guarded, and sent with the Page token", async () => {
    world.set("/777", { id: "777", access_token: "page-token-for-tests" });
    const client = clientWith(stub("record", log));
    await inCall("ads_update_campaign", () => withPageToken("777", () => client.postForm(`/${CAMP}`, { name: "x" }))).run;
    expect(descriptors()).toHaveLength(1);
    expect(writes()).toHaveLength(1);
    expect((writes()[0].init?.headers as Record<string, string>).Authorization).toBe("Bearer page-token-for-tests");
  });

  it("the runner's defaults are /app and 20 000 ms", () => {
    const gate = new RealWriteGate(async () => ({}) as never);
    expect(gate.runner.cwd).toBe("/app");
    expect(gate.runner.timeoutMs).toBe(20_000);
    const plain = new MetaApiClient() as unknown as { writeGate: RealWriteGate };
    expect(plain.writeGate).toBeInstanceOf(RealWriteGate);
    expect(plain.writeGate.runner.cwd).toBe("/app");
    expect(plain.writeGate.runner.timeoutMs).toBe(20_000);
  });
});

// Contract ruling a-20261116-131104270: one guard call per request_id; a resend reuses the verdict; a refused or
// failed guard call is never resent and sends nothing.
describe("the guard is asked once per request_id, above the resend loop", () => {
  it("a first attempt that fails retryably and a second that succeeds: one guard call, one outcome, one request_id", async () => {
    vi.spyOn(MetaApiClient.prototype as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
    onWrite = (_c, n) => (n === 1 ? mockFetchResponse({ message: "busy" }, { status: 503 }) : mockFetchResponse({ success: true }));
    const client = clientWith(stub("record", log), { maxRetries: 3 });
    await inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" })).run;
    expect(writes()).toHaveLength(2);
    expect(records()).toHaveLength(2);
    const [d] = descriptors();
    expect(outcomes()).toEqual([expect.objectContaining({ outcome_for: d.request_id, ok: true })]);
  });

  it("a refused guard call sends nothing and is not asked again", async () => {
    vi.spyOn(MetaApiClient.prototype as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
    const s = scenarioFor(FIXTURES.find((f: { name: string }) => f.name === "cross-brand__source-ad"));
    world = s.gets;
    const cid = [...world.keys()].find((k) => /^\/9997/.test(k))!;
    world.set(cid, new Error("fake Graph: unreadable"));
    const client = clientWith(stub("refuse-unresolved", log), { maxRetries: 3 });
    const { run } = inCall("ads_duplicate_ad", () => client.postForm(s.path, s.params as Record<string, string>), false, accountsOf(s));
    expect(await refusalOf(run)).toMatch(/^MCP error -32600: write refused: guard denied: /);
    expect(writes()).toEqual([]);
    expect(records()).toHaveLength(1);
  });

  it.each([
    ["exit", () => stub("exit1"), "guard exit: the guard exited 1"],
    ["timeout", () => stub("hang"), "guard timeout: no reply in 300 ms (killed, SIGKILL)"],
  ])("a guard that fails (%s) sends nothing", async (_cls, cmd, detail) => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", META_WRITE_GUARD_CMD: cmd() };
    const runner = new GuardRunner({ env, cwd: ROOT, timeoutMs: 300 });
    const decide = vi.spyOn(runner, "decide");
    const client = new MetaApiClient({ maxRetries: 3, writeGateForTests: (get) => new RealWriteGate(get, runner) });
    vi.spyOn(MetaApiClient.prototype as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
    const { run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    expect(await refusalOf(run)).toBe(refused(detail));
    expect(writes()).toEqual([]);
    expect(decide).toHaveBeenCalledTimes(1);
  });
});

// T5-1 and its sweep: one case each that only its rule decides.
describe("deciding cases", () => {
  it.each([
    ["Execution_Options", '["validate_only"]'],
    ["EXECUTION_OPTIONS", '["validate_only"]'],
    ["execution_options[0]", "validate_only"],
    ["Execution_Options[]", "validate_only"],
  ])("refuses a caller's %s", async (key, value) => {
    const client = clientWith(stub("record", log));
    const { run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x", [key]: value }));
    expect(await refusalOf(run)).toBe(refused("execution_options is set by the server for validate_only, never by the caller"));
    expect(calls).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  it.each([
    ["a 19-digit integer", '{"object_story_spec":{"page_id":1234567890123456789}}'],
    ["a 23-digit decimal", '{"object_story_spec":{"link_data":{"name":"x"}},"x":0.12345678901234567890123}'],
    ["1e999", '{"object_story_spec":{"page_id":1e999}}'],
  ])("refuses a decoded number that is not sent exactly as written: %s", async (_name, creative) => {
    const client = clientWith(stub("record", log));
    const { run } = inCall("ads_create_ad", () => client.postForm(`/${ACT}/ads`, { name: "x", creative }));
    expect(await refusalOf(run)).toBe(refused("creative holds a number that cannot be sent exactly as written (send ids as strings)"));
    expect(calls).toEqual([]);
  });

  it("takes an exact decoded number, safe integers and short decimals", async () => {
    const client = clientWith(stub("record", log));
    const creative = '{"object_story_spec":{"page_id":"9991000000000001","link_data":{"name":"x"}},"name":12,"url_tags":0.5}';
    await inCall("ads_create_ad", () => client.postForm(`/${ACT}/ads`, { name: "x", creative })).run;
    expect(writes()).toHaveLength(1);
  });

  it.each([
    ["postForm", NaN],
    ["postForm", Infinity],
    ["post", -Infinity],
  ] as const)("refuses a non-finite number in %s (%s)", async (m, n) => {
    const client = clientWith(stub("record", log));
    const { run } = inCall("ads_update_campaign", () => (m === "post" ? client.post(`/${CAMP}`, { daily_budget: n }) : client.postForm(`/${CAMP}`, { daily_budget: n })));
    expect(await refusalOf(run)).toBe(refused(`daily_budget holds a number that cannot be sent (${String(n)})`));
    expect(calls).toEqual([]);
  });

  const own = (key: string, value: unknown) => Object.fromEntries([[key, value], ["name", "x"]]);
  it.each(["__proto__", "constructor", "prototype"])("refuses a field named %s in a form, JSON, multipart or nested body", async (name) => {
    const client = clientWith(stub("record", log));
    const form = new FormData();
    form.append(name, "x");
    form.append("name", "y");
    const attempts = [
      () => client.postForm(`/${CAMP}`, own(name, "x") as Record<string, string>),
      () => client.post(`/${CAMP}`, own(name, 1)),
      () => client.post(`/${CAMP}`, { name: "x", targeting: JSON.parse(`{"${name}": {"a": 1}}`) }),
      () => client.postMultipart(`/${CAMP}`, form),
      () => client.postForm(`/${ACT}/ads`, { name: "x", creative: `{"${name}":{"a":1}}` }),
      () => client.delete(`/${CAMP}`, own(name, "x") as Record<string, string>),
    ];
    for (const attempt of attempts) {
      const { run } = inCall("ads_update_campaign", attempt);
      expect(await refusalOf(run)).toBe(refused(`a field named ${name} is not allowed`));
    }
    expect(calls).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  it("scrubs the token and the proof from Meta's answer in ctx.sent", async () => {
    const token = "test-access-token";
    const proof = createHmac("sha256", TEST_APP_SECRET).update(token).digest("hex");
    onWrite = () => mockFetchResponse({ success: true, echo: `${token} ${proof} appsecret_proof=${proof}` });
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    await run;
    expect(ctx.sent).toHaveLength(1);
    expect(ctx.sent[0].answer).not.toContain(token);
    expect(ctx.sent[0].answer).not.toContain(proof);
    expect(ctx.sent[0].answer).toContain("[REDACTED]");
  });

  it("scrubs the token and the proof from a thrown error in the outcome and ctx.sent", async () => {
    const token = "test-access-token";
    const proof = createHmac("sha256", TEST_APP_SECRET).update(token).digest("hex");
    type Exec = (this: MetaApiClient, m: string, ...rest: unknown[]) => Promise<unknown>;
    const proto = MetaApiClient.prototype as unknown as { execute: Exec };
    const real = proto.execute;
    vi.spyOn(proto, "execute").mockImplementation(function (this: MetaApiClient, m: string, ...rest: unknown[]) {
      if (m === "GET") return real.call(this, m, ...rest);
      return Promise.reject(new Error(`boom ${token} ${proof}`));
    });
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    await refusalOf(run);
    const [o] = outcomes();
    expect(o.ok).toBe(false);
    for (const text of [String(o.error), ctx.sent[0].answer]) {
      expect(text).toBe("boom [REDACTED] [REDACTED]");
    }
  });

  it("does not list a write that execute refused, and still records its outcome ok:false", async () => {
    type Exec = (this: MetaApiClient, m: string, ...rest: unknown[]) => Promise<unknown>;
    const proto = MetaApiClient.prototype as unknown as { execute: Exec };
    const real = proto.execute;
    vi.spyOn(proto, "execute").mockImplementation(function (this: MetaApiClient, m: string, ...rest: unknown[]) {
      if (m === "GET") return real.call(this, m, ...rest);
      return Promise.reject(new wd.WriteRefusal("late refusal"));
    });
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    expect(await refusalOf(run)).toBe(refused("late refusal"));
    expect(ctx.sent).toEqual([]);
    expect(ctx.refusal).toBe(refused("late refusal"));
    expect(outcomes()).toEqual([expect.objectContaining({ ok: false, error: refused("late refusal") })]);
  });

  it("keeps the call's first refusal when a later request is refused too", async () => {
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall("ads_update_campaign", async () => {
      await refusalOf(client.postForm(`/${CAMP}`, { name: "x", execution_options: "x" }));
      await refusalOf(client.get(`/${CAMP}`, { method: "DELETE" }));
    });
    await run;
    expect(ctx.refusal).toBe(refused("execution_options is set by the server for validate_only, never by the caller"));
  });

  it("stops later writes after a validate_only write that Meta refused", async () => {
    onWrite = () => graphError("invalid");
    const client = clientWith(stub("record", log));
    const { ctx, run } = inCall("ads_update_campaign", async () => {
      await refusalOf(client.postForm(`/${CAMP}`, { name: "x" }));
      return refusalOf(client.postForm(`/${CAMP}`, { name: "y" }));
    }, true);
    expect(await run).toBe(refused("validate_only: later steps need the first write's result and were not sent"));
    expect(ctx.validateOnlyStop).toBe(true);
    expect(writes()).toHaveLength(1);
  });

  it("converts a builder failure that is not a refusal into one", async () => {
    vi.spyOn(wd, "buildDescriptor").mockRejectedValue(new TypeError("boom\nline"));
    const client = clientWith(stub("record", log));
    const { run } = inCall("ads_update_campaign", () => client.postForm(`/${CAMP}`, { name: "x" }));
    expect(await refusalOf(run)).toBe(refused("the descriptor could not be built: boom line"));
    expect(writes()).toEqual([]);
    expect(existsSync(log)).toBe(false);
  });

  it("post with no body sends none, and under validate_only sends only execution_options", async () => {
    const client = clientWith(stub("record", log));
    await inCall("ads_update_campaign", () => client.post(`/${CAMP}`)).run;
    await inCall("ads_update_campaign", () => client.post(`/${CAMP}`), true).run;
    expect(writes()[0].init?.body).toBeUndefined();
    expect(JSON.parse(String(writes()[1].init?.body))).toEqual({ execution_options: ["validate_only"] });
  });
});
