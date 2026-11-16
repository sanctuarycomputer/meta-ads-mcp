import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { MetaApiClient, metaApiClient, signGraphRequest } from "../../src/meta/client.js";
import { PASS } from "../setup-write-gate.js";
import { RateLimiter } from "../../src/meta/rate-limiter.js";
import { WritePacer } from "../../src/meta/write-pacer.js";
import { withPageToken } from "../../src/meta/page-token.js";
import { tokenManager } from "../../src/auth/token-manager.js";
import { getAccessToken, getAccessTokenHash, requestContext } from "../../src/auth/token-store.js";
import { scrubbed } from "../../src/meta/read-list.js";
import { logger } from "../../src/utils/logger.js";
import { TEST_APP_SECRET, bearerTokenOf, cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

// Every Graph request is signed (fork review M1, M2): the token travels only
// in `Authorization: Bearer`, and `appsecret_proof` is the HMAC-SHA256 of
// that same token keyed by the app secret. The proof is computed here, never
// by the code under test.
const TOKEN = "test-access-token";
const expectedProof = (token: string, secret = TEST_APP_SECRET) =>
  createHmac("sha256", secret).update(token).digest("hex");

type Call = [string, RequestInit | undefined];
const calls = (): Call[] => vi.mocked(fetch).mock.calls as unknown as Call[];

// Names and values a body carries, whatever its kind.
function bodyEntries(body: RequestInit["body"]): Array<[string, string]> {
  if (body === undefined || body === null) return [];
  if (body instanceof URLSearchParams || body instanceof FormData) {
    return [...body.entries()].map(([name, value]) => [name, String(value)]);
  }
  const text = String(body);
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed && typeof parsed === "object") return Object.entries(parsed).map(([name, value]) => [name, JSON.stringify(value)]);
  } catch { /* not JSON */ }
  return [...new URLSearchParams(text).entries()];
}

function assertSigned([rawUrl, init]: Call, token: string, absent: string[] = [token]): void {
  expect(typeof rawUrl).toBe("string");
  const url = new URL(rawUrl);
  expect(url.searchParams.get("appsecret_proof")).toBe(expectedProof(token));
  expect(url.searchParams.has("access_token")).toBe(false);
  expect(bearerTokenOf(init)).toBe(token);
  expect(init?.redirect).toBe("error");
  const entries = bodyEntries(init?.body);
  expect(entries.map(([name]) => name)).not.toContain("access_token");
  for (const secret of absent) {
    expect(rawUrl).not.toContain(secret);
    for (const [name, value] of entries) {
      expect(name).not.toContain(secret);
      expect(value).not.toContain(secret);
    }
    if (typeof init?.body === "string") expect(init.body).not.toContain(secret);
  }
}

