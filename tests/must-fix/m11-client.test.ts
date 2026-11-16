// M11, the client side (spec check 3; plan task 5): bracket forms of the method-override and batch names, one source
// for the wire (post's deep copy, postMultipart's snapshot and new FormData), "not sent is not sent" (notSentOf and
// the wrapper's "allowed but not sent" line), and lastWriteFate. Writes go through the real gate with the allow-all
// recording stub guard (record-allow.mjs), so only the client decides.
import { existsSync, readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { MetaApiClient, lastWriteFate, notSentOf } from "../../src/meta/client.js";
import { GuardRunner, RealWriteGate, callContext, newCallContext, type CallContext } from "../../src/meta/write-guard.js";
import { WriteRefusal } from "../../src/meta/write-descriptor.js";
import { hashToken } from "../../src/auth/token-store.js";
import { tokenManager } from "../../src/auth/token-manager.js";
import { UPDATE, toolFilter } from "../../src/tools/_register.js";
import { answerGet } from "../fixtures/meta-ads-guard/harness.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import {
  ACT, ADSET, CAMP, ROOT, connect, descriptors, dropGuard, guardLog, smallWorld, textOf, useGuard, type ToolResult,
} from "../tools/validate-only-helpers.js";

const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

// ---- the fake Graph: GETs from a world (onGet runs first), writes from onWrite, every call recorded ----

interface Sent {
  method: string;
  path: string;
  init?: RequestInit;
}
let calls: Sent[];
let world: Map<string, unknown>;
let onGet: (n: number) => void;
let onWrite: (c: Sent) => Promise<Response> | Response;

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const c: Sent = { method: init?.method ?? "GET", path: url.pathname.replace(/^\/v\d+\.\d+/, ""), init };
      calls.push(c);
      if (c.method !== "GET") return onWrite(c);
      onGet(calls.filter((x) => x.method === "GET").length);
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== "appsecret_proof") params[k] = v;
      try {
        return mockFetchResponse(answerGet(world, c.path, params));
      } catch (e) {
        return mockFetchResponse({ error: { code: 100, type: "OAuthException", message: (e as Error).message } }, { status: 400 });
      }
    }),
  );
}

const writes = () => calls.filter((c) => c.method !== "GET");

const records = (): Array<Record<string, unknown>> =>
  existsSync(guardLog()) ? readFileSync(guardLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
const outcomes = () => records().filter((r) => "outcome_for" in r);

// ---- the client, its call, and the served wrapper ----

const guardEnv: NodeJS.ProcessEnv = {};
const clientWith = (opts: { timeout?: number; maxRetries?: number } = {}) =>
  new MetaApiClient({
    maxRetries: 0,
    ...opts,
    writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env: guardEnv, cwd: ROOT, timeoutMs: 15_000 })),
  });

function inCall<T>(work: () => Promise<T>, tool = "ads_update_campaign") {
  const ctx = newCallContext(tool, false);
  return { ctx, run: callContext.run(ctx, work) };
}

async function errorOf(p: Promise<unknown>): Promise<Error> {
  try {
    await p;
  } catch (e) {
    return e as Error;
  }
  throw new Error("expected a throw, got a resolve");
}

// One write tool, registered through toolFilter as every group is; `seen` is its call context.
async function served(write: () => Promise<unknown>, args: Record<string, unknown> = {}): Promise<{ r: ToolResult; ctx: CallContext }> {
  let seen: CallContext | undefined;
  const server = new McpServer({ name: "t", version: "0" });
  toolFilter(server, () => true).registerTool("test_write", { inputSchema: {}, annotations: { ...UPDATE } }, async () => {
    seen = callContext.getStore();
    await write();
    return { content: [{ type: "text", text: "unreachable" }] };
  });
  const { client, close } = await connect(server);
  try {
    const r = (await client.callTool({ name: "test_write", arguments: args })) as ToolResult;
    return { r, ctx: seen! };
  } finally {
    await close();
  }
}

// After the guard's allow (the real check runs first), `then` runs: the write is allowed and not yet sent.
function afterAllow(then: () => void): void {
  const check = RealWriteGate.prototype.check;
  vi.spyOn(RealWriteGate.prototype, "check").mockImplementation(async function (this: RealWriteGate, ...args) {
    const allowed = await check.apply(this, args);
    then();
    return allowed;
  });
}

