// Every vendored fixture 253 drives, end to end (ticket 253, Task 7): the fork's real client, with the real gate
// (RealWriteGate and GuardRunner), builds each fixture's descriptor from the fixture's scenario
// (tests/fixtures/meta-ads-guard/harness.ts) and asks the vendored fake guard, which answers only a descriptor that
// `normalise`s equal to a fixture's. The fake runs behind stubs/tee-stderr.mjs, whose log shows which fixture it
// matched and every message the fork sent. Contract docs/contracts/meta-ads-guard.md@1.0 §2, §8, §9, §10, §13.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MetaApiClient } from "../../src/meta/client.js";
import { GuardRunner, RealWriteGate, callContext, newCallContext, type CallContext } from "../../src/meta/write-guard.js";
import { answer, loadFixtures, validateOutcome, type Fixture } from "../fixtures/meta-ads-guard/fake-guard.mjs";
import { SKIPPED, accountsOf, answerGet, scenarioFor, type Scenario } from "../fixtures/meta-ads-guard/harness.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const GUARD_DIR = join(ROOT, "tests/fixtures/meta-ads-guard");
const FAKE = join(GUARD_DIR, "fake-guard.mjs");
const FIXTURE_DIR = join(GUARD_DIR, "fixtures");
const TEE = join(GUARD_DIR, "stubs/tee-stderr.mjs");
const FIXTURES = loadFixtures(FIXTURE_DIR);
const byName = (name: string): Fixture => {
  const f = FIXTURES.find((x) => x.name === name);
  if (!f) throw new Error(`no fixture ${name}`);
  return f;
};
const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

const CREATED_ID = "9990000000099999";

// The fork's refusal for each `fork__` fixture: the fake's reply (its `fake` block) read by the runner (§8).
const FORK_MESSAGES: Readonly<Record<string, (f: Fixture) => string>> = {
  "fork__allow-string": () => refused("guard denied: allowed"),
  "fork__empty-receipt": () => refused("guard receipt: the allow reply has no receipt"),
  "fork__nonzero-exit": (f) => refused(`guard exit: the guard exited ${f.fake!.exit}`),
  "fork__not-json": () => refused("guard output: the reply is not JSON"),
  "fork__two-lines": () => refused("guard output: the reply is more than one line"),
  "fork__wrong-v": () => refused('guard version: reply v is "2.0", not "1.0"'),
  "fork__timeout": () => refused(`guard timeout: no reply in ${TIMEOUT_MS} ms (killed, SIGKILL)`),
};
// Below fork__timeout's delay_ms (21000), above the fake's own start-up and match.
const TIMEOUT_MS = 3_000;
// Each case runs the guard (two node processes) twice: past vitest's 5 s default when the full suite loads the CPU.
const GUARD_TEST_MS = 30_000;

// ---- the fake Graph: GETs answered from the scenario, the write from its kind, every call recorded ----

interface Sent {
  method: string;
  path: string;
  init?: RequestInit;
}
let calls: Sent[];
let gets: ReadonlyMap<string, unknown>;
let writeAnswer: unknown;

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const c: Sent = { method: init?.method ?? "GET", path: url.pathname.replace(/^\/v\d+\.\d+/, ""), init };
      calls.push(c);
      if (c.method !== "GET") return mockFetchResponse(writeAnswer);
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== "appsecret_proof") params[k] = v;
      try {
        return mockFetchResponse(answerGet(gets, c.path, params));
      } catch (e) {
        return mockFetchResponse({ error: { code: 100, type: "OAuthException", message: (e as Error).message } }, { status: 400 });
      }
    }),
  );
}
const writes = () => calls.filter((c) => c.method !== "GET");

// ---- the guard: the vendored fake, behind the stderr wrapper ----

let dir: string;
let log: string;
interface Run {
  stdin: string;
  stderr: string;
  exit: number;
}
const runs = (): Run[] =>
  existsSync(log) ? readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l) as Run) : [];
const asks = () => runs().filter((r) => !("outcome_for" in JSON.parse(r.stdin)));
const outcomeRuns = () => runs().filter((r) => "outcome_for" in JSON.parse(r.stdin));

