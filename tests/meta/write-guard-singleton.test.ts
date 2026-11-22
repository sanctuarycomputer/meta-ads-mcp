// The exported singleton itself (ticket 253, final review F2): loaded from the real src/meta/client.ts, not the
// pass-through client tests/setup-write-gate.ts puts in its place, it asks the real guard before a write. With
// META_WRITE_GUARD_CMD unset it refuses and sends nothing, whatever a test-only seam might have been passed.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { metaApiClient } from "../../src/meta/client.js";
import { TYPE_PROBES } from "../../src/meta/write-descriptor.js";
import { RealWriteGate, callContext, newCallContext } from "../../src/meta/write-guard.js";
import { answerGet } from "../fixtures/meta-ads-guard/harness.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

vi.unmock("../../src/meta/client.js");

const ACT = "act_9990000000000001";
const CAMP = "9994000000000001";

let calls: Array<{ method: string; path: string }>;
const saved = process.env.META_WRITE_GUARD_CMD;

beforeEach(() => {
  delete process.env.META_WRITE_GUARD_CMD;
  setupTestToken();
  calls = [];
  const world = new Map<string, unknown>([
    [`/${CAMP}`, { id: CAMP, objective: "OUTCOME_LEADS", metadata: { type: "campaign" }, account_id: "9990000000000001", name: "c", status: "PAUSED", effective_status: "PAUSED", buying_type: "AUCTION", spend_cap: "100000" }],
    [`/${ACT}`, { id: ACT, metadata: { type: "adaccount" }, spend_cap: "500000", amount_spent: "0", currency: "USD" }],
  ]);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const c = { method: init?.method ?? "GET", path: url.pathname.replace(/^\/v\d+\.\d+/, "") };
      calls.push(c);
      if (c.method !== "GET") return mockFetchResponse({ success: true });
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== "appsecret_proof") params[k] = v;
      const node = world.get(c.path) as Record<string, unknown> | undefined;
      if (TYPE_PROBES.some(([field]) => field === params.fields) && node && !(params.fields in node)) {
        return mockFetchResponse({ error: { code: 100, type: "OAuthException", message: "Tried accessing nonexisting field" } }, { status: 400 });
      }
      return mockFetchResponse(answerGet(world, c.path, params));
    }),
  );
});

afterEach(() => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.META_WRITE_GUARD_CMD;
  else process.env.META_WRITE_GUARD_CMD = saved;
});

describe("the exported metaApiClient, unmocked", () => {
  it("is not the setup file's pass-through client: its gate is the real one", () => {
    expect((metaApiClient as unknown as { writeGate: unknown }).writeGate).toBeInstanceOf(RealWriteGate);
  });

  it("refuses a write inside a tool call with the guard unset, after asking its gate, and sends nothing", async () => {
    const check = vi.spyOn(RealWriteGate.prototype, "check");
    const ctx = newCallContext("ads_update_campaign", false);
    let message = "";
    try {
      await callContext.run(ctx, () => metaApiClient.postForm(`/${CAMP}`, { name: "renamed" }));
    } catch (e) {
      message = (e as Error).message;
    }
    expect(check).toHaveBeenCalledTimes(1);
    expect(message).toBe("MCP error -32600: write refused: guard unset: META_WRITE_GUARD_CMD is not set");
    expect(calls.filter((c) => c.method !== "GET")).toEqual([]);
  });
});