beforeEach(() => {
  setupTestToken();
  calls = [];
  world = smallWorld();
  onGet = () => {};
  onWrite = () => mockFetchResponse({ success: true });
  installFetch();
  for (const k of Object.keys(guardEnv)) delete guardEnv[k];
  useGuard(guardEnv);
});

afterEach(() => {
  cleanupTestToken();
  delete process.env.META_ADS_READ_ONLY;
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  dropGuard();
});

// ---- bracket names ----

describe("a method-override or batch name in a bracket form is refused, on both servers", () => {
  const NAMES: Array<[string, string]> = [
    ["method[0]", "would override the HTTP method"],
    ["_METHOD[x]", "would override the HTTP method"],
    ["batch[0][method]", "is a Graph batch"],
    ["async_batch[1]", "is a Graph batch"],
  ];
  const SENDERS: Record<string, (c: MetaApiClient, name: string) => Promise<unknown>> = {
    post: (c, name) => c.post(`/${CAMP}`, { [name]: "x" }),
    postForm: (c, name) => c.postForm(`/${CAMP}`, { [name]: "x" }),
    postMultipart: (c, name) => {
      const form = new FormData();
      form.append(name, "x");
      return c.postMultipart(`/${CAMP}`, form);
    },
    delete: (c, name) => c.delete(`/${CAMP}`, { [name]: "x" }),
  };
  const cases = ["write", "read"].flatMap((server) =>
    Object.keys(SENDERS).flatMap((sender) => NAMES.map(([name, why]) => [server, sender, name, why] as const)));

  it.each(cases)("%s server, %s, %s: refused, zero fetches, no guard call", async (server, sender, name, why) => {
    if (server === "read") process.env.META_ADS_READ_ONLY = "1";
    const e = await errorOf(inCall(() => SENDERS[sender](clientWith(), name)).run);
    expect(e).toBeInstanceOf(WriteRefusal);
    expect(e.message).toBe(refused(`a parameter named ${name} ${why}`));
    expect(calls).toEqual([]);
    expect(existsSync(guardLog())).toBe(false);
  });
});

// ---- one source for the wire ----

describe("post sends the copy it described", () => {
  it("a nested value the caller changes during the descriptor's first GET is sent as described", async () => {
    const body = {
      name: "ad",
      adset_id: ADSET,
      status: "PAUSED",
      creative: { object_story_spec: { page_id: "7770000000000001", link_data: { link: "https://example.com" } } },
    };
    onGet = (n) => {
      if (n === 1) body.creative.object_story_spec.page_id = "6660000000000001";
    };
    await inCall(() => clientWith().post(`/${ACT}/ads`, body), "ads_create_ad").run;
    expect(calls.filter((c) => c.method === "GET").length).toBeGreaterThan(0);
    expect(writes()).toHaveLength(1);
    const wire = JSON.parse(String(writes()[0].init?.body)) as typeof body;
    expect(wire.creative.object_story_spec.page_id).toBe("7770000000000001");
    expect(wire).toEqual({ ...body, creative: { object_story_spec: { ...body.creative.object_story_spec, page_id: "7770000000000001" } } });
    expect(JSON.stringify(descriptors()[0])).not.toContain("6660000000000001");
  });

  it("a body that structuredClone cannot copy (a function value) is refused, nothing sent, no guard call", async () => {
    const e = await errorOf(inCall(() => clientWith().post(`/${CAMP}`, { name: "x", f: () => 1 })).run);
    expect(e).toBeInstanceOf(WriteRefusal);
    expect(calls).toEqual([]);
    expect(existsSync(guardLog())).toBe(false);
  });
});

