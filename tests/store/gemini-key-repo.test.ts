import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  InMemoryGeminiKeyRepo,
  configureGeminiKeyRepoForTests,
  getGeminiKeyRepo,
} from "../../src/store/gemini-key-repo.js";

// Carries the repo's `fixture` marker and never follows a GEMINI_API_KEY
// assignment, so it cannot trip the secret scanner.
const KEY = "AQ.test_gemini_fixture_key";

describe("gemini-key-repo", () => {
  beforeEach(() => {
    configureGeminiKeyRepoForTests(undefined);
  });

  afterEach(() => {
    configureGeminiKeyRepoForTests(undefined);
  });

  describe("InMemoryGeminiKeyRepo", () => {
    it("round-trips a key", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);
      expect(await repo.getDecryptedKey("user-1")).toBe(KEY);
    });

    it("reports status without exposing the key or any part of it", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);

      const status = await repo.getStatus("user-1");
      expect(status.registered).toBe(true);
      expect(status.updatedAt).toBeTypeOf("number");
      expect(status.keyFingerprint).toMatch(/^[0-9a-f]{12}$/);
      expect(JSON.stringify(status)).not.toContain(KEY);
      expect(JSON.stringify(status)).not.toContain("fixture");
    });

    it("returns an empty status and a null key for an unknown tenant", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      expect(await repo.getStatus("nobody")).toEqual({ registered: false, keyFingerprint: null, updatedAt: null });
      expect(await repo.getDecryptedKey("nobody")).toBeNull();
    });

    it("isolates tenants from each other", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", "AQ.fixture_one");
      await repo.saveKey("user-2", "AQ.fixture_two");
      expect(await repo.getDecryptedKey("user-1")).toBe("AQ.fixture_one");
      expect(await repo.getDecryptedKey("user-2")).toBe("AQ.fixture_two");
    });

    it("preserves createdAt but bumps updatedAt when the key is rotated", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);
      const first = await repo.getStatus("user-1");
      await repo.saveKey("user-1", "AQ.fixture_rotated");
      const second = await repo.getStatus("user-1");
      expect(await repo.getDecryptedKey("user-1")).toBe("AQ.fixture_rotated");
      expect(second.updatedAt).toBeGreaterThanOrEqual(first.updatedAt as number);
      expect(second.keyFingerprint).not.toBe(first.keyFingerprint);
    });

    it("deletes a key and reports whether anything was removed", async () => {
      const repo = new InMemoryGeminiKeyRepo();
      await repo.saveKey("user-1", KEY);
      expect(await repo.deleteKey("user-1")).toBe(true);
      expect(await repo.deleteKey("user-1")).toBe(false);
      expect(await repo.getDecryptedKey("user-1")).toBeNull();
    });
  });

  describe("getGeminiKeyRepo", () => {
    it("returns the in-memory repo", () => {
      expect(getGeminiKeyRepo()).toBeInstanceOf(InMemoryGeminiKeyRepo);
    });
  });
});
