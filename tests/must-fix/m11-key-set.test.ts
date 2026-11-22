// M11, the client side (spec check 3, ruling a-20261116-154225089 O1, grant m-20261116-154711873): after the guard's
// clear allow and before anything is sent, RealWriteGate.check refuses a write whose params_keys leave its row's key
// set (keySetMiss), sends the guard that attempt's outcome (ok: false, the reason) and makes it the call's refusal.
// Tested through the real gate with an allow-all recording stub guard (record-allow.mjs), so only the client refuses.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { metaApiClient } from "../../src/meta/client.js";
import { createServer } from "../../src/server.js";
import { UPDATE, toolFilter } from "../../src/tools/_register.js";
import { keySetMiss, type Descriptor } from "../../src/meta/write-descriptor.js";
import { loadFixtures } from "../fixtures/meta-ads-guard/fake-guard.mjs";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import {
  ACT, ADSET, CAMP, ROOT, connect, descriptors, dropGuard, fake, guardLog, installFetch, smallWorld, textOf, useGuard,
  writes, type ToolResult,
} from "../tools/validate-only-helpers.js";

const guard = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }));
vi.unmock("../../src/meta/client.js");
vi.mock("../../src/meta/client.js", async (orig) => {
  const m = await orig<typeof import("../../src/meta/client.js")>();
  const { GuardRunner, RealWriteGate } = await import("../../src/meta/write-guard.js");
  const { withLiveTypes } = await import("../meta/live-type-graph.js");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  return {
    ...m,
    metaApiClient: new m.MetaApiClient({
      maxRetries: 0,
      writeGateForTests: (get) => new RealWriteGate(withLiveTypes(get), new GuardRunner({ env: guard.env, cwd, timeoutMs: 15_000 })),
    }),
  };
});

const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";
const ENV_KEYS = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

const outcomes = (): Array<Record<string, unknown>> =>
  existsSync(guardLog())
    ? readFileSync(guardLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>).filter((r) => "outcome_for" in r)
    : [];

// One write per shape, each with one key outside its row's set; registered through toolFilter, as every group is.
const WRITES: Record<string, () => Promise<unknown>> = {
  // Top-level: bid_amount is in no POST /{campaign_id} key list.
  test_campaign_bid: () => metaApiClient.postForm(`/${CAMP}`, { bid_amount: "100" }),
  // Dotted: creative is listed on POST /act_{id}/ads, creative.tracking_specs is not, and creative bounds nothing.
  test_ad_tracking: () =>
    metaApiClient.postForm(`/${ACT}/ads`, {
      name: "x",
      adset_id: ADSET,
      status: "PAUSED",
      creative: JSON.stringify({ name: "c", tracking_specs: "t" }),
    }),
  // A row whose key set is empty.
  test_budget_schedule: () => metaApiClient.postForm(`/${CAMP}/budget_schedules`, { budget_value: "100" }),
  // A path no row matches.
  test_no_row: () => metaApiClient.postForm(`/${CAMP}/no_such_edge`, { name: "x" }),
};

function testServer(): McpServer {
  const server = new McpServer({ name: "t", version: "0" });
  const filter = toolFilter(server, () => true);
  for (const [name, write] of Object.entries(WRITES)) {
    filter.registerTool(name, { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
      await write();
      return { content: [{ type: "text", text: "unreachable" }] };
    });
  }
  // A first write the key set refuses, caught, then an in-set write.
  filter.registerTool("test_miss_then_write", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    try {
      await metaApiClient.postForm(`/${CAMP}`, { bid_amount: "100" });
    } catch {
      // swallowed: the call's refusal stands
    }
    await metaApiClient.postForm(`/${CAMP}`, { status: "PAUSED" });
    return { content: [{ type: "text", text: "unreachable" }] };
  });
  return server;
}

async function callOn(server: McpServer, name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connect(server);
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await close();
  }
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

