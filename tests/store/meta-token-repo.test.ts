import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  InMemoryMetaTokenRepo,
  type MetaTokenRepo,
} from "../../src/store/meta-token-repo.js";
import * as metaOAuth from "../../src/auth/meta-oauth.js";


const profile = {
  id: "fb-1",
  name: "Alice",
  email: "alice@example.com",
  pictureUrl: null,
};

function makeInput(overrides: Partial<Parameters<MetaTokenRepo["saveToken"]>[0]> = {}) {
  return {
    fbUserId: "fb-1",
    name: "personal",
    accessToken: "EAA-secret-token",
    kind: "user" as const,
    expiresAt: Math.floor(Date.now() / 1000) + 60 * 24 * 60 * 60,
    metaUserId: "fb-1",
    metaUserName: "Alice",
    ...overrides,
  };
}

describe("InMemoryMetaTokenRepo", () => {
  let repo: InMemoryMetaTokenRepo;

  beforeEach(() => {
    repo = new InMemoryMetaTokenRepo();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("upserts users and reads them back", async () => {
    await repo.upsertUser("fb-1", profile);
    const user = await repo.getUser("fb-1");
    expect(user).toMatchObject({
      email: "alice@example.com",
      name: "Alice",
    });
  });

  it("first saved token becomes default automatically", async () => {
    await repo.saveToken(makeInput({ name: "first" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("first");

    await repo.saveToken(makeInput({ name: "second" }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("first");
  });

  it("setAsDefault swaps the active default", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b", setAsDefault: true }));
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");

    const tokens = await repo.listTokens("fb-1");
    expect(tokens.find((t) => t.name === "a")?.isDefault).toBe(false);
    expect(tokens.find((t) => t.name === "b")?.isDefault).toBe(true);
  });

  it("setDefaultToken returns false when missing and switches when present", async () => {
    expect(await repo.setDefaultToken("fb-1", "missing")).toBe(false);
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b" }));
    expect(await repo.setDefaultToken("fb-1", "b")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");
  });

  it("deleteToken promotes another token when default is removed", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await repo.saveToken(makeInput({ name: "b" }));
    expect(await repo.deleteToken("fb-1", "a")).toBe(true);
    expect(await repo.getDefaultTokenName("fb-1")).toBe("b");
  });

  it("getDecryptedToken returns the plaintext for system_user tokens without refresh", async () => {
    await repo.saveToken(
      makeInput({
        kind: "system_user",
        expiresAt: null,
        accessToken: "system-user-token",
        setAsDefault: true,
      }),
    );

    const plaintext = await repo.getDecryptedToken("fb-1");
    expect(plaintext).toBe("system-user-token");
  });

  it("returns the stored token near or past expiry without exchanging it (no refresh path)", async () => {
    const exchange = vi.spyOn(metaOAuth, "exchangeForLongLivedToken");
    const soon = Math.floor(Date.now() / 1000) + 24 * 60 * 60;
    await repo.saveToken(makeInput({ accessToken: "near-expiry", expiresAt: soon }));
    expect(await repo.getDecryptedToken("fb-1", "personal")).toBe("near-expiry");
    await repo.saveToken(makeInput({ name: "old", accessToken: "past-expiry", expiresAt: soon - 2 * 24 * 60 * 60 }));
    expect(await repo.getDecryptedToken("fb-1", "old")).toBe("past-expiry");
    expect(exchange).not.toHaveBeenCalled();
  });

  it("throws when no token is registered", async () => {
    await expect(repo.getDecryptedToken("fb-2")).rejects.toThrow(/No Meta token registered/);
  });

  it("throws when the named token does not exist", async () => {
    await repo.saveToken(makeInput({ name: "a" }));
    await expect(repo.getDecryptedToken("fb-1", "missing")).rejects.toThrow(
      /not found for user/,
    );
  });

  it("persists businessId and businessName and exposes them in summaries", async () => {
    await repo.saveToken(
      makeInput({
        name: "client_acme",
        kind: "system_user",
        expiresAt: null,
        businessId: "1234567890",
        businessName: "Acme Corp",
      }),
    );

    const tokens = await repo.listTokens("fb-1");
    expect(tokens).toHaveLength(1);
    expect(tokens[0]).toMatchObject({
      name: "client_acme",
      businessId: "1234567890",
      businessName: "Acme Corp",
    });
  });

  it("defaults businessId and businessName to null when not provided", async () => {
    await repo.saveToken(makeInput({ name: "no-bm" }));

    const tokens = await repo.listTokens("fb-1");
    expect(tokens[0].businessId).toBeNull();
    expect(tokens[0].businessName).toBeNull();
  });

  it("getDecryptedToken without a name resolves the current default after setDefaultToken (enables agent token pivoting)", async () => {
    await repo.saveToken(
      makeInput({
        name: "byads",
        kind: "system_user",
        expiresAt: null,
        accessToken: "byads-token",
        setAsDefault: true,
      }),
    );
    await repo.saveToken(
      makeInput({
        name: "personal",
        kind: "system_user",
        expiresAt: null,
        accessToken: "personal-token",
      }),
    );

    expect(await repo.getDecryptedToken("fb-1")).toBe("byads-token");

    expect(await repo.setDefaultToken("fb-1", "personal")).toBe(true);
    expect(await repo.getDecryptedToken("fb-1")).toBe("personal-token");

    expect(await repo.setDefaultToken("fb-1", "byads")).toBe(true);
    expect(await repo.getDecryptedToken("fb-1")).toBe("byads-token");
  });
});