describe("postMultipart sends a new FormData of the snapshot it described", () => {
  const imageForm = () => {
    const form = new FormData();
    form.append("filename", new Blob(["original-bytes"]), "a.png");
    form.append("name", "img");
    return form;
  };
  const sentForm = () => writes()[0].init?.body as FormData;

  it("a field appended to the caller's form during the descriptor's first GET is not on the wire", async () => {
    const form = imageForm();
    onGet = (n) => {
      if (n === 1) form.append("hash", "x");
    };
    await inCall(() => clientWith().postMultipart(`/${ACT}/adimages`, form), "ads_upload_ad_image").run;
    expect(writes()).toHaveLength(1);
    expect(sentForm()).not.toBe(form);
    expect([...sentForm().keys()]).toEqual(["filename", "name"]);
    expect(descriptors()[0].params_keys).toEqual(["filename", "name"]);
  });

  it("the caller's file entry replaced by other bytes during that GET is not on the wire", async () => {
    const form = imageForm();
    onGet = (n) => {
      if (n === 1) form.set("filename", new Blob(["other-bytes"]), "b.png");
    };
    await inCall(() => clientWith().postMultipart(`/${ACT}/adimages`, form), "ads_upload_ad_image").run;
    const file = sentForm().get("filename") as File;
    expect(file).toBeInstanceOf(Blob);
    expect(await file.text()).toBe("original-bytes");
    expect(file.name).toBe("a.png");
  });

  it("a duplicate JSON key in a multipart field is sent as the descriptor read it (the last value)", async () => {
    const form = new FormData();
    form.append("name", "ad");
    form.append("adset_id", ADSET);
    form.append("status", "PAUSED");
    form.append("creative", '{"name":"first","name":"second"}');
    await inCall(() => clientWith().postMultipart(`/${ACT}/ads`, form), "ads_create_ad").run;
    expect(writes()).toHaveLength(1);
    expect(JSON.parse(String(sentForm().get("creative")))).toEqual({ name: "second" });
    expect(sentForm().get("creative")).toBe('{"name":"second"}');
  });

  it("a string field whose text is <file> is sent as that string, not as a file", async () => {
    const form = imageForm();
    form.set("name", "<file>");
    await inCall(() => clientWith().postMultipart(`/${ACT}/adimages`, form), "ads_upload_ad_image").run;
    expect(sentForm().get("name")).toBe("<file>");
    expect(sentForm().get("filename")).toBeInstanceOf(Blob);
  });

  it("the caller's form is left as it was (its access_token too)", async () => {
    const form = imageForm();
    form.append("ACCESS_TOKEN", "x");
    await inCall(() => clientWith().postMultipart(`/${ACT}/adimages`, form), "ads_upload_ad_image").run;
    expect([...form.keys()]).toEqual(["filename", "name", "ACCESS_TOKEN"]);
    expect([...sentForm().keys()]).toEqual(["filename", "name"]);
  });
});

// ---- not sent is not sent ----