function clientWith(cmd: string, timeoutMs = 15_000): MetaApiClient {
  // The guard env passes only PATH, HOME, NODE_* and NOTION_API_KEY (§2): every stub option is in argv.
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp", META_WRITE_GUARD_CMD: cmd };
  // The real gate and runner; only the runner's cwd (§2: /app, absent here) and timeout are the test's.
  return new MetaApiClient({
    maxRetries: 0,
    writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env, cwd: ROOT, timeoutMs })),
  });
}
const teeCmd = () => ["node", TEE, log, "--", "node", FAKE, "--fixtures", FIXTURE_DIR].join(" ");

// The params as the fork's tools send them: a form, objects as JSON text; a multipart form for an image upload.
function formOf(params: Record<string, unknown>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(params)) out[k] = typeof v === "string" ? v : typeof v === "object" ? JSON.stringify(v) : String(v);
  return out;
}

/** Sends the scenario's write through `client` inside a tool call, as the fixture's tool would. */
function drive(client: MetaApiClient, f: Fixture, s: Scenario): { ctx: CallContext; run: Promise<unknown> } {
  const d = f.descriptor as { tool: string; validate_only: boolean };
  // validate_only is the call's (§7): the client adds execution_options itself and refuses a caller's.
  const ctx = newCallContext(d.tool, d.validate_only);
  for (const a of accountsOf(s)) ctx.accounts.add(a);
  const { execution_options: _vo, ...params } = s.params;
  const form = formOf(params);
  const run = callContext.run(ctx, () => {
    if (s.method === "DELETE") return client.delete(s.path, form);
    if (/\/adimages$/.test(s.path)) {
      const fd = new FormData();
      for (const [k, v] of Object.entries(form)) {
        if (k === "filename") fd.set(k, new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "a.png");
        else fd.set(k, v);
      }
      return client.postMultipart(s.path, fd);
    }
    return client.postForm(s.path, form);
  });
  return { ctx, run };
}

async function refusalOf(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected a refusal, got a resolve");
}

function setUp(f: Fixture): Scenario {
  const s = scenarioFor(f);
  gets = s.gets;
  writeAnswer = (f.descriptor as { object: { created: boolean } }).object.created ? { id: CREATED_ID } : { success: true };
  return s;
}

beforeEach(() => {
  setupTestToken();
  calls = [];
  installFetch();
  dir = mkdtempSync(join(tmpdir(), "wg-fixtures-"));
  log = join(dir, "guard.log");
});

