// Refusals, the validate-only stop and concurrent calls in the tool result (ticket 253, Task 6; spec §Design
// "Result order", spec-3 S3-1 and S3-3, S4): served tools through createServer, and test tools registered through
// toolFilter, on the real gate (record-allow.mjs), never tests/setup-write-gate.ts.
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { metaApiClient } from "../../src/meta/client.js";
import { createServer } from "../../src/server.js";
import { registerBulkAdTools } from "../../src/tools/bulk-ads.js";
import { READ, UPDATE, toolFilter } from "../../src/tools/_register.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import {
  ACT, ADSET, BUSINESS, CAMP, LABEL, NOT_SENT, NO_WRITE, connect, descriptors, dropGuard, fake, formOf, installFetch,
  smallWorld, textOf, useGuard, writes, type Sent, type ToolResult,
} from "./validate-only-helpers.js";

const guard = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }));
vi.unmock("../../src/meta/client.js");
vi.mock("../../src/meta/client.js", async (orig) => {
  const m = await orig<typeof import("../../src/meta/client.js")>();
  const { GuardRunner, RealWriteGate } = await import("../../src/meta/write-guard.js");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  return {
    ...m,
    metaApiClient: new m.MetaApiClient({
      maxRetries: 0,
      writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env: guard.env, cwd, timeoutMs: 15_000 })),
    }),
  };
});

// ads_bulk_create_video_ads checks each file_url's host: resolve it to a public address without the network.
vi.mock("../../src/utils/url-guard.js", async (orig) => {
  const actual = await orig<typeof import("../../src/utils/url-guard.js")>();
  return { ...actual, assertSafePublicUrl: (raw: string) => actual.assertSafePublicUrl(raw, { resolve: async () => [{ address: "93.184.216.34" }] }) };
});

const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";
const ENV_KEYS = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
let late: Promise<unknown> | undefined;
const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

async function callOn(server: McpServer, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connect(server);
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await close();
  }
}
const call = (name: string, args: Record<string, unknown>) => callOn(createServer(), name, args);

// Test tools, registered the way every tool group registers: through toolFilter.
function testServer(): McpServer {
  const server = new McpServer({ name: "t", version: "0" });
  const filter = toolFilter(server, () => true);
  filter.registerTool("test_two_writes", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    await metaApiClient.postForm(`/${CAMP}`, { name: "a" });
    await metaApiClient.postForm(`/${ADSET}`, { name: "b" });
    return { content: [{ type: "text", text: "both written" }] };
  });
  // A second request the client's shape check refuses (a parameter named method), after a first that was sent.
  filter.registerTool("test_write_then_refused", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    await metaApiClient.postForm(`/${CAMP}`, { name: "a" });
    await metaApiClient.postForm(`/${CAMP}`, { method: "DELETE" });
    return { content: [{ type: "text", text: "unreachable" }] };
  });
  // Catches the client's refusal and returns a normal result, as a best-effort step does.
  filter.registerTool("test_swallow_refusal", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    try {
      await metaApiClient.postForm(`/${CAMP}`, { method: "DELETE" });
    } catch {
      return { content: [{ type: "text", text: "ok" }] };
    }
    return { content: [{ type: "text", text: "unreachable" }] };
  });
  filter.registerTool("test_write_then_throw", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    await metaApiClient.postForm(`/${CAMP}`, { name: "a" });
    throw new Error("the handler failed after its write");
  });
  // Starts a write it does not await, and returns.
  filter.registerTool("test_late_write", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    late = new Promise((resolve) => setTimeout(resolve, 20)).then(() => metaApiClient.postForm(`/${CAMP}`, { name: "late" }));
    return { content: [{ type: "text", text: "returned" }] };
  });
  filter.registerTool("test_no_write", { inputSchema: {}, annotations: { ...UPDATE } }, async () => ({
    content: [{ type: "text", text: "nothing to do" }],
  }));
  // Its arguments' names, as the handler got them.
  filter.registerTool("test_echo_args", { inputSchema: { x: z.string().optional() }, annotations: { ...UPDATE } }, async (args) => ({
    content: [{ type: "text", text: JSON.stringify(Object.keys(args).sort()) }],
  }));
  // A tool with no inputSchema: the SDK calls its handler with `extra` alone, and still does once validate_only is added.
  filter.registerTool("test_no_schema", { annotations: { ...UPDATE } }, async (extra: { requestId?: unknown }) => ({
    content: [{ type: "text", text: `extra first: ${extra.requestId !== undefined}` }],
  }));
  filter.registerTool("test_read", { inputSchema: {}, annotations: READ }, async () => ({ content: [{ type: "text", text: "read" }] }));
  return server;
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.META_ADS_TOOLSETS = WRITE_LIST;
  setupTestToken();
  fake.calls = [];
  fake.world = smallWorld();
  fake.onWrite = () => mockFetchResponse({ success: true });
  installFetch();
  for (const k of Object.keys(guard.env)) delete guard.env[k];
  useGuard(guard.env);
});

