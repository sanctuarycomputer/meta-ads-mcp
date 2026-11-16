/**
 * M6: no Firestore. Every store is in memory whatever the Firestore env says,
 * the in-memory repos hold plain values (no TOKEN_ENCRYPTION_KEY), and the
 * Meta token repo has no refresh path into the OAuth config.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { getCloneBundleStore, resetCloneBundleStoreForTests } from "../../src/store/clone-bundle-store.js";
import { claimPostEditLease, resetPostEditLeasesForTests } from "../../src/store/post-edit-lease.js";
import { listTokens, saveToken, resetMetaTokenRepoForTests } from "../../src/store/meta-token-repo.js";
import { getGeminiKeyRepo, configureGeminiKeyRepoForTests } from "../../src/store/gemini-key-repo.js";
import { getApifyTokenRepo, configureApifyTokenRepoForTests } from "../../src/store/apify-token-repo.js";
import { fakeSecret } from "./fake-secrets.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ENV = ["FIRESTORE_PROJECT_ID", "GOOGLE_CLOUD_PROJECT", "FIRESTORE_EMULATOR_HOST", "NODE_ENV", "TOKEN_ENCRYPTION_KEY"];
const saved: Record<string, string | undefined> = {};

function resetStores(): void {
  resetCloneBundleStoreForTests();
  resetPostEditLeasesForTests();
  resetMetaTokenRepoForTests();
  configureGeminiKeyRepoForTests(undefined);
  configureApifyTokenRepoForTests(undefined);
}

beforeEach(() => {
  for (const k of ENV) saved[k] = process.env[k];
  resetStores();
});
afterEach(() => {
  for (const k of ENV) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  resetStores();
});

async function roundTripMetaToken(): Promise<void> {
  await saveToken({
    fbUserId: "u1",
    name: "main",
    accessToken: fakeSecret("meta"),
    kind: "user",
    expiresAt: null,
    metaUserId: null,
    metaUserName: null,
  });
  const tokens = await listTokens("u1");
  expect(tokens.map((t) => [t.name, t.isDefault])).toEqual([["main", true]]);
}

describe("M6: no Firestore", () => {
  it("no Firestore dependency", () => {
    const pkg = JSON.parse(readFileSync(`${root}package.json`, "utf8")) as Record<string, Record<string, string> | undefined>;
    for (const field of ["dependencies", "devDependencies", "optionalDependencies"]) {
      expect(Object.keys(pkg[field] ?? {})).not.toContain("@google-cloud/firestore");
    }
    const lock = JSON.parse(readFileSync(`${root}package-lock.json`, "utf8")) as { packages: Record<string, unknown> };
    expect(Object.keys(lock.packages)).not.toContain("node_modules/@google-cloud/firestore");
    expect(Object.keys(lock.packages)).not.toContain("node_modules/protobufjs");
  });

  it("stores are in memory and ignore Firestore env", async () => {
    process.env.FIRESTORE_PROJECT_ID = "p";
    process.env.GOOGLE_CLOUD_PROJECT = "p";
    process.env.FIRESTORE_EMULATOR_HOST = "localhost:1";
    expect(getCloneBundleStore().persistent).toBe(false);
    expect(await claimPostEditLease("1_2", "h")).toBe(true);
    const key = fakeSecret("gemini-env");
    await getGeminiKeyRepo().saveKey("u1", key);
    expect(await getGeminiKeyRepo().getDecryptedKey("u1")).toBe(key);
    const apify = fakeSecret("apify-env");
    await getApifyTokenRepo().saveToken("u1", apify, null);
    expect(await getApifyTokenRepo().getDecryptedToken("u1")).toBe(apify);
    await roundTripMetaToken();
  });

  it("a freshly loaded meta-token-repo starts on the in-memory repo", async () => {
    process.env.FIRESTORE_PROJECT_ID = "p";
    vi.resetModules();
    const fresh = await import("../../src/store/meta-token-repo.js");
    expect(fresh.getMetaTokenRepo()).toBeInstanceOf(fresh.InMemoryMetaTokenRepo);
  });

  it("in-memory repos need no encryption key, even in production", async () => {
    process.env.NODE_ENV = "production";
    delete process.env.TOKEN_ENCRYPTION_KEY;
    const key = fakeSecret("gemini");
    await getGeminiKeyRepo().saveKey("u1", key);
    expect(await getGeminiKeyRepo().getDecryptedKey("u1")).toBe(key);
    const apify = fakeSecret("apify");
    await getApifyTokenRepo().saveToken("u1", apify, null);
    expect(await getApifyTokenRepo().getDecryptedToken("u1")).toBe(apify);
    await roundTripMetaToken();
  });

  it("meta-token-repo never reaches OAuth config", () => {
    const src = readFileSync(`${root}src/store/meta-token-repo.ts`, "utf8");
    expect(src).not.toContain("loadMetaOAuthConfig");
    expect(src).not.toContain("exchangeForLongLivedToken");
  });
});