describe("a write the guard allowed and the client never sent", () => {
  const NOT_SENT: Record<string, { arrange: (c: MetaApiClient) => void; write: (c: MetaApiClient) => Promise<unknown> }> = {
    "circuit open": {
      arrange: (c) => {
        const breaker = (c as unknown as { circuitBreaker: { trip: (x: unknown, k: unknown) => void } }).circuitBreaker;
        afterAllow(() =>
          breaker.trip(
            { tokenHash: hashToken("test-access-token"), accountId: CAMP, type: "ads_management" },
            { category: "abuse_signal", mcpError: new Error("abuse") },
          ));
      },
      write: (c) => c.postForm(`/${CAMP}`, { name: "x" }),
    },
    "a pacing deadline": {
      arrange: (c) => {
        const pacer = (c as unknown as { writePacer: { acquire: () => Promise<void> } }).writePacer;
        vi.spyOn(pacer, "acquire").mockReturnValue(new Promise<void>(() => {}));
      },
      write: (c) => c.postForm(`/${CAMP}`, { name: "x" }, { timeoutMs: 50 }),
    },
    "no token": {
      // The token is gone once the guard has allowed: the registry has none and the env has none.
      arrange: () =>
        afterAllow(() => {
          delete process.env.META_ACCESS_TOKEN;
          vi.spyOn(tokenManager, "getActiveToken").mockReturnValue(null);
        }),
      write: (c) => c.postForm(`/${CAMP}`, { name: "x" }),
    },
    "the query-param refusal": {
      arrange: () => {
        type BuildUrl = (method: string, path: string, params?: Record<string, unknown>) => string;
        const proto = MetaApiClient.prototype as unknown as { buildUrl: BuildUrl };
        const real = proto.buildUrl;
        vi.spyOn(proto, "buildUrl").mockImplementation(function (this: MetaApiClient, method, path, params) {
          const url = real.call(this, method, path, params);
          return method === "GET" ? url : `${url}?extra=1`;
        });
      },
      write: (c) => c.postForm(`/${CAMP}`, { name: "x" }),
    },
  };

  it.each(Object.keys(NOT_SENT))(
    "%s: one ok:false outcome, empty ctx.sent, one not-sent entry, fate not-sent, the wrapper's line",
    async (name) => {
      const client = clientWith();
      NOT_SENT[name].arrange(client);
      const { r, ctx } = await served(() => NOT_SENT[name].write(client));
      expect(writes()).toEqual([]);
      expect(descriptors()).toHaveLength(1);
      const os = outcomes();
      expect(os).toEqual([expect.objectContaining({ outcome_for: descriptors()[0].request_id, ok: false, meta_id: null })]);
      const error = String(os[0].error);
      expect(error.length).toBeGreaterThan(0);
      expect(ctx.sent).toEqual([]);
      expect(notSentOf(ctx)).toEqual([{ method: "POST", path: `/${CAMP}`, error }]);
      expect(lastWriteFate(ctx)).toBe("not-sent");
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(`allowed but not sent: POST /${CAMP}: ${error}`);
    },
  );

  it("the query-param refusal is the call's refusal, with the not-sent line after the sent ones", async () => {
    NOT_SENT["the query-param refusal"].arrange(clientWith());
    const { r } = await served(() => clientWith().postForm(`/${CAMP}`, { name: "x" }));
    const reason = refused("the URL carries a query parameter the request did not name");
    expect(textOf(r)).toBe(`${reason}\nwrites sent before it: none\nallowed but not sent: POST /${CAMP}: ${reason}`);
  });

  it("a not-sent write after a sent one: the sent line, then the not-sent line, as an extra text line", async () => {
    const client = clientWith();
    const pacer = (client as unknown as { writePacer: { acquire: () => Promise<void> } }).writePacer;
    const { r, ctx } = await served(async () => {
      await client.postForm(`/${CAMP}`, { name: "a" });
      vi.spyOn(pacer, "acquire").mockReturnValue(new Promise<void>(() => {}));
      await client.postForm(`/${CAMP}`, { name: "b" }, { timeoutMs: 50 });
    });
    expect(writes()).toHaveLength(1);
    expect(ctx.sent).toHaveLength(1);
    expect(notSentOf(ctx)).toHaveLength(1);
    expect(r.content.at(-1)?.text).toBe(`allowed but not sent: POST /${CAMP}: ${notSentOf(ctx)[0].error}`);
  });

  it("under validate_only, a write sent and one not sent at once: the not-sent line after the sent write's lines", async () => {
    const client = clientWith();
    const pacer = (client as unknown as { writePacer: { acquire: (t: string, a: string) => Promise<void> } }).writePacer;
    const acquire = pacer.acquire.bind(pacer);
    // Pacing holds only the ad set's write, past its limit; the two start together, so neither is stopped by the other.
    vi.spyOn(pacer, "acquire").mockImplementation((t, a) => (a === ADSET ? new Promise<void>(() => {}) : acquire(t, a)));
    const { r, ctx } = await served(
      () => Promise.allSettled([client.postForm(`/${CAMP}`, { name: "a" }), client.postForm(`/${ADSET}`, { name: "b" }, { timeoutMs: 50 })]),
      { validate_only: true },
    );
    expect(writes()).toHaveLength(1);
    expect(notSentOf(ctx)).toHaveLength(1);
    const lines = textOf(r).split("\n");
    expect(lines.slice(0, 2)).toEqual([`POST /${CAMP} sent with validate_only`, "Meta's answer: {\"success\":true}"]);
    expect(lines[3]).toBe(`allowed but not sent: POST /${ADSET}: ${notSentOf(ctx)[0].error}`);
  });

  it("a sent write that fails is in ctx.sent, never in the not-sent list", async () => {
    onWrite = () => mockFetchResponse({ message: "busy" }, { status: 500 });
    const { ctx } = await served(() => clientWith().postForm(`/${CAMP}`, { name: "x" }));
    expect(writes()).toHaveLength(1);
    expect(ctx.sent).toEqual([expect.objectContaining({ ok: false })]);
    expect(notSentOf(ctx)).toEqual([]);
  });
});

