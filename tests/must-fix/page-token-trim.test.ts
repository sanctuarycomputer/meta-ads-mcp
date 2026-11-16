import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { withPageToken } from "../../src/meta/page-token.js";
import { metaApiClient, signGraphRequest } from "../../src/meta/client.js";
import { requestContext } from "../../src/auth/token-store.js";
import { heldSecrets } from "../../src/utils/scrub-credentials.js";
import { bearerTokenOf, cleanupTestToken, mockFetchResponse, setupTestToken, TEST_APP_SECRET } from "../setup.js";

// Built at run time: no token-shaped literal in the repo (gitleaks).
const PAGE = `page-${"x".repeat(24)}`;
const PADDED = `  ${PAGE}\n`;
const proofOf = (token: string) => createHmac("sha256", TEST_APP_SECRET).update(token).digest("hex");

describe("withPageToken trims Meta's Page token (spec check 5, Trim)", () => {
  beforeEach(() => {
    setupTestToken(`user-${"y".repeat(24)}`);
    metaApiClient.resetForTests();
  });
  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("scrubs an error echoing the trimmed token when Meta answers a padded one", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: PADDED })));

    const error = (await withPageToken("6001", async () => {
      throw new Error(`Meta echoed ${PAGE} and ${Buffer.from(PAGE).toString("base64")}`);
    }).catch((e: Error) => e)) as Error;

    expect(error.message).toBe("Meta echoed [REDACTED] and [REDACTED]");
  });

  it("runs the work with the trimmed token held and in its context", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: PADDED })));

    // Seen from inside: the result itself goes back scrubbed of the token.
    let seen: { held: string[]; context?: string } | undefined;
    await withPageToken("6001", async () => {
      seen = { held: [...(heldSecrets.getStore() ?? [])], context: requestContext.getStore()?.accessToken };
    });

    expect(seen).toEqual({ held: [PAGE], context: PAGE });
  });

  it("treats a blank Page token as none", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: " \n " })));
    const work = vi.fn(async () => "ran");

    await expect(withPageToken("6001", work)).rejects.toThrow(/Meta returned no Page access token for page 6001/);
    expect(work).not.toHaveBeenCalled();
  });
});

describe("signGraphRequest trims the token it sends and signs", () => {
  beforeEach(() => {
    setupTestToken(`user-${"y".repeat(24)}`);
    metaApiClient.resetForTests();
  });
  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("gives the header and appsecret_proof of the trimmed token when called with a padded one", () => {
    const url = new URL("https://graph.facebook.com/v23.0/act_1?fields=name");

    const auth = signGraphRequest(url, PADDED);

    expect(auth).toEqual({ Authorization: `Bearer ${PAGE}` });
    expect(url.searchParams.get("appsecret_proof")).toBe(proofOf(PAGE));
  });

  it("sends the same header and proof through getDetached with a padded token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "act_1", currency: "USD" })));

    await metaApiClient.getDetached("/act_1", { fields: "currency" }, new AbortController().signal, PADDED);

    const [sentUrl, init] = vi.mocked(fetch).mock.calls[0];
    expect(bearerTokenOf(init)).toBe(PAGE);
    expect(new URL(String(sentUrl)).searchParams.get("appsecret_proof")).toBe(proofOf(PAGE));
  });
});

describe("readPageToken (spec check 1): its own checks", () => {
  beforeEach(() => {
    setupTestToken(`user-${"y".repeat(24)}`);
    metaApiClient.resetForTests();
  });
  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
  });

  it("returns no token when Meta answers a non-string access_token", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: 6001 })));

    expect(await metaApiClient.readPageToken("6001")).toBe("");
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["me/accounts", "me", "6001/accounts", "act_6001", ""])("refuses the page id %j before any request", async (pageId) => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "6001", access_token: PAGE })));

    await expect(metaApiClient.readPageToken(pageId)).rejects.toThrow(/page id must be digits/);
    expect(fetch).not.toHaveBeenCalled();
  });
});