afterEach(() => {
  cleanupTestToken();
  vi.unstubAllGlobals();
  dropGuard();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("rule 1: a refusal wins", () => {
  it("a guard refusal is isError with its reason and no writes sent", async () => {
    useGuard(guard.env, "REFUSE_TOOL=ads_update_campaign");
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed" });
    expect(writes()).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${refused("guard denied: stub refuses ads_update_campaign")}\nwrites sent before it: none`);
  });

  it("a guard's reason quoting a credential reaches the caller scrubbed", async () => {
    const foreign = ["foreign", "credential", "value", String(process.pid)].join("-");
    useGuard(guard.env, "REFUSE_TOOL=ads_update_campaign", `REFUSE_REASON={"access_token":"${foreign}"}`);
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${refused('guard denied: {"access_token":"[REDACTED]"}')}\nwrites sent before it: none`);
  });

  it("ads_create_ad_study refused by the guard: the caller sees the guard's reason, not 'answer was lost' (S4)", async () => {
    useGuard(guard.env, "REFUSE_TOOL=ads_create_ad_study");
    const r = await call("ads_create_ad_study", {
      account_id: "act_9990000000000001",
      business_id: BUSINESS,
      name: "s",
      start_time: "2030-01-01",
      end_time: "2030-01-10",
      cells: [
        { name: "a", treatment_percentage: 50, campaigns: [CAMP] },
        { name: "b", treatment_percentage: 50, ad_sets: [ADSET] },
      ],
    });
    expect(writes()).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain(refused("guard denied: stub refuses ads_create_ad_study"));
    expect(textOf(r)).not.toContain("answer was lost");
  });

  it("a refusal after a validated write lists that write with its label line", async () => {
    const r = await callOn(testServer(), "test_write_then_refused", { validate_only: true });
    expect(writes()).toHaveLength(1);
    expect(formOf(writes()[0]).get("execution_options")).toBe('["validate_only"]');
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      `${refused("a parameter named method would override the HTTP method")}\nwrites sent before it:\nPOST /${CAMP}: ${LABEL.documented}`,
    );
  });

  it("without validate_only, the writes sent before it are named by method and path alone", async () => {
    const r = await callOn(testServer(), "test_write_then_refused", {});
    expect(writes()).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(
      `${refused("a parameter named method would override the HTTP method")}\nwrites sent before it:\nPOST /${CAMP}`,
    );
  });
});

