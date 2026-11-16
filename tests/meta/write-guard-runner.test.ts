import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { ErrorCode } from "@modelcontextprotocol/sdk/types.js";

import { WriteRefusal, type Descriptor, type OutcomeRecord } from "../../src/meta/write-descriptor.js";
import { GuardRunner, callContext, guardEnv, newCallContext } from "../../src/meta/write-guard.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STUBS = join(ROOT, "tests/fixtures/meta-ads-guard/stubs");
const stub = (name: string, ...args: string[]) => ["node", join(STUBS, `${name}.mjs`), ...args].join(" ");
const replying = (text: string) => stub("reply", Buffer.from(text, "utf8").toString("base64url"));

const DESCRIPTOR: Descriptor = JSON.parse(
  readFileSync(join(ROOT, "tests/fixtures/meta-ads-guard/fixtures/a-paused-create.json"), "utf8"),
).descriptor;

const OUTCOME: OutcomeRecord = { v: "1.0", outcome_for: DESCRIPTOR.request_id, ok: true, meta_id: "120000000000001", error: null };

function runner(cmd: string | undefined, extra: Partial<{ timeoutMs: number; maxOutputBytes: number }> = {}) {
  const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME ?? "/tmp" };
  if (cmd !== undefined) env.META_WRITE_GUARD_CMD = cmd;
  return new GuardRunner({ env, cwd: ROOT, ...extra });
}

async function refusal(p: Promise<unknown>): Promise<string> {
  try {
    await p;
  } catch (e) {
    expect(e).toBeInstanceOf(WriteRefusal);
    // McpError prefixes its message; what follows is the refusal text itself.
    const prefix = `MCP error ${ErrorCode.InvalidRequest}: `;
    const msg = (e as Error).message;
    expect(msg.startsWith(prefix)).toBe(true);
    return msg.slice(prefix.length);
  }
  throw new Error("expected a refusal, got a resolve");
}

const ALLOW_LINE = { v: "1.0", allow: true, reason: "ok", basis: "non-spending", receipt: "r-1" };
const line = (o: unknown) => JSON.stringify(o) + "\n";

describe("guardEnv", () => {
  it("passes exactly PATH, HOME, NODE_* and NOTION_API_KEY, each only if set", () => {
    expect(
      guardEnv({
        PATH: "/bin",
        HOME: "/home/x",
        NODE_X: "1",
        NODE_OPTIONS: "",
        NOTION_API_KEY: "k",
        META_ACCESS_TOKEN: "t",
        META_APP_SECRET: "s",
        META_WRITE_GUARD_CMD: "c",
        OTHER: "o",
        XNODE_Y: "n",
      }),
    ).toEqual({ PATH: "/bin", HOME: "/home/x", NODE_X: "1", NODE_OPTIONS: "", NOTION_API_KEY: "k" });
    expect(guardEnv({ OTHER: "o", NODE_X: undefined })).toEqual({});
  });
});

