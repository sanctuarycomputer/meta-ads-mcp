// M3, the answer clean (spec check 1; plan task 7): every successful answer the client returns, through get,
// getPaginated, getDetached, post, postForm, postMultipart and delete, is cleaned on a copy and nothing more: every
// access_token key removed; an http(s) URL loses its access_token and appsecret_proof parameters, every other byte
// kept; every held secret redacted by value. Advertiser text (token=abc), a cursor and an EAA-shaped run come back
// as they were. The gate is the pass-through one: only the clean is under test.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetaApiClient } from "../../src/meta/client.js";
import { cleanAnswer, withHeldSecret } from "../../src/utils/scrub-credentials.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import { PASS } from "../setup-write-gate.js";

// Built at run time: no token-shaped literal in the repo (gitleaks).
const USER = `user-${"u".repeat(24)}`;
const PAGE = `page-${"p".repeat(24)}`;
// A credential the process does not hold: only the key rule or the URL rule removes it.
const FOREIGN = ["foreign", "credential", String(process.pid)].join("-");
// A cursor shaped like a Meta token ("EAA" and 40 letters and digits): an answer never meets that pattern.
const CURSOR = `EAA${"Q".repeat(20)}${"z9".repeat(10)}`;
const PROOF = "ab".repeat(32);
const NEXT_KEPT = `https://graph.facebook.com/v27.0/act_1/ads?limit=25&after=${CURSOR}&fields=id%2Cname`;
const NEXT = `https://graph.facebook.com/v27.0/act_1/ads?access_token=${FOREIGN}&limit=25&after=${CURSOR}&fields=id%2Cname`;

const answer = () => ({
  id: "1",
  access_token: FOREIGN,
  nested: { deep: [{ ACCESS_TOKEN: FOREIGN, keep: "k" }] },
  link_url: "https://shop.example/p?token=abc&utm_source=fb",
  url_tags: "token=abc&utm_medium=paid",
  picture: `https://cdn.example/p.jpg?oh=1&APPSECRET_PROOF=${PROOF}#access%5Ftoken=${FOREIGN}&state=2`,
  note: `held ${PAGE} here`,
  paging: { cursors: { after: CURSOR }, next: NEXT },
});
const cleaned = {
  id: "1",
  nested: { deep: [{ keep: "k" }] },
  link_url: "https://shop.example/p?token=abc&utm_source=fb",
  url_tags: "token=abc&utm_medium=paid",
  picture: "https://cdn.example/p.jpg?oh=1#state=2",
  note: "held [REDACTED] here",
  paging: { cursors: { after: CURSOR }, next: NEXT_KEPT },
};

const clientWith = () => new MetaApiClient({ maxRetries: 0, writeGateForTests: PASS });

beforeEach(() => {
  setupTestToken(USER);
});
afterEach(() => {
  cleanupTestToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const ACT = "act_9994000000000001";
const CAMP = "9994000000000001";
const multipart = () => {
  const f = new FormData();
  f.append("name", "x");
  return f;
};

const METHODS: Array<[string, (c: MetaApiClient) => Promise<unknown>]> = [
  ["get", (c) => c.get(`/${CAMP}`, { fields: "id,name" })],
  ["getDetached", (c) => c.getDetached(`/${CAMP}`, { fields: "id,name" }, new AbortController().signal, USER)],
  ["post", (c) => c.post(`/${CAMP}`, { name: "x" })],
  ["postForm", (c) => c.postForm(`/${CAMP}`, { name: "x" })],
  ["postMultipart", (c) => c.postMultipart(`/${ACT}/adimages`, multipart())],
  ["delete", (c) => c.delete(`/${CAMP}`)],
];

describe("every answer is cleaned, and nothing more", () => {
  for (const [name, send] of METHODS) {
    it(`${name}: access_token keys at the top and nested gone, URLs lose only their token parameters, a held token is redacted`, async () => {
      const body = answer();
      vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(body)));

      const got = await withHeldSecret(PAGE, () => send(clientWith()));

      expect(got).toEqual(cleaned);
      // On a copy: the parsed answer itself is untouched.
      expect(body).toEqual(answer());
    });
  }

  it("getPaginated: each page's items are cleaned, and the cursor goes back to Meta as it came", async () => {
    const fetch = vi.fn()
      .mockResolvedValueOnce(mockFetchResponse({ data: [answer()], paging: { cursors: { after: CURSOR }, next: NEXT } }))
      .mockResolvedValueOnce(mockFetchResponse({ data: [{ id: "2", access_token: FOREIGN, url_tags: "token=abc" }] }));
    vi.stubGlobal("fetch", fetch);

    const items = await withHeldSecret(PAGE, () => clientWith().getPaginated(`/${ACT}/ads`, { fields: "id,name" }));

    expect(items).toEqual([cleaned, { id: "2", url_tags: "token=abc" }]);
    expect(new URL(String(fetch.mock.calls[1][0])).searchParams.get("after")).toBe(CURSOR);
  });
});

describe("cleanAnswer's edges", () => {
  it("keeps prose that starts with a URL, a non-http URL, and an empty query mark as they were", () => {
    const kept = [
      `https://x.test/?access_token=${FOREIGN} is our link`,
      `ftp://x.test/?access_token=${FOREIGN}`,
      "https://x.test/?",
      "https://x.test/#/route?a=b",
    ];
    expect(cleanAnswer(kept)).toEqual(kept);
  });

  it("drops a mark left with nothing after it, and reads a path-shaped fragment's parameters after its ?", () => {
    expect(cleanAnswer(`https://x.test/p?access_token=${FOREIGN}`)).toBe("https://x.test/p");
    expect(cleanAnswer(`https://x.test/p#/cb?access_token=${FOREIGN}&s=1`)).toBe("https://x.test/p#/cb?s=1");
    expect(cleanAnswer(`https://x.test/p#/cb?access_token=${FOREIGN}`)).toBe("https://x.test/p#/cb");
  });

  it("redacts the env's own token by value, and keeps any other credential-named key", () => {
    expect(cleanAnswer({ m: `echo ${USER}`, client_secret: "kept", token: "kept" })).toEqual({
      m: "echo [REDACTED]",
      client_secret: "kept",
      token: "kept",
    });
  });
});
