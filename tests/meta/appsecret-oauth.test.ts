import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  exchangeCodeForToken,
  exchangeForLongLivedToken,
  fetchPrimaryBusiness,
  fetchProfile,
  validateToken,
  type MetaOAuthConfig,
} from "../../src/auth/meta-oauth.js";
import { TEST_APP_SECRET, bearerTokenOf, mockFetchResponse } from "../setup.js";

// The OAuth helpers' Graph reads are signed like the client's (fork review
// M1, M2): the token only in the Bearer header, its appsecret_proof in the
// query. Every OAuth fetch refuses redirects (M14). The proof is computed
// here, never by the code under test.
const TOKEN = "token-x";
const expectedProof = (token: string) => createHmac("sha256", TEST_APP_SECRET).update(token).digest("hex");

type Call = [string, RequestInit | undefined];
const calls = (): Call[] => vi.mocked(fetch).mock.calls as unknown as Call[];

function assertSigned([rawUrl, init]: Call): void {
  expect(typeof rawUrl).toBe("string");
  const url = new URL(rawUrl);
  expect(url.host).toBe("graph.facebook.com");
  expect(url.searchParams.get("appsecret_proof")).toBe(expectedProof(TOKEN));
  expect(url.searchParams.has("access_token")).toBe(false);
  expect(rawUrl).not.toContain(TOKEN);
  expect(bearerTokenOf(init)).toBe(TOKEN);
  expect(init?.redirect).toBe("error");
}

const config: MetaOAuthConfig = {
  appId: "1234567890",
  appSecret: TEST_APP_SECRET,
  redirectUri: "https://mcp.example.com/auth/meta/callback",
  apiVersion: "v27.0",
};

describe("the OAuth helpers sign their Graph reads", () => {
  beforeEach(() => {
    process.env.META_APP_SECRET = TEST_APP_SECRET;
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ id: "42", name: "N", data: [{ id: "7", name: "B" }] })));
  });

  afterEach(() => {
    delete process.env.META_APP_SECRET;
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetchProfile signs with the token's proof and sends the token only in the header", async () => {
    await fetchProfile(TOKEN);
    expect(calls()).toHaveLength(1);
    assertSigned(calls()[0]);
    expect(new URL(calls()[0][0]).pathname).toBe("/v27.0/me");
  });

  it("fetchPrimaryBusiness signs the same way", async () => {
    await expect(fetchPrimaryBusiness(TOKEN)).resolves.toEqual({ id: "7", name: "B" });
    expect(calls()).toHaveLength(1);
    assertSigned(calls()[0]);
    expect(new URL(calls()[0][0]).pathname).toBe("/v27.0/me/businesses");
  });

  it("validateToken signs through fetchProfile", async () => {
    await expect(validateToken(TOKEN)).resolves.toMatchObject({ valid: true });
    assertSigned(calls()[0]);
  });

  it("refuses an explicit version other than v27.0 before any request", async () => {
    await expect(fetchProfile(TOKEN, "v26.0")).rejects.toThrow(/v27\.0/);
    await expect(fetchPrimaryBusiness(TOKEN, "v26.0")).rejects.toThrow(/v27\.0/);
    const checked = await validateToken(TOKEN, "v26.0");
    expect(checked.valid).toBe(false);
    expect(checked.error).toMatch(/v27\.0/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("refuses redirects on both code exchanges", async () => {
    vi.mocked(fetch).mockResolvedValue(mockFetchResponse({ access_token: "issued", expires_in: 3600 }));
    await exchangeCodeForToken(config, "the-code");
    await exchangeForLongLivedToken(config, "short-lived");
    expect(calls()).toHaveLength(2);
    for (const [url, init] of calls()) {
      expect(new URL(url).host).toBe("graph.facebook.com");
      expect(init?.redirect).toBe("error");
    }
  });
});

describe("no app secret, no OAuth Graph read", () => {
  beforeEach(() => {
    delete process.env.META_APP_SECRET;
    vi.stubGlobal("fetch", vi.fn(async () => mockFetchResponse({ id: "42", data: [{ id: "7" }] })));
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("fetchProfile refuses before fetch", async () => {
    await expect(fetchProfile(TOKEN)).rejects.toThrow(/META_APP_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("fetchPrimaryBusiness returns null and sends nothing", async () => {
    await expect(fetchPrimaryBusiness(TOKEN)).resolves.toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("validateToken reports invalid and sends nothing", async () => {
    const checked = await validateToken(TOKEN);
    expect(checked.valid).toBe(false);
    expect(checked.error).toMatch(/META_APP_SECRET/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
