// The client's request-shape refusals and the read server's method allowlist (ticket 253, Task 5; contract
// docs/contracts/meta-ads-guard.md §2 "Client refusals"). Every client method, on both servers: no request is sent,
// the guard never runs (the stub would write its file), and the caller gets the reason.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MetaApiClient, checkRequestShape } from "../../src/meta/client.js";
import { GuardRunner, RealWriteGate, callContext, newCallContext } from "../../src/meta/write-guard.js";
import { WriteRefusal } from "../../src/meta/write-descriptor.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STUBS = join(ROOT, "tests/fixtures/meta-ads-guard/stubs");
const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

let dir: string;
let marker: string;

function clientAt(baseUrl?: string): MetaApiClient {
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    HOME: process.env.HOME ?? "/tmp",
    META_WRITE_GUARD_CMD: ["node", join(STUBS, "record.mjs"), marker].join(" "),
  };
  return new MetaApiClient({
    maxRetries: 0,
    ...(baseUrl === undefined ? {} : { baseUrl }),
    writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env, cwd: ROOT, timeoutMs: 15_000 })),
  });
}

type Method = "get" | "post" | "postForm" | "postMultipart" | "delete" | "getDetached";
const METHODS: readonly Method[] = ["get", "post", "postForm", "postMultipart", "delete", "getDetached"];

function invoke(c: MetaApiClient, m: Method, path: string, params: Record<string, string>, names?: Array<[string, string]>) {
  switch (m) {
    case "get":
      return c.get(path, params);
    case "post":
      return c.post(path, params);
    case "postForm":
      return c.postForm(path, params);
    case "postMultipart": {
      const form = new FormData();
      for (const [k, v] of names ?? Object.entries(params)) form.append(k, v);
      return c.postMultipart(path, form);
    }
    case "delete":
      return c.delete(path, params);
    case "getDetached":
      return c.getDetached(path, params, new AbortController().signal, "test-access-token");
  }
}

// Inside a write tool's call, so only the shape check stands between the request and the guard.
async function refusalOf(c: MetaApiClient, m: Method, path: string, params: Record<string, string>, names?: Array<[string, string]>) {
  try {
    await callContext.run(newCallContext("ads_update_campaign", false), () => invoke(c, m, path, params, names));
  } catch (e) {
    expect(e).toBeInstanceOf(WriteRefusal);
    return (e as Error).message;
  }
  throw new Error("expected a refusal, got a resolve");
}

beforeEach(() => {
  setupTestToken();
  vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ success: true })));
  dir = mkdtempSync(join(tmpdir(), "wg-choke-"));
  marker = join(dir, "guard-ran");
});

afterEach(() => {
  cleanupTestToken();
  delete process.env.META_ADS_READ_ONLY;
  vi.unstubAllGlobals();
  rmSync(dir, { recursive: true, force: true });
});

const PARAM_CASES: Array<[string, string]> = [
  ["method", "a parameter named method would override the HTTP method"],
  ["_METHOD", "a parameter named _METHOD would override the HTTP method"],
  ["Batch", "a parameter named Batch is a Graph batch"],
  ["async_batch", "a parameter named async_batch is a Graph batch"],
];
const PATH_CASES: Array<[string, string]> = [
  ["/1/async_batch_requests", "the path has an async_batch_requests segment (a Graph batch)"],
  ["/1/../2", "the path is not a plain Graph path (letters, digits and _ between single slashes)"],
  ["/1?x=1", "the path is not a plain Graph path (letters, digits and _ between single slashes)"],
  ["/1#x", "the path is not a plain Graph path (letters, digits and _ between single slashes)"],
  ["//1", "the path is not a plain Graph path (letters, digits and _ between single slashes)"],
  ["/1%2e", "the path is not a plain Graph path (letters, digits and _ between single slashes)"],
];
const BASE_CASES: Array<[string, string]> = [
  ["http://graph.facebook.com", "the base URL is not https"],
  ["https://evil.example", "the host evil.example is not on the host list"],
  ["https://graph.facebook.com:444", "the base URL has a port"],
  ["https://u@graph.facebook.com", "the base URL has userinfo"],
  // What is checked is what the URL is built from (T5-3): the origin itself, nothing after it.
  ["https://graph.facebook.com/", "the base URL is not exactly https:// and its host"],
  ["https://graph.facebook.com/x", "the base URL is not exactly https:// and its host"],
  ["https://graph.facebook.com?", "the base URL is not exactly https:// and its host"],
  ["https://graph.facebook.com#", "the base URL is not exactly https:// and its host"],
  ["https://graph.facebook.com:443", "the base URL is not exactly https:// and its host"],
  ["https://GRAPH.facebook.com", "the base URL is not exactly https:// and its host"],
];