describe("rule 1: a refusal the handler swallowed still wins (F1)", () => {
  it("a test tool that catches the client's refusal and returns ok: isError with the refusal", async () => {
    const r = await callOn(testServer(), "test_swallow_refusal", {});
    expect(writes()).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${refused("a parameter named method would override the HTTP method")}\nwrites sent before it: none`);
    expect(textOf(r)).not.toContain("ok");
  });

  it("ads_update_ad_url_tags (served), whose per-group catch turns the guard's refusal of the replacement creative into a report", async () => {
    useGuard(guard.env, "REFUSE_TOOL=ads_update_ad_url_tags");
    const AD = "9998000000000001";
    const CREATIVE = "9998100000000001";
    const PAGE = "9996000000000001";
    fake.world.set(`/${AD}`, { id: AD, metadata: { type: "ad" }, account_id: "9990000000000001", creative: { id: CREATIVE } });
    fake.world.set(`/${CREATIVE}`, { id: CREATIVE, metadata: { type: "adcreative" }, effective_object_story_id: `${PAGE}_1`, url_tags: "utm_source=old" });
    fake.world.set(`/${PAGE}`, { id: PAGE, metadata: { type: "page" }, name: "p" });
    fake.world.set(`/${PAGE}_1`, { id: `${PAGE}_1`, from: { id: PAGE } });
    const r = await call("ads_update_ad_url_tags", { ad_ids: [AD], url_tags: "utm_source=new" });
    expect(writes()).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${refused("guard denied: stub refuses ads_update_ad_url_tags")}\nwrites sent before it: none`);
  });

  // bulk-ads is a kept-out group (never served under toolsets), so it is registered here through toolFilter, the way
  // every served group registers: its real handler is the case of a per-item catch that turns an error into a summary.
  it("ads_bulk_create_video_ads through toolFilter, whose per-video catch turns the guard's refusal of the creative into a summary", async () => {
    // A guard that allows every write but the creative, written for this test (the record-allow stub refuses by tool).
    const dir = mkdtempSync(join(tmpdir(), "vo-swallow-"));
    try {
      const stub = join(dir, "refuse-creatives.mjs");
      writeFileSync(
        stub,
        [
          'let input = "";',
          'process.stdin.setEncoding("utf8");',
          'process.stdin.on("data", (c) => (input += c));',
          'process.stdin.on("end", () => {',
          "  const msg = JSON.parse(input);",
          '  const reply = "outcome_for" in msg ? { v: "1.0", ack: true, receipt: "r-outcome" }',
          '    : msg.path.endsWith("/adcreatives") ? { v: "1.0", allow: false, reason: "no creatives today", basis: null, receipt: "r-refusal" }',
          '    : { v: "1.0", allow: true, reason: "allowed", basis: "non-spending", receipt: "r-allow" };',
          '  process.stdout.write(JSON.stringify(reply) + "\\n");',
          "});",
        ].join("\n"),
      );
      guard.env.META_WRITE_GUARD_CMD = ["node", stub].join(" ");
      const VIDEO = "9997000000000001";
      const PAGE = "9996000000000001";
      fake.world.set(`/${PAGE}`, { id: PAGE, metadata: { type: "page" }, name: "p" });
      fake.world.set(`/${VIDEO}`, {
        id: VIDEO,
        status: { video_status: "ready" },
        thumbnails: { data: [{ uri: "https://example.com/t.jpg", is_preferred: true }] },
      });
      fake.onWrite = (c: Sent) => mockFetchResponse(c.path.endsWith("/advideos") ? { id: VIDEO } : { success: true });
      const server = new McpServer({ name: "t", version: "0" });
      registerBulkAdTools(toolFilter(server, () => true) as unknown as McpServer);
      const r = await callOn(server, "ads_bulk_create_video_ads", {
        account_id: ACT,
        ad_set_id: ADSET,
        page_id: PAGE,
        videos: [{ file_url: "https://example.com/v.mp4", ad_name: "v" }],
        max_wait_seconds: 0,
      });
      expect(writes().map((w) => w.path)).toEqual([`/${ACT}/advideos`]);
      expect(r.isError).toBe(true);
      expect(textOf(r)).toBe(`${refused("guard denied: no creatives today")}\nwrites sent before it:\nPOST /${ACT}/advideos`);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("unacknowledged outcome records stay in the result", () => {
  const unacked = () => `guard outcome record for ${descriptors()[0].request_id} was not acknowledged`;

  it("in a refusal after a sent write", async () => {
    useGuard(guard.env, "NACK");
    const r = await callOn(testServer(), "test_write_then_refused", {});
    expect(writes()).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      { type: "text", text: `${refused("a parameter named method would override the HTTP method")}\nwrites sent before it:\nPOST /${CAMP}` },
      { type: "text", text: unacked() },
    ]);
  });

  it("in a handler's error after its write", async () => {
    useGuard(guard.env, "NACK");
    const r = await callOn(testServer(), "test_write_then_throw", {});
    expect(writes()).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(r.content).toEqual([
      { type: "text", text: "the handler failed after its write" },
      { type: "text", text: unacked() },
    ]);
  });
});

describe("a closed call", () => {
  it.each([[false], [true]])("a write started by a handler that already returned is refused and not sent (validate_only %s)", async (vo) => {
    late = undefined;
    const r = await callOn(testServer(), "test_late_write", { validate_only: vo });
    expect(r.content[0]).toEqual({ type: "text", text: "returned" });
    await expect(late).rejects.toThrow(refused("the tool call already returned"));
    expect(writes()).toHaveLength(0);
    expect(descriptors()).toHaveLength(0);
  });
});

describe("the validate-only stop", () => {
  it("two writes in one call: the second is not sent, and the result says so", async () => {
    const r = await callOn(testServer(), "test_two_writes", { validate_only: true });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe(`/${CAMP}`);
    expect(descriptors()).toHaveLength(1);
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      [`POST /${CAMP} sent with validate_only`, `Meta's answer: {"success":true}`, LABEL.documented, NOT_SENT].join("\n"),
    );
  });

  it("without validate_only both writes go and the handler's result stands", async () => {
    const r = await callOn(testServer(), "test_two_writes", {});
    expect(writes().map((w) => w.path)).toEqual([`/${CAMP}`, `/${ADSET}`]);
    expect(r.content).toEqual([{ type: "text", text: "both written" }]);
  });

  it("rule 3: validate_only on a call that sends nothing adds the no-write line to the handler's result", async () => {
    const r = await callOn(testServer(), "test_no_write", { validate_only: true });
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: "text", text: "nothing to do" }, { type: "text", text: NO_WRITE }]);
    expect((await callOn(testServer(), "test_no_write", {})).content).toEqual([{ type: "text", text: "nothing to do" }]);
  });

  it("the handler never sees validate_only among its arguments", async () => {
    const r = await callOn(testServer(), "test_echo_args", { x: "1", validate_only: true });
    expect(r.content).toEqual([{ type: "text", text: '["x"]' }, { type: "text", text: NO_WRITE }]);
  });

  it("a tool registered without an inputSchema still gets extra as its first argument", async () => {
    const r = await callOn(testServer(), "test_no_schema", { validate_only: true });
    expect(r.content).toEqual([{ type: "text", text: "extra first: true" }, { type: "text", text: NO_WRITE }]);
  });

  it("a read tool registered through toolFilter gets no validate_only", async () => {
    const { client, close } = await connect(testServer());
    try {
      const { tools } = await client.listTools();
      expect(tools.find((t) => t.name === "test_read")?.inputSchema.properties ?? {}).not.toHaveProperty("validate_only");
      expect(tools.find((t) => t.name === "test_no_write")?.inputSchema.properties).toHaveProperty("validate_only");
    } finally {
      await close();
    }
  });
});

