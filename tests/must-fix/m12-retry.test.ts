// M12's rest (spec check 3; plan task 5): post and postMultipart take a RequestScope like postForm, and
// POST /{id}/budget_schedules and POST /{id}/insights are creating requests, never resent blind. Each case asserts
// exactly what the recording fetch received. The gate is the pass-through one: only the resend rule is under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetaApiClient } from "../../src/meta/client.js";
import { callContext, newCallContext } from "../../src/meta/write-guard.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import { PASS } from "../setup-write-gate.js";

const CAMP = "9994000000000001";

let writes: number;
let onWrite: (init?: RequestInit) => Promise<Response> | Response;

const clientWith = (opts: { timeout?: number } = {}) => new MetaApiClient({ maxRetries: 3, ...opts, writeGateForTests: PASS });
const inCall = <T>(work: () => Promise<T>) => callContext.run(newCallContext("ads_update_campaign", false), work);

const FAIL: Record<string, () => void> = {
  "a 500": () => {
    onWrite = () => mockFetchResponse({ message: "busy" }, { status: 500 });
  },
  "a timeout": () => {
    onWrite = (init) =>
      new Promise<Response>((_, reject) => {
        init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
  },
  "a transport error": () => {
    onWrite = () => Promise.reject(new TypeError("fetch failed"));
  },
};

const form = () => {
  const f = new FormData();
  f.append("name", "x");
  return f;
};

beforeEach(() => {
  setupTestToken();
  writes = 0;
  vi.spyOn(MetaApiClient.prototype as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
  vi.stubGlobal(
    "fetch",
    vi.fn(async (_input: string, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "GET") return mockFetchResponse({});
      writes++;
      return onWrite(init);
    }),
  );
});

afterEach(() => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("post and postMultipart take a RequestScope", () => {
  it.each([
    ["post, noRetry", (c: MetaApiClient) => c.post(`/${CAMP}`, { name: "x" }, { noRetry: true })],
    ["post, timeoutMs", (c: MetaApiClient) => c.post(`/${CAMP}`, { name: "x" }, { timeoutMs: 5_000 })],
    ["postMultipart, noRetry", (c: MetaApiClient) => c.postMultipart(`/${CAMP}`, form(), { noRetry: true })],
    ["postMultipart, timeoutMs", (c: MetaApiClient) => c.postMultipart(`/${CAMP}`, form(), { timeoutMs: 5_000 })],
  ])("%s: sent once after a 500", async (_name, write) => {
    FAIL["a 500"]();
    await expect(inCall(() => write(clientWith()))).rejects.toThrow();
    expect(writes).toBe(1);
  });

  it("control: a plain campaign update is resent after a 500", async () => {
    FAIL["a 500"]();
    await expect(inCall(() => clientWith().post(`/${CAMP}`, { name: "x" }))).rejects.toThrow();
    expect(writes).toBe(4);
  });
});

describe("budget_schedules and insights POSTs are creating requests", () => {
  const cases = ["budget_schedules", "insights"].flatMap((edge) => Object.keys(FAIL).map((fail) => [edge, fail] as const));
  it.each(cases)("POST /<n>/%s is sent once after %s", async (edge, fail) => {
    FAIL[fail]();
    await expect(inCall(() => clientWith({ timeout: 50 }).postForm(`/${CAMP}/${edge}`, { name: "x" }))).rejects.toThrow();
    expect(writes).toBe(1);
  });
});