describe("an allowed write outside its row's key set is refused by the client, after the guard", () => {
  it.each([
    ["top-level", "test_campaign_bid", "bid_amount is not a key of POST /{campaign_id}"],
    ["creative.<key>", "test_ad_tracking", "creative.tracking_specs is not a key of POST /act_{id}/ads"],
    ["a row with an empty set", "test_budget_schedule", "budget_value is not a key of POST /{campaign_id}/budget_schedules"],
    ["no row", "test_no_row", "name matches no endpoint row"],
  ])("%s: zero Graph writes, one guard decision, one ok:false outcome, the refusal as the result", async (_shape, tool, reason) => {
    const r = await callOn(testServer(), tool, {});
    expect(writes()).toEqual([]);
    const ds = descriptors();
    expect(ds).toHaveLength(1);
    expect(outcomes()).toEqual([{ v: "1.0", outcome_for: ds[0].request_id, ok: false, meta_id: null, error: reason }]);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${refused(reason)}\nwrites sent before it: none`);
  });

  it("a guard that allows and does not acknowledge the outcome: the result carries the warning line", async () => {
    useGuard(guard.env, "NACK");
    const r = await callOn(testServer(), "test_campaign_bid", {});
    expect(writes()).toEqual([]);
    expect(r.isError).toBe(true);
    expect(r.content.map((c) => c.text)).toEqual([
      `${refused("bid_amount is not a key of POST /{campaign_id}")}\nwrites sent before it: none`,
      `guard outcome record for ${descriptors()[0].request_id} was not acknowledged`,
    ]);
  });

  it("a later write in the call is refused without asking the guard", async () => {
    const r = await callOn(testServer(), "test_miss_then_write", {});
    expect(writes()).toEqual([]);
    expect(descriptors()).toHaveLength(1);
    expect(outcomes()).toHaveLength(1);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`${refused("bid_amount is not a key of POST /{campaign_id}")}\nwrites sent before it: none`);
  });

  it("an in-set write (a campaign pause, served) is sent", async () => {
    const r = (await (async () => {
      const { client, close } = await connect(createServer());
      try {
        return (await client.callTool({ name: "ads_update_campaign", arguments: { campaign_id: CAMP, status: "PAUSED" } })) as ToolResult;
      } finally {
        await close();
      }
    })());
    expect(r.isError).toBeFalsy();
    expect(writes()).toHaveLength(1);
    expect(outcomes()).toEqual([expect.objectContaining({ outcome_for: descriptors()[0].request_id, ok: true })]);
  });
});

describe("keySetMiss", () => {
  const FIXTURES = loadFixtures(join(ROOT, "tests/fixtures/meta-ads-guard/fixtures"));
  const base = FIXTURES.find((f: { name: string }) => f.name === "a-paused-create").descriptor as Descriptor;
  const d = (method: "POST" | "DELETE", path: string, type: Descriptor["object"]["type"], keys: string[]): Descriptor => ({
    ...base,
    method,
    path,
    object: { type, id: null, created: false },
    params_keys: keys,
  });

  it.each([
    ["a bounded path under a listed creative.<bounded>", d("POST", `/${ACT}/ads`, "ad", ["name", "creative", "creative.object_story_spec.page_id"])],
    ["a bounded path under a listed top-level <bounded>", d("POST", `/${ACT}/adsets`, "adset", ["name", "promoted_object.pixel_id"])],
    ["keys from two of the row's lists (the union)", d("POST", `/${CAMP}`, "campaign", ["name", "status"])],
    ["execution_options on a row with an empty set", d("POST", `/${CAMP}/budget_schedules`, "other", ["execution_options"])],
    ["a no-row write with no keys", d("POST", `/${CAMP}/no_such_edge`, "other", [])],
    ["a no-row write whose only key is execution_options (T4-1)", d("POST", `/${CAMP}/no_such_edge`, "other", ["execution_options"])],
  ])("passes %s", (_name, desc) => {
    expect(keySetMiss(desc)).toBeNull();
  });

  it.each([
    ["a bounded path whose object is not in the row's set", d("POST", `/${ADSET}`, "adset", ["name", "creative.object_story_spec.page_id"]), "creative.object_story_spec.page_id", "POST /{adset_id}"],
    ["a dotted key whose listed prefix is not bounded", d("POST", `/${ACT}/ads`, "ad", ["name", "creative.name.x"]), "creative.name.x", "POST /act_{id}/ads"],
    ["a key of another row", d("POST", `/${CAMP}`, "campaign", ["name", "targeting"]), "targeting", "POST /{campaign_id}"],
    ["a no-row write with a key", d("POST", `/${CAMP}/no_such_edge`, "other", ["name"]), "name", "no row"],
    ["two out-of-set keys: the first is named (T4-2)", d("POST", `/${CAMP}`, "campaign", ["name", "targeting", "bid_amount"]), "targeting", "POST /{campaign_id}"],
  ])("misses %s", (_name, desc, key, row) => {
    expect(keySetMiss(desc)).toEqual({ key, row });
  });
});