describe("concurrent calls keep separate contexts", () => {
  it("two calls started together, one refused by the guard, the other allowed under validate_only: each result is its own", async () => {
    useGuard(guard.env, "REFUSE_TOOL=ads_update_campaign");
    const [a, b] = await Promise.all([
      call("ads_update_campaign", { campaign_id: CAMP, name: "renamed" }),
      call("ads_update_ad_set", { ad_set_id: ADSET, name: "renamed", validate_only: true }),
    ]);
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe(`/${ADSET}`);
    expect(formOf(writes()[0]).get("execution_options")).toBe('["validate_only"]');
    expect(a.isError).toBe(true);
    expect(textOf(a)).toBe(`${refused("guard denied: stub refuses ads_update_campaign")}\nwrites sent before it: none`);
    expect(b.isError).toBeFalsy();
    expect(textOf(b)).toBe([`POST /${ADSET} sent with validate_only`, `Meta's answer: {"success":true}`, LABEL.unconfirmed].join("\n"));
  });

  it("two allowed calls in flight at once, one under validate_only: each sends its own execution_options", async () => {
    // Hold every write's answer until both writes have arrived, so the calls overlap at the write.
    const held: Array<() => void> = [];
    fake.onWrite = (_c: Sent) =>
      new Promise<Response>((resolve) => {
        held.push(() => resolve(mockFetchResponse({ success: true })));
        if (held.length === 2) for (const go of held) go();
      });
    const [a, b] = await Promise.all([
      call("ads_update_campaign", { campaign_id: CAMP, name: "renamed", validate_only: true }),
      call("ads_update_ad_set", { ad_set_id: ADSET, name: "renamed" }),
    ]);
    const byPath = new Map(writes().map((w) => [w.path, formOf(w)]));
    expect(byPath.get(`/${CAMP}`)?.get("execution_options")).toBe('["validate_only"]');
    expect(byPath.get(`/${ADSET}`)?.has("execution_options")).toBe(false);
    expect(textOf(a)).toBe([`POST /${CAMP} sent with validate_only`, `Meta's answer: {"success":true}`, LABEL.documented].join("\n"));
    expect(textOf(b)).toBe(`Ad set ${ADSET} updated successfully.\nChanges: {"name":"renamed"}`);
    const byTool = new Map(descriptors().map((d) => [d.tool, d.validate_only]));
    expect(byTool).toEqual(new Map([["ads_update_campaign", true], ["ads_update_ad_set", false]]));
  });
});