describe("every Graph request is signed with appsecret_proof", () => {
  let client: MetaApiClient;

  beforeEach(() => {
    setupTestToken(TOKEN);
    tokenManager.resetForTests();
    metaApiClient.resetForTests();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ data: [], id: "1", success: true })));
    client = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
  });

  afterEach(() => {
    cleanupTestToken();
    tokenManager.resetForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([
    ["get", (c: MetaApiClient) => c.get("/me/adaccounts", { fields: "id" })],
    ["post", (c: MetaApiClient) => c.post("/120001", { name: "x" })],
    ["postForm", (c: MetaApiClient) => c.postForm("/120001", { name: "x" })],
    ["postMultipart", (c: MetaApiClient) => {
      const form = new FormData();
      form.set("name", "x");
      return c.postMultipart("/120001/assets", form);
    }],
    ["delete", (c: MetaApiClient) => c.delete("/120001")],
  ])("%s sends the token only in the Bearer header, with its proof", async (_name, send) => {
    await send(client);
    expect(calls()).toHaveLength(1);
    assertSigned(calls()[0], TOKEN);
  });

  it("keeps the caller's content type beside the Bearer header", async () => {
    await client.post("/120001", { name: "x" });
    await client.postForm("/120001", { name: "x" });
    expect((calls()[0][1]?.headers as Record<string, string>)["Content-Type"]).toBe("application/json");
    expect((calls()[1][1]?.headers as Record<string, string>)["Content-Type"]).toBe("application/x-www-form-urlencoded");
    expect(bearerTokenOf(calls()[0][1])).toBe(TOKEN);
    expect(bearerTokenOf(calls()[1][1])).toBe(TOKEN);
  });

  it("lets no caller header replace or sit beside the Bearer header", async () => {
    // execute is the one choke point every method goes through; no public
    // method passes caller headers today, so it is driven directly.
    const execute = (client as unknown as { execute: (m: string, u: string, p: string, params: Record<string, unknown>, o?: RequestInit) => Promise<unknown> }).execute.bind(client);
    await execute("GET", "https://graph.facebook.com/v27.0/me", "/me", {}, { headers: { authorization: "Bearer other-token", "X-Extra": "1" } });
    await execute("GET", "https://graph.facebook.com/v27.0/me", "/me", {}, { headers: new Headers({ Authorization: "Bearer other-token", "X-Extra": "1" }) });
    await execute("GET", "https://graph.facebook.com/v27.0/me", "/me", {}, { headers: [["AUTHORIZATION", "Bearer other-token"], ["X-Extra", "1"]] });
    expect(calls()).toHaveLength(3);
    for (const [, init] of calls()) {
      const headers = init?.headers as Record<string, string>;
      const auth = Object.entries(headers).filter(([name]) => name.toLowerCase() === "authorization");
      expect(auth).toEqual([["Authorization", `Bearer ${TOKEN}`]]);
      expect(Object.entries(headers).find(([name]) => name.toLowerCase() === "x-extra")?.[1]).toBe("1");
    }
  });

  it("drops an access_token a caller put in a multipart form", async () => {
    const form = new FormData();
    form.set("access_token", "smuggled-token");
    await client.postMultipart("/120001/assets", form);
    assertSigned(calls()[0], TOKEN, [TOKEN, "smuggled-token"]);
  });

  it("signs every page of a paginated read", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse({ data: [{ id: "1" }], paging: { cursors: { after: "c1" }, next: "https://graph.facebook.com/next" } }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [{ id: "2" }] }));
    await client.getPaginated("/act_1/campaigns", { fields: "id" });
    expect(calls()).toHaveLength(2);
    for (const call of calls()) assertSigned(call, TOKEN);
  });

  it("signs a detached read with the token its caller names", async () => {
    await client.getDetached("/act_1", { fields: "currency" }, new AbortController().signal, "tenant-b-token");
    expect(calls()).toHaveLength(1);
    assertSigned(calls()[0], "tenant-b-token", ["tenant-b-token", TOKEN]);
  });

  it("signs a retried call on every attempt", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    try {
      const retrying = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 1 });
      vi.mocked(fetch)
        .mockResolvedValueOnce(mockFetchResponse({}, { status: 500 }))
        .mockResolvedValueOnce(mockFetchResponse({ id: "1" }));
      const done = retrying.get("/120001");
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(calls()).toHaveLength(2);
    for (const call of calls()) assertSigned(call, TOKEN);
  });

  it("signs a Page-token request with the Page token's proof", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: "PAGE-TOKEN" }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [] }));
    await withPageToken("6001", () => metaApiClient.get("/6001/leadgen_forms"));
    expect(calls()).toHaveLength(2);
    // The lookup asks for the field by name: the literal is a value there, never the token.
    expect(new URL(calls()[0][0]).searchParams.get("fields")).toBe("access_token");
    assertSigned(calls()[0], TOKEN, [TOKEN, "PAGE-TOKEN"]);
    assertSigned(calls()[1], "PAGE-TOKEN", [TOKEN, "PAGE-TOKEN"]);
  });

  it("trims the secret before signing", async () => {
    process.env.META_APP_SECRET = `${TEST_APP_SECRET}\n`;
    await client.get("/me");
    expect(new URL(calls()[0][0]).searchParams.get("appsecret_proof")).toBe(expectedProof(TOKEN, TEST_APP_SECRET));
  });

  it("refuses a redirect and never contacts another URL", async () => {
    // What undici throws for `redirect: "error"` when Graph answers 3xx.
    vi.mocked(fetch).mockRejectedValue(Object.assign(new TypeError("fetch failed"), { cause: new TypeError("unexpected redirect") }));
    vi.useFakeTimers({ toFake: ["setTimeout"] });
    let failure: unknown;
    try {
      const retrying = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 1 });
      const done = retrying.get("/120001").catch((err: unknown) => { failure = err; });
      await vi.runAllTimersAsync();
      await done;
    } finally {
      vi.useRealTimers();
    }
    expect(failure).toBeInstanceOf(Error);
    expect(calls()).toHaveLength(2);
    for (const [url, init] of calls()) {
      expect(new URL(url).host).toBe("graph.facebook.com");
      expect(init?.redirect).toBe("error");
    }
  });
});

