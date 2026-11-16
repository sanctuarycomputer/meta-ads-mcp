// M3, the field refusal and the one token read (spec check 1; plan task 7): a `fields` or `fields[…]` param (any case)
// naming access_token or a token-bearing edge (TOKEN_EDGES), percent-decoded until stable, at any expansion depth, is
// refused with zero requests sent, on every method; readPageToken, called only from withPageToken, is the one request
// exempt, by a private flag no tool can pass.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MetaApiClient, TOKEN_EDGES, checkRequestShape, fieldNames, metaApiClient } from "../../src/meta/client.js";
import { WriteRefusal } from "../../src/meta/write-descriptor.js";
import { withPageToken } from "../../src/meta/page-token.js";
import { requestContext } from "../../src/auth/token-store.js";
import { bearerTokenOf, cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import { PASS } from "../setup-write-gate.js";

// Built at run time: no token-shaped literal in the repo (gitleaks).
const USER = `user-${"u".repeat(24)}`;
const PAGE = `page-${"p".repeat(24)}`;
const CAMP = "9994000000000001";
const ACT = "act_9994000000000001";

const clientWith = () => new MetaApiClient({ maxRetries: 0, writeGateForTests: PASS });
const refusalOf = async (p: Promise<unknown>): Promise<unknown> => p.then(() => undefined, (e: unknown) => e);

let fetch: ReturnType<typeof vi.fn>;
beforeEach(() => {
  setupTestToken(USER);
  metaApiClient.resetForTests();
  fetch = vi.fn().mockImplementation(async () => mockFetchResponse({ id: "1" }));
  vi.stubGlobal("fetch", fetch);
});
afterEach(() => {
  cleanupTestToken();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const REFUSED: Array<[string, string]> = [
  ["fields", "access_token"],
  ["fields", "ACCESS_TOKEN"],
  ["fields", "access%5Ftoken"],
  ["fields", "access%255Ftoken"],
  ["fields", "id, access_token"],
  ["fields", "promote_pages{access_token}"],
  ["fields", "accounts"],
  ["fields", "accounts{id}"],
  ["fields", "owned_pages.fields(accounts)"],
  ["fields[0]", "access_token"],
  ["FIELDS", "id,access_token"],
];

describe("the fields refusal", () => {
  for (const [key, value] of REFUSED) {
    it(`refuses ${key}=${value} through get, with zero requests`, async () => {
      const e = await refusalOf(clientWith().get(`/${CAMP}`, { [key]: value }));
      expect(e).toBeInstanceOf(WriteRefusal);
      expect((e as Error).message).toMatch(/asks for an access token or a token-bearing edge \(accounts\)/);
      expect(fetch).not.toHaveBeenCalled();
    });
  }

  it("refuses through getDetached, getPaginated and a write too, with zero requests", async () => {
    const c = clientWith();
    for (const p of [
      c.getDetached(`/${CAMP}`, { fields: "accounts{id}" }, new AbortController().signal, USER),
      c.getPaginated(`/${ACT}/ads`, { fields: "id,access_token" }),
      c.postForm(`/${CAMP}`, { name: "x", fields: "access_token" }),
      c.post(`/${CAMP}`, { name: "x", fields: ["id", "access_token"] }),
    ]) {
      expect(await refusalOf(p)).toBeInstanceOf(WriteRefusal);
    }
    expect(fetch).not.toHaveBeenCalled();
  });

  it("checks an array value as the joined string", () => {
    expect(() => checkRequestShape("GET", "https://graph.facebook.com", "/v27.0/1", { fields: ["id", "accounts"] })).toThrow(WriteRefusal);
    expect(() => checkRequestShape("GET", "https://graph.facebook.com", "/v27.0/1", { fields: ["id", "name"] })).not.toThrow();
  });

  for (const value of ["id,name", "account_id", "id,owned_ad_accounts{id}", "access_tokens"]) {
    it(`allows fields=${value} (a whole name is compared, not a part)`, async () => {
      await clientWith().get(`/${CAMP}`, { fields: value });
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  }

  it("lets a param that is not fields name access_token's word (it is a value, not a field asked for)", async () => {
    await clientWith().get(`/${CAMP}`, { summary: "accounts", fieldsx: "access_token" });
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("has accounts as its one token-bearing edge", () => {
    expect([...TOKEN_EDGES]).toEqual(["accounts"]);
  });
});

describe("fieldNames", () => {
  it("decodes until stable, then splits into lower-cased runs of letters, digits and _", () => {
    expect(fieldNames("access%25255Ftoken")).toEqual(["access_token"]);
    expect(fieldNames("Promote_Pages{ACCESS_TOKEN},id")).toEqual(["promote_pages", "access_token", "id"]);
    expect(fieldNames("a%2Cb%")).toEqual(["a", "b"]);
  });
});

describe("the one token read", () => {
  it("withPageToken reads the raw Page token through readPageToken, trimmed, and runs the work with it", async () => {
    fetch.mockReset();
    fetch
      .mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: `  ${PAGE}\n` }))
      .mockResolvedValueOnce(mockFetchResponse({ id: "6001_1" }));
    const read = vi.spyOn(metaApiClient, "readPageToken");

    const seen = await withPageToken("6001", async () => {
      const context = requestContext.getStore()?.accessToken;
      await metaApiClient.get("/6001_1", { fields: "id" });
      return context === PAGE;
    });

    expect(seen).toBe(true);
    expect(read).toHaveBeenCalledWith("6001", undefined);
    expect(new URL(String(fetch.mock.calls[0][0])).searchParams.get("fields")).toBe("access_token");
    expect(bearerTokenOf(fetch.mock.calls[1][1])).toBe(PAGE);
  });

  it("returns only the token, and '' when Meta sends none", async () => {
    fetch.mockResolvedValueOnce(mockFetchResponse({ id: "6001", access_token: PAGE, name: "N" }));
    expect(await clientWith().readPageToken("6001")).toBe(PAGE);
    fetch.mockResolvedValueOnce(mockFetchResponse({ id: "6001" }));
    expect(await clientWith().readPageToken("6001")).toBe("");
  });

  it("refuses the same GET /<page>?fields=access_token through get", async () => {
    expect(await refusalOf(clientWith().get("/6001", { fields: "access_token" }))).toBeInstanceOf(WriteRefusal);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("cannot be asked for by a tool: a scope or extra argument carrying tokenRead is ignored", async () => {
    const c = clientWith();
    const scope = { tokenRead: true, allowTokenField: true } as unknown as Parameters<MetaApiClient["get"]>[2];
    const extra = (fn: (...args: unknown[]) => Promise<unknown>, ...args: unknown[]) => fn.call(c, ...args);
    for (const p of [
      c.get("/6001", { fields: "access_token" }, scope),
      extra(c.get as never, "/6001", { fields: "access_token" }, scope, true),
      extra(c.getPaginated as never, "/6001/feed", { fields: "access_token" }, 10, true),
      extra(c.getDetached as never, "/6001", { fields: "access_token" }, new AbortController().signal, USER, true),
    ]) {
      expect(await refusalOf(p)).toBeInstanceOf(WriteRefusal);
    }
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("static", () => {
  const SRC = join(__dirname, "..", "..", "src");
  const files = (): string[] => {
    const out: string[] = [];
    const walk = (d: string): void => {
      for (const name of readdirSync(d)) {
        const p = join(d, name);
        if (statSync(p).isDirectory()) walk(p);
        else out.push(p);
      }
    };
    walk(SRC);
    return out;
  };
  const naming = (word: string) => files().filter((f) => readFileSync(f, "utf8").includes(word)).map((f) => f.slice(SRC.length + 1)).sort();
  const count = (text: string, word: string) => text.split(word).length - 1;
  const client = () => readFileSync(join(SRC, "meta", "client.ts"), "utf8");

  it("only page-token.ts calls readPageToken, besides its definition in client.ts", () => {
    expect(naming("readPageToken")).toEqual(["meta/client.ts", "meta/page-token.ts"]);
    expect(count(readFileSync(join(SRC, "meta", "page-token.ts"), "utf8"), "readPageToken(")).toBe(1);
    expect(count(client(), "readPageToken(")).toBe(1);
  });

  it("names the private flag and the exemption only in client.ts, only on readPageToken's path", () => {
    expect(naming("tokenRead")).toEqual(["meta/client.ts"]);
    expect(naming("allowTokenField")).toEqual(["meta/client.ts"]);
    // execute's parameter, the shape option it passes, and the skipped clean.
    expect(count(client(), "tokenRead")).toBe(3);
    expect(client()).toContain("    tokenRead?: true,\n  ): Promise<T> {");
    expect(client()).toContain("const shape = tokenRead ? { allowTokenField: true as const } : undefined;");
    expect(client()).toContain("return (tokenRead ? body : cleanAnswer(body)) as T;");
    // checkRequestShape's option, its one read, and execute's pass.
    expect(count(client(), "allowTokenField")).toBe(3);
    expect(client()).toContain("  opts?: { allowTokenField?: true },\n): void {");
    expect(client()).toContain('opts?.allowTokenField) continue;');
    // The one call that sets the flag: readPageToken's, with its constant fields.
    expect(count(client(), "scope, undefined, true)")).toBe(1);
    expect(client()).toMatch(/const params = \{ fields: "access_token" \};\n.*\n {4}const page = await this\.execute<[^\n]*scope, undefined, true\);/);
  });

  it("keeps RequestScope free of the flag", () => {
    const scope = /export interface RequestScope \{[\s\S]*?\n\}/.exec(client())?.[0] ?? "";
    expect(scope).not.toMatch(/tokenRead|allowTokenField/);
  });
});