for (const readOnly of [false, true]) {
  describe(`${readOnly ? "read" : "write"} server: client refusals send nothing and never run the guard`, () => {
    beforeEach(() => {
      if (readOnly) process.env.META_ADS_READ_ONLY = "1";
    });

    for (const m of METHODS) {
      describe(m, () => {
        it.each(PARAM_CASES)("a parameter named %s", async (name, detail) => {
          expect(await refusalOf(clientAt(), m, "/1", { [name]: "x" })).toBe(refused(detail));
          expect(fetch).not.toHaveBeenCalled();
          expect(existsSync(marker)).toBe(false);
        });

        it.each(PATH_CASES)("the path %s", async (path, detail) => {
          expect(await refusalOf(clientAt(), m, path, { name: "x" })).toBe(refused(detail));
          expect(fetch).not.toHaveBeenCalled();
          expect(existsSync(marker)).toBe(false);
        });

        it.each(BASE_CASES)("a client whose base URL is %s", async (base, detail) => {
          expect(await refusalOf(clientAt(base), m, "/1", { name: "x" })).toBe(refused(detail));
          expect(fetch).not.toHaveBeenCalled();
          expect(existsSync(marker)).toBe(false);
        });
      });
    }

    it("postMultipart: a repeated field name", async () => {
      const names: Array<[string, string]> = [["name", "a"], ["name", "b"]];
      expect(await refusalOf(clientAt(), "postMultipart", "/1", {}, names)).toBe(refused('the multipart field "name" is repeated'));
      expect(fetch).not.toHaveBeenCalled();
      expect(existsSync(marker)).toBe(false);
    });
  });
}

describe("read server (META_ADS_READ_ONLY=1)", () => {
  beforeEach(() => {
    process.env.META_ADS_READ_ONLY = "1";
  });

  // P12: an insights report POST goes straight to Meta: no guard, no context needed.
  it.each([
    ["post", "/act_1/insights"],
    ["postForm", "/123/insights"],
  ] as const)("%s %s is sent, with no guard", async (m, path) => {
    const c = clientAt();
    await expect(m === "post" ? c.post(path, { level: "ad" }) : c.postForm(path, { level: "ad" })).resolves.toEqual({ success: true });
    expect(vi.mocked(fetch).mock.calls.map(([, init]) => init?.method)).toEqual(["POST"]);
    expect(existsSync(marker)).toBe(false);
  });

  it.each([
    ["postForm", "POST", "/act_1/campaigns"],
    ["delete", "DELETE", "/1"],
    ["postForm", "POST", "/1/copies"],
    // Only an account or a numeric id directly followed by /insights is the report edge.
    ["postForm", "POST", "/act_1/insights_x"],
    ["post", "POST", "/act_1/insights/foo"],
    ["postForm", "POST", "/me/insights"],
    ["postForm", "POST", "/1_2/insights"],
    ["delete", "DELETE", "/act_1/insights"],
  ] as const)("%s %s %s is refused before any GET", async (m, method, path) => {
    expect(await refusalOf(clientAt(), m, path, { name: "x" })).toBe(
      refused(`this server is read-only: ${method} ${path} is neither a GET nor an insights report`),
    );
    expect(fetch).not.toHaveBeenCalled();
    expect(existsSync(marker)).toBe(false);
  });

  it("GETs are still sent", async () => {
    await expect(clientAt().get("/act_1/campaigns", { fields: "id" })).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});

describe("checkRequestShape", () => {
  const BASE = "https://graph.facebook.com";
  it("passes a plain request, with or without a version", () => {
    expect(() => checkRequestShape("POST", BASE, "/v27.0/act_1/campaigns", { name: "x" })).not.toThrow();
    expect(() => checkRequestShape("GET", BASE, "/v27.0/123", {})).not.toThrow();
  });

  it("checks the raw joined path, before URL parsing folds it", () => {
    expect(() => checkRequestShape("GET", BASE, "/v27.0/1/./2", {})).toThrow(WriteRefusal);
  });

  it("finds a batch path segment in any case", () => {
    expect(() => checkRequestShape("GET", BASE, "/v27.0/1/ASYNC_BATCH_REQUESTS", {})).toThrow(/async_batch_requests segment/);
  });
});

describe("execute, the one sender", () => {
  type Execute = (m: string, u: string, p: string, params: Record<string, unknown>, o?: RequestInit) => Promise<unknown>;
  const executeOf = (c: MetaApiClient) => (c as unknown as { execute: Execute }).execute.bind(c);

  it("refuses a URL whose query has a key the request did not name", async () => {
    const execute = executeOf(clientAt());
    await expect(execute("GET", "https://graph.facebook.com/v27.0/1?fields=id&extra=1", "/1", { fields: "id" })).rejects.toThrow(
      refused("the URL carries a query parameter the request did not name"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("sends a URL whose query is the request's params and the proof", async () => {
    const execute = executeOf(clientAt());
    await expect(execute("GET", "https://graph.facebook.com/v27.0/1?fields=id", "/1", { fields: "id" })).resolves.toEqual({ success: true });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("runs the shape check itself, so no path around sendWrite skips it", async () => {
    const execute = executeOf(clientAt());
    await expect(execute("POST", "https://graph.facebook.com/v27.0/1", "/1", { _method: "DELETE" })).rejects.toThrow(
      refused("a parameter named _method would override the HTTP method"),
    );
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds every act_ account a request path names to the call's accounts, GETs included", async () => {
    const ctx = newCallContext("ads_update_campaign", false);
    await callContext.run(ctx, () => clientAt().get("/act_42/campaigns", { fields: "id" }));
    await callContext.run(ctx, () => clientAt().get("/123", { fields: "id" }));
    expect([...ctx.accounts]).toEqual(["act_42"]);
  });
});