describe("signGraphRequest", () => {
  afterEach(() => {
    delete process.env.META_APP_SECRET;
  });

  it("removes an access_token already in the URL and sets the proof of the token it signs", () => {
    process.env.META_APP_SECRET = TEST_APP_SECRET;
    const url = new URL("https://graph.facebook.com/v27.0/me?access_token=other-token&fields=id");
    expect(signGraphRequest(url, TOKEN)).toEqual({ Authorization: `Bearer ${TOKEN}` });
    expect(url.searchParams.has("access_token")).toBe(false);
    expect(url.searchParams.get("fields")).toBe("id");
    expect(url.searchParams.get("appsecret_proof")).toBe(expectedProof(TOKEN));
  });
});

// A token is sent as a header value, which can't carry whitespace or control
// characters: fetch would throw quoting "Bearer <token>". Such a token is
// refused before anything is built, by a message that never quotes it
// (final-1b R1). Surrounding whitespace is trimmed, and the trimmed token is
// both sent and signed (R2).
const LEFT = "LEFTPIECE";
const RIGHT = "RIGHTPIECE";
const BAD_TOKENS = ["\n", "\r", "\r\n", " ", "\t", "\u0000", "\u007f", "\u00e9", "\u2028"].map((c) => [JSON.stringify(c), `${LEFT}${c}${RIGHT}`]);
// A token of whitespace only trims to nothing, and an empty one is nothing (final-2b R4).
const EMPTY_TOKENS = [["empty", ""], ["blank", "  \n\t "]];
const quotes = (text: string) => text.includes(LEFT) || text.includes(RIGHT);