describe("GuardRunner.decide", () => {
  it("allows on exit 0, one line, v 1.0, allow true and a receipt", async () => {
    await expect(runner(stub("allow")).decide(DESCRIPTOR)).resolves.toEqual({
      reason: "stub allows",
      basis: "non-spending",
      receipt: "stub-receipt",
    });
  });

  it("env-dump: the guard sees only PATH, HOME, NODE_X and NOTION_API_KEY", async () => {
    const env: NodeJS.ProcessEnv = {
      PATH: process.env.PATH,
      HOME: "/home/guard",
      NODE_X: "1",
      NOTION_API_KEY: "notion-test-value",
      META_ACCESS_TOKEN: "meta-test-value",
      META_APP_SECRET: "app-test-value",
      META_WRITE_GUARD_CMD: stub("env-dump"),
      OTHER: "other",
    };
    const r = await new GuardRunner({ env, cwd: ROOT }).decide(DESCRIPTOR);
    expect(new Set(JSON.parse(r.receipt))).toEqual(new Set(["PATH", "HOME", "NODE_X", "NOTION_API_KEY"]));
  });

  it("stdin-dump: the descriptor arrives as one JSON line and stdin is closed", async () => {
    const r = await runner(stub("stdin-dump"), { timeoutMs: 5_000 }).decide(DESCRIPTOR);
    expect(r.receipt).toBe(JSON.stringify(DESCRIPTOR) + "\n");
    expect(JSON.parse(r.receipt)).toEqual(DESCRIPTOR);
  });

  it("reads META_WRITE_GUARD_CMD at each call", async () => {
    const env: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: "/h" };
    const r = new GuardRunner({ env, cwd: ROOT });
    expect(await refusal(r.decide(DESCRIPTOR))).toMatch(/^write refused: guard unset: /);
    env.META_WRITE_GUARD_CMD = stub("allow");
    await expect(r.decide(DESCRIPTOR)).resolves.toMatchObject({ receipt: "stub-receipt" });
  });

  it("unset → unset", async () => {
    expect(await refusal(runner(undefined).decide(DESCRIPTOR))).toMatch(/^write refused: guard unset: /);
  });

  it("empty → unset", async () => {
    expect(await refusal(runner("").decide(DESCRIPTOR))).toMatch(/^write refused: guard unset: /);
  });

  it("missing binary → spawn", async () => {
    expect(await refusal(runner("/nonexistent/meta-ads-guard-253").decide(DESCRIPTOR))).toMatch(
      /^write refused: guard spawn: /,
    );
  });

  it("doubled spaces in the command refuse", async () => {
    const cmd = `node  ${join(STUBS, "allow.mjs")}`;
    expect(await refusal(runner(cmd).decide(DESCRIPTOR))).toMatch(/^write refused: guard spawn: /);
  });

  it("exit 1 → exit, even with an allow line on stdout", async () => {
    expect(await refusal(runner(stub("exit1")).decide(DESCRIPTOR))).toMatch(/^write refused: guard exit: /);
  });

  it("two lines → output", async () => {
    expect(await refusal(runner(stub("two-lines")).decide(DESCRIPTOR))).toMatch(/^write refused: guard output: /);
  });

  it("not JSON → output", async () => {
    expect(await refusal(runner(replying("allow\n")).decide(DESCRIPTOR))).toMatch(/^write refused: guard output: /);
  });

  it("JSON that is not an object → output", async () => {
    expect(await refusal(runner(replying("[1]\n")).decide(DESCRIPTOR))).toMatch(/^write refused: guard output: /);
  });

  it("a lone newline → output", async () => {
    expect(await refusal(runner(replying("\n")).decide(DESCRIPTOR))).toMatch(/^write refused: guard output: /);
  });

  it("a reply without its trailing newline still allows", async () => {
    await expect(runner(replying(JSON.stringify(ALLOW_LINE))).decide(DESCRIPTOR)).resolves.toMatchObject({
      receipt: "r-1",
    });
  });

  it('v "2.0" → version', async () => {
    expect(await refusal(runner(replying(line({ ...ALLOW_LINE, v: "2.0" }))).decide(DESCRIPTOR))).toMatch(
      /^write refused: guard version: /,
    );
  });

  it('allow "true" → denied', async () => {
    expect(await refusal(runner(replying(line({ ...ALLOW_LINE, allow: "true" }))).decide(DESCRIPTOR))).toMatch(
      /^write refused: guard denied: /,
    );
  });

  it("allow false → denied, the reason passed through verbatim", async () => {
    const reason = "rule 8: kind other on /120000000000001/insights";
    const msg = await refusal(
      runner(replying(line({ v: "1.0", allow: false, reason, basis: null, receipt: "r-2" }))).decide(DESCRIPTOR),
    );
    expect(msg).toBe(`write refused: guard denied: ${reason}`);
  });

  it("receipt missing → receipt", async () => {
    const { receipt: _r, ...noReceipt } = ALLOW_LINE;
    expect(await refusal(runner(replying(line(noReceipt))).decide(DESCRIPTOR))).toMatch(
      /^write refused: guard receipt: /,
    );
  });

  it('receipt "" → receipt', async () => {
    expect(await refusal(runner(replying(line({ ...ALLOW_LINE, receipt: "" }))).decide(DESCRIPTOR))).toMatch(
      /^write refused: guard receipt: /,
    );
  });

  describe("hang", () => {
    let dir: string;
    beforeEach(() => {
      dir = mkdtempSync(join(tmpdir(), "guard-hang-"));
    });
    afterEach(() => {
      rmSync(dir, { recursive: true, force: true });
    });

    it("hang → timeout within 2 s, the guard killed by SIGKILL", async () => {
      const pidFile = join(dir, "pid");
      const start = Date.now();
      const msg = await refusal(runner(stub("hang", pidFile), { timeoutMs: 500 }).decide(DESCRIPTOR));
      expect(Date.now() - start).toBeLessThan(2_000);
      expect(msg).toMatch(/^write refused: guard timeout: /);
      expect(msg).toContain("SIGKILL");
      // The stub ignores SIGTERM, so it is gone only if SIGKILL reached it.
      const pid = Number(readFileSync(pidFile, "utf8"));
      expect(() => process.kill(pid, 0)).toThrow(expect.objectContaining({ code: "ESRCH" }));
    });
  });

  it("flood → output", async () => {
    expect(await refusal(runner(stub("flood")).decide(DESCRIPTOR))).toMatch(/^write refused: guard output: /);
  });

  it("EPIPE: a guard that exits 0 before reading a large descriptor → output, nothing thrown past the runner", async () => {
    const errors: unknown[] = [];
    const onErr = (e: unknown) => errors.push(e);
    process.on("uncaughtException", onErr);
    process.on("unhandledRejection", onErr);
    try {
      const big: Descriptor = {
        ...DESCRIPTOR,
        params_keys: Array.from({ length: 200_000 }, (_, i) => `param_key_${i}`),
      };
      expect(JSON.stringify(big).length).toBeGreaterThan(1_000_000);
      expect(await refusal(runner(stub("epipe")).decide(big))).toMatch(/^write refused: guard output: /);
      await new Promise((r) => setTimeout(r, 50));
      expect(errors).toEqual([]);
    } finally {
      process.off("uncaughtException", onErr);
      process.off("unhandledRejection", onErr);
    }
  });
});

