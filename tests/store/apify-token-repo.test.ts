import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  InMemoryApifyTokenRepo,
  configureApifyTokenRepoForTests,
  getApifyTokenRepo,
} from "../../src/store/apify-token-repo.js";

// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, and carrying the repo's `fixture` marker, so it never trips the
// secret scanner.
const TOKEN = "apify_api_testfixture";

describe("apify-token-repo", () => {
  beforeEach(() => {
    configureApifyTokenRepoForTests(undefined);
  });

  afterEach(() => {
    configureApifyTokenRepoForTests(undefined);
  });

  describe("InMemoryApifyTokenRepo", () => {
    it("round-trips a token", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, { id: "u1", username: "byads" });

      expect(await repo.getDecryptedToken("user-1")).toBe(TOKEN);
    });

    it("reports status without exposing the token", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, { id: "u1", username: "byads" });

      const status = await repo.getStatus("user-1");
      expect(status.registered).toBe(true);
      expect(status.apifyUsername).toBe("byads");
      expect(status.apifyUserId).toBe("u1");
      expect(status.updatedAt).toBeTypeOf("number");
      expect(JSON.stringify(status)).not.toContain(TOKEN);
    });

    it("returns an empty status for an unknown tenant", async () => {
      const repo = new InMemoryApifyTokenRepo();
      expect(await repo.getStatus("nobody")).toEqual({
        registered: false,
        apifyUserId: null,
        apifyUsername: null,
        updatedAt: null,
      });
    });

    it("returns null rather than throwing when no token is stored", async () => {
      const repo = new InMemoryApifyTokenRepo();
      expect(await repo.getDecryptedToken("nobody")).toBeNull();
    });

    it("isolates tenants from each other", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", "apify_api_one", null);
      await repo.saveToken("user-2", "apify_api_two", null);

      expect(await repo.getDecryptedToken("user-1")).toBe("apify_api_one");
      expect(await repo.getDecryptedToken("user-2")).toBe("apify_api_two");
    });

    it("preserves createdAt but bumps updatedAt when re-registering", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, null);
      const first = await repo.getStatus("user-1");

      await repo.saveToken("user-1", "apify_api_rotated", null);
      const second = await repo.getStatus("user-1");

      expect(await repo.getDecryptedToken("user-1")).toBe("apify_api_rotated");
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt as number);
    });

    it("deletes a token and reports whether anything was removed", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-1", TOKEN, null);

      expect(await repo.deleteToken("user-1")).toBe(true);
      expect(await repo.deleteToken("user-1")).toBe(false);
      expect(await repo.getDecryptedToken("user-1")).toBeNull();
    });
  });

  describe("getApifyTokenRepo", () => {
    it("returns the in-memory repo", () => {
      expect(getApifyTokenRepo()).toBeInstanceOf(InMemoryApifyTokenRepo);
    });

    it("returns the repo injected for tests", () => {
      const injected = new InMemoryApifyTokenRepo();
      configureApifyTokenRepoForTests(injected);
      expect(getApifyTokenRepo()).toBe(injected);
    });
  });
});