describe("a token that can't be a header value", () => {
  let client: MetaApiClient;

  beforeEach(() => {
    setupTestToken(TOKEN);
    tokenManager.resetForTests();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ id: "1" })));
    client = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
  });

  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it.each(BAD_TOKENS)("signGraphRequest refuses a token holding %s without quoting it", (_label, bad) => {
    let message = "";
    try {
      signGraphRequest(new URL("https://graph.facebook.com/v27.0/me"), bad);
    } catch (err) {
      message = (err as Error).message;
    }
    expect(message).toMatch(/access token/i);
    expect(quotes(message)).toBe(false);
  });

  it.each(EMPTY_TOKENS)("signGraphRequest refuses an %s token", (_label, bad) => {
    expect(() => signGraphRequest(new URL("https://graph.facebook.com/v27.0/me"), bad)).toThrow(/access token/i);
  });

  it("logs a detached read refused for its token as such, not as a missing secret", async () => {
    const debug = vi.spyOn(logger, "debug");
    await expect(client.getDetached("/act_1", { fields: "currency" }, new AbortController().signal, `${LEFT}\n${RIGHT}`)).resolves.toBeUndefined();
    const lines = debug.mock.calls.map((args) => JSON.stringify(args)).join("\n");
    expect(lines).toMatch(/access token/i);
    expect(lines).not.toMatch(/META_APP_SECRET is not set/);
    expect(quotes(lines)).toBe(false);
  });

  it.each(BAD_TOKENS)("a client request with a token holding %s is refused unsent and unquoted", async (_label, bad) => {
    const failure = await requestContext.run({ accessToken: bad }, () => client.get("/me")).then(() => undefined, (err: unknown) => err as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(quotes(String(failure?.message))).toBe(false);
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each(BAD_TOKENS)("a detached read with a token holding %s resolves undefined unsent", async (_label, bad) => {
    await expect(client.getDetached("/act_1", { fields: "currency" }, new AbortController().signal, bad)).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("trims a token's surrounding whitespace, and sends and signs the trimmed token", async () => {
    await requestContext.run({ accessToken: `  ${TOKEN}\n` }, () => client.get("/me"));
    const [url, init] = calls()[0];
    expect(bearerTokenOf(init)).toBe(TOKEN);
    expect(new URL(url).searchParams.get("appsecret_proof")).toBe(expectedProof(TOKEN));
  });

  // The token is trimmed where it is read, so the value sent, signed, hashed
  // and scrubbed is one string (final-2b R1, final-2 F1).
  const logged = () => [logger.info, logger.warn, logger.error, logger.fatal, logger.debug]
    .flatMap((fn) => vi.mocked(fn).mock.calls)
    .map((args) => JSON.stringify(args))
    .join("\n");
  const quoteBack = () => mockFetchResponse(
    { error: { code: 190, type: "OAuthException", message: `Bad token ${TOKEN} seen` } },
    { status: 400 },
  );

  it.each([["request context", "context"], ["env", "env"]])(
    "scrubs a padded %s token from a Meta error that quotes it, in the error and the logs",
    async (_label, where) => {
      for (const level of ["info", "warn", "error", "fatal", "debug"] as const) vi.spyOn(logger, level);
      vi.mocked(fetch).mockResolvedValue(quoteBack());
      const padded = `${TOKEN}\n`;
      if (where === "env") process.env.META_ACCESS_TOKEN = padded;
      const call = () => client.get("/me");
      const failure = await (where === "env" ? call() : requestContext.run({ accessToken: padded }, call))
        .then(() => undefined, (err: unknown) => err as Error);
      expect(failure).toBeInstanceOf(Error);
      expect(String(failure?.message)).not.toContain(TOKEN);
      expect(logged()).not.toContain(TOKEN);
    },
  );

  it("scrubs a padded token from a transport error that quotes it", async () => {
    process.env.META_ACCESS_TOKEN = `${TOKEN}\n`;
    vi.mocked(fetch).mockRejectedValue(new TypeError(`connect failed for ${TOKEN}`));
    const failure = await client.get("/me").then(() => undefined, (err: unknown) => err as Error);
    expect(String(failure?.message)).not.toContain(TOKEN);
  });

  it("scrubs a padded token from a successful answer cleaned by scrubbed()", () => {
    process.env.META_ACCESS_TOKEN = `${TOKEN}\n`;
    expect(JSON.stringify(scrubbed({ note: `a note quoting ${TOKEN} here` }))).not.toContain(TOKEN);
  });

  it("reads a padded token as the trimmed one, so its rate state is keyed as the client keys it", async () => {
    process.env.META_ACCESS_TOKEN = `  ${TOKEN}\n`;
    expect(getAccessToken()).toBe(TOKEN);
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ id: "1" }, { headers: { "x-app-usage": JSON.stringify({ call_count: 12, total_cputime: 3, total_time: 4 }) } }));
    await client.get("/act_123/campaigns");
    expect(client.getUsageSnapshotFor(getAccessTokenHash()).usage.length).toBeGreaterThan(0);
  });

  it("trims an env token the same way", async () => {
    process.env.META_ACCESS_TOKEN = `${TOKEN}\n`;
    await client.get("/me");
    const [url, init] = calls()[0];
    expect(bearerTokenOf(init)).toBe(TOKEN);
    expect(new URL(url).searchParams.get("appsecret_proof")).toBe(expectedProof(TOKEN));
  });
});

