// Refusals, the validate-only stop and concurrent calls in the tool result (ticket 253, Task 6; spec §Design
// "Result order", spec-3 S3-1 and S3-3, S4): served tools through createServer, and test tools registered through
// toolFilter, on the real gate (record-allow.mjs), never tests/setup-write-gate.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { metaApiClient } from "../../src/meta/client.js";
import { createServer } from "../../src/server.js";
import { READ, UPDATE, toolFilter } from "../../src/tools/_register.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import {
  ADSET, BUSINESS, CAMP, LABEL, NOT_SENT, NO_WRITE, connect, descriptors, dropGuard, fake, formOf, installFetch,
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

const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";
const ENV_KEYS = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
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