describe("GuardRunner.sendOutcome", () => {
  it("an ack → null", async () => {
    await expect(runner(stub("allow")).sendOutcome(OUTCOME)).resolves.toBeNull();
  });

  it("a non-ack → a one-line warning", async () => {
    const w = await runner(replying(line({ v: "1.0", ack: false, receipt: "r" }))).sendOutcome(OUTCOME);
    expect(w).toEqual(expect.any(String));
    expect(w).not.toContain("\n");
  });

  it("an ack without a receipt → a warning", async () => {
    const w = await runner(replying(line({ v: "1.0", ack: true, receipt: "" }))).sendOutcome(OUTCOME);
    expect(w).toEqual(expect.any(String));
  });

  it('an ack with v "2.0" → a warning', async () => {
    const w = await runner(replying(line({ v: "2.0", ack: true, receipt: "r" }))).sendOutcome(OUTCOME);
    expect(w).toEqual(expect.any(String));
  });

  it("never throws: unset, spawn failure and exit 1 all warn", async () => {
    for (const cmd of [undefined, "/nonexistent/meta-ads-guard-253", stub("exit1")]) {
      const w = await runner(cmd).sendOutcome(OUTCOME);
      expect(w).toEqual(expect.any(String));
      expect(w).not.toContain("\n");
    }
  });
});

describe("call context", () => {
  it("newCallContext initialises every field", () => {
    const c = newCallContext("ads_create_campaign", true);
    expect(c).toEqual({
      tool: "ads_create_campaign",
      validateOnly: true,
      refusal: null,
      sent: [],
      accounts: new Set(),
      validateOnlyStop: false,
      warnings: [],
    });
    expect(newCallContext("t", false).sent).not.toBe(c.sent);
  });

  it("callContext carries the context through async calls", async () => {
    const c = newCallContext("ads_update_entity", false);
    expect(callContext.getStore()).toBeUndefined();
    await callContext.run(c, async () => {
      await new Promise((r) => setTimeout(r, 1));
      expect(callContext.getStore()).toBe(c);
    });
  });
});