// ---- the fate of the call's most recent write ----

describe("lastWriteFate", () => {
  const fateOf = async (write: (c: MetaApiClient) => Promise<unknown>, opts: { timeout?: number; maxRetries?: number } = {}) => {
    const { ctx, run } = inCall(() => write(clientWith(opts)));
    await run.catch(() => {});
    return lastWriteFate(ctx);
  };
  const campaignUpdate = (c: MetaApiClient) => c.postForm(`/${CAMP}`, { name: "x" });

  it("a timeout: unknown", async () => {
    onWrite = (c) =>
      new Promise<Response>((_, reject) => {
        c.init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
      });
    expect(await fateOf(campaignUpdate, { timeout: 50 })).toBe("unknown");
  });

  it("a transport error after the fetch: unknown", async () => {
    onWrite = () => Promise.reject(new TypeError("fetch failed"));
    expect(await fateOf(campaignUpdate)).toBe("unknown");
  });

  it("a 500: unknown", async () => {
    onWrite = () => mockFetchResponse({ message: "busy" }, { status: 500 });
    expect(await fateOf(campaignUpdate)).toBe("unknown");
  });

  it("a 2xx whose body read throws: unknown", async () => {
    onWrite = () =>
      ({ ok: true, status: 200, headers: new Headers(), json: async () => { throw new SyntaxError("Unexpected end of JSON input"); } }) as unknown as Response;
    expect(await fateOf(campaignUpdate)).toBe("unknown");
  });

  it("a 400: failed", async () => {
    onWrite = () => mockFetchResponse({ error: { code: 100, type: "OAuthException", message: "invalid" } }, { status: 400 });
    expect(await fateOf(campaignUpdate)).toBe("failed");
  });

  it("a 400 without a Meta error body: failed", async () => {
    onWrite = () => mockFetchResponse({ message: "bad" }, { status: 400 });
    expect(await fateOf(campaignUpdate)).toBe("failed");
  });

  it("a 4xx answer that is retried, then a timeout: unknown (the last attempt had no answer)", async () => {
    vi.spyOn(MetaApiClient.prototype as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
    let n = 0;
    onWrite = (c) =>
      ++n === 1
        ? mockFetchResponse({ error: { code: 2, type: "OAuthException", message: "transient" } }, { status: 400 })
        : new Promise<Response>((_, reject) => {
          c.init?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })));
        });
    expect(await fateOf(campaignUpdate, { timeout: 50, maxRetries: 1 })).toBe("unknown");
    expect(writes()).toHaveLength(2);
  });

  it("success: ok", async () => {
    expect(await fateOf(campaignUpdate)).toBe("ok");
  });

  it("a call that sent no write: null", async () => {
    expect(await fateOf((c) => c.get(`/${CAMP}`, { fields: "id" }))).toBeNull();
  });

  it("a shape refusal: null", async () => {
    expect(await fateOf((c) => c.postForm(`/${CAMP}`, { "method[0]": "x" }))).toBeNull();
  });

  it("the gate's key-set refusal: null, and not in the not-sent list", async () => {
    const { ctx, run } = inCall(() => clientWith().postForm(`/${CAMP}`, { bid_amount: "1" }));
    await run.catch(() => {});
    expect(ctx.refusal).toBe(refused(`bid_amount is not a key of POST /{campaign_id}`));
    expect(lastWriteFate(ctx)).toBeNull();
    expect(notSentOf(ctx)).toEqual([]);
  });

  it("is the most recent write's: a failed write and then a sent one is ok", async () => {
    let n = 0;
    onWrite = () => (++n === 1 ? mockFetchResponse({ message: "bad" }, { status: 400 }) : mockFetchResponse({ success: true }));
    const { ctx, run } = inCall(async () => {
      const c = clientWith();
      await c.postForm(`/${CAMP}`, { name: "a" }).catch(() => {});
      expect(lastWriteFate(ctx)).toBe("failed");
      await c.postForm(`/${CAMP}`, { name: "b" });
    });
    await run;
    expect(lastWriteFate(ctx)).toBe("ok");
  });
});