afterEach(() => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const driven = FIXTURES.filter((f) => f.descriptor && !Object.hasOwn(SKIPPED, f.name));
const ran = new Set<string>();

describe("for: both — the fake names the fixture, and the fork obeys its reply", { timeout: GUARD_TEST_MS }, () => {
  const both = driven.filter((f) => f.for === "both");

  it.each(both.map((f) => [f.name, f] as const))("%s", async (name, f) => {
    const s = setUp(f);
    const reply = f.reply as { allow: boolean; reason: string };
    const { ctx, run } = drive(clientWith(teeCmd()), f, s);

    if (reply.allow) {
      await expect(run).resolves.toEqual(writeAnswer);
      // Ruling a-20261116-131104270: one ask per request_id; one write; one outcome record with that request_id.
      expect(asks().map((r) => r.stderr)).toEqual([`fixture: ${name}\n`]);
      expect(writes()).toHaveLength(1);
      expect(writes()[0].method).toBe(s.method);
      const asked = JSON.parse(asks()[0].stdin) as { request_id: string };
      const outcomes = outcomeRuns().map((r) => JSON.parse(r.stdin) as Record<string, unknown>);
      expect(outcomes).toHaveLength(1);
      expect(outcomes[0].outcome_for).toBe(asked.request_id);
      expect(ctx.warnings).toEqual([]);
    } else {
      expect(await refusalOf(run)).toBe(refused(`guard denied: ${reply.reason}`));
      expect(asks().map((r) => r.stderr)).toEqual([`fixture: ${name}\n`]);
      expect(writes()).toEqual([]);
      expect(outcomeRuns()).toEqual([]);
    }
    ran.add(name);
  });
});

describe("for: fork — the fork refuses each bad reply, and sends nothing", { timeout: GUARD_TEST_MS }, () => {
  const fork = driven.filter((f) => f.for === "fork" && f.name !== "fork__timeout");

  it("FORK_MESSAGES names exactly the fork fixtures", () => {
    expect(Object.keys(FORK_MESSAGES).sort()).toEqual(FIXTURES.filter((f) => f.for === "fork").map((f) => f.name).sort());
  });

  it.each(fork.map((f) => [f.name, f] as const))("%s", async (name, f) => {
    const s = setUp(f);
    const { run } = drive(clientWith(teeCmd()), f, s);
    expect(await refusalOf(run)).toBe(FORK_MESSAGES[name](f));
    expect(asks().map((r) => r.stderr)).toEqual([`fixture: ${name}\n`]);
    expect(writes()).toEqual([]);
    expect(outcomeRuns()).toEqual([]);
    ran.add(name);
  });

  it("fork__timeout: the fake itself, no wrapper, killed at the runner's timeout; no process is left", async () => {
    const f = byName("fork__timeout");
    expect(f.fake!.delay_ms).toBeGreaterThan(TIMEOUT_MS);
    // A fixtures directory unique to this run, so the fake's process is found by its argv.
    const fixtures = join(dir, "fixtures");
    symlinkSync(FIXTURE_DIR, fixtures);
    const s = setUp(f);
    const started = Date.now();
    const { run } = drive(clientWith(["node", FAKE, "--fixtures", fixtures].join(" "), TIMEOUT_MS), f, s);
    expect(await refusalOf(run)).toBe(FORK_MESSAGES["fork__timeout"](f));
    expect(Date.now() - started).toBeLessThan(f.fake!.delay_ms!);
    expect(writes()).toEqual([]);
    const ps = execFileSync("ps", ["-eo", "args"], { encoding: "utf8" });
    expect(ps.split("\n").filter((l) => l.includes(fixtures))).toEqual([]);
    ran.add(f.name);
  });
});

describe("outcome-record", { timeout: GUARD_TEST_MS }, () => {
  it("an allowed write's outcome record passes validateOutcome, has the fixture's keys, and gets the fake's ack", async () => {
    const fixture = byName("outcome-record");
    const f = byName("a-paused-create");
    const s = setUp(f);
    const { ctx, run } = drive(clientWith(teeCmd()), f, s);
    await expect(run).resolves.toEqual({ id: CREATED_ID });

    const [record] = outcomeRuns().map((r) => JSON.parse(r.stdin) as Record<string, unknown>);
    expect(validateOutcome(record)).toEqual([]);
    expect(Object.keys(record).sort()).toEqual(Object.keys(fixture.outcome as object).sort());
    expect(record).toEqual({ v: "1.0", outcome_for: JSON.parse(asks()[0].stdin).request_id, ok: true, meta_id: CREATED_ID, error: null });
    // The fake acks it as the fixture shows, and the runner took that ack: no warning.
    const ack = fixture.ack as Record<string, unknown>;
    expect(JSON.parse(answer(JSON.stringify(record), FIXTURES).stdout)).toEqual({ ...ack, receipt: `fake-outcome-${record.outcome_for}` });
    expect(ctx.warnings).toEqual([]);
    ran.add(fixture.name);
  });
});

// Last in the file (cases run in order): every fixture was driven or skipped by name, none both, none neither.
describe("skips", () => {
  it("SKIPPED names exactly the twelve, each a vendored fixture", () => {
    expect(Object.keys(SKIPPED).sort()).toEqual([
      "account-limit-flag-wrong",
      "act-path-other-account",
      "cross-brand__asset_feed_spec",
      "garden3d-mixed-both",
      "identity-key-no-entry",
      "invalid__unknown-identity-field",
      "invalid__unknown-key",
      "kind-mismatch",
      "null-ad-account",
      "unknown-kind-no-campaign",
      "unresolved-campaign",
      "vo-mismatch",
    ]);
    const names = new Set(FIXTURES.map((f) => f.name));
    for (const name of Object.keys(SKIPPED)) expect(names.has(name)).toBe(true);
  });

  it("every other fixture ran, and passed", () => {
    const skipped = Object.keys(SKIPPED);
    expect(skipped.filter((n) => ran.has(n))).toEqual([]);
    expect(FIXTURES.map((f) => f.name).filter((n) => !ran.has(n) && !skipped.includes(n))).toEqual([]);
    expect(ran.size + skipped.length).toBe(FIXTURES.length);
  });
});