// No access_token travels anywhere but the header, in any letter case and in
// any kind of body (final-1b R3, final-1 F4).
describe("access_token in any letter case, in the URL or a body", () => {
  let client: MetaApiClient;

  beforeEach(() => {
    setupTestToken(TOKEN);
    tokenManager.resetForTests();
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ id: "1" })));
    client = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
  });

  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  const named = (entries: Array<[string, string]>) => entries.filter(([name]) => name.toLowerCase() === "access_token");

  it("removes it from the query", async () => {
    await client.get("/me", { ACCESS_TOKEN: "smuggled-one", Access_Token: "smuggled-two", fields: "id" });
    const url = new URL(calls()[0][0]);
    expect(named([...url.searchParams.entries()])).toEqual([]);
    expect(url.searchParams.get("fields")).toBe("id");
  });

  it("removes it from a JSON body", async () => {
    await client.post("/120001", { access_token: "smuggled-one", ACCESS_TOKEN: "smuggled-two", name: "x" });
    const body = JSON.parse(String(calls()[0][1]?.body)) as Record<string, unknown>;
    expect(named(Object.entries(body) as Array<[string, string]>)).toEqual([]);
    expect(body.name).toBe("x");
  });

  it("removes it from a form body", async () => {
    await client.postForm("/120001", { Access_Token: "smuggled-one", name: "x" });
    const body = new URLSearchParams(String(calls()[0][1]?.body));
    expect(named([...body.entries()])).toEqual([]);
    expect(body.get("name")).toBe("x");
  });

  it("removes it from a multipart body", async () => {
    const form = new FormData();
    form.set("ACCESS_TOKEN", "smuggled-one");
    form.set("name", "x");
    await client.postMultipart("/120001/assets", form);
    const body = calls()[0][1]?.body as FormData;
    expect(named([...body.entries()].map(([k, v]) => [k, String(v)]))).toEqual([]);
    expect(body.get("name")).toBe("x");
  });
});

describe("no app secret, no request", () => {
  afterEach(() => {
    cleanupTestToken();
    tokenManager.resetForTests();
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it.each([["unset", undefined], ["empty", ""], ["whitespace", "   "]])(
    "throws when constructed with a token and the secret %s",
    (_label, secret) => {
      process.env.META_ACCESS_TOKEN = TOKEN;
      if (secret === undefined) delete process.env.META_APP_SECRET;
      else process.env.META_APP_SECRET = secret;
      let message = "";
      try {
        new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
      } catch (err) {
        message = (err as Error).message;
      }
      expect(message).toMatch(/META_APP_SECRET/);
      expect(message).not.toContain(TOKEN);
    },
  );

  it("constructs without a token, and then refuses to send once a token arrives with no secret", async () => {
    delete process.env.META_ACCESS_TOKEN;
    delete process.env.META_APP_SECRET;
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ id: "1" })));
    const client = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
    process.env.META_ACCESS_TOKEN = TOKEN;
    await expect(client.get("/me")).rejects.toThrow(/META_APP_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses before any pacing or rate-limit state is touched", async () => {
    process.env.META_ACCESS_TOKEN = TOKEN;
    process.env.META_APP_SECRET = TEST_APP_SECRET;
    const client = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
    delete process.env.META_APP_SECRET;
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ id: "1" })));
    const wait = vi.spyOn(RateLimiter.prototype, "waitIfNeeded");
    const acquire = vi.spyOn(WritePacer.prototype, "acquire");
    await expect(client.postForm("/act_123/campaigns", { name: "x" })).rejects.toThrow(/META_APP_SECRET/);
    await expect(client.get("/act_123/insights")).rejects.toThrow(/META_APP_SECRET/);
    expect(wait).not.toHaveBeenCalled();
    expect(acquire).not.toHaveBeenCalled();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("resolves a detached read to undefined and sends nothing without a secret", async () => {
    delete process.env.META_APP_SECRET;
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ currency: "USD" })));
    const client = new MetaApiClient({ writeGateForTests: PASS,  maxRetries: 0 });
    await expect(client.getDetached("/act_1", { fields: "currency" }, new AbortController().signal, "tenant-b-token")).resolves.toBeUndefined();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses to load the client module with a token and no secret", async () => {
    vi.resetModules();
    // The real module, not the pass-through gate's mock (tests/setup-write-gate.ts).
    vi.doUnmock("../../src/meta/client.js");
    process.env.META_ACCESS_TOKEN = TOKEN;
    delete process.env.META_APP_SECRET;
    await expect(import("../../src/meta/client.js")).rejects.toThrow(/META_APP_SECRET/);
    vi.resetModules();
  });
});
