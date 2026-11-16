import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  maskApifyToken,
  resolveApifyTenantId,
  scrubApifyToken,
  validateApifyId,
} from "../../src/apify/client.js";
import {
  InMemoryApifyTokenRepo,
  configureApifyTokenRepoForTests,
} from "../../src/store/apify-token-repo.js";
import { resetKeyCacheForTests } from "../../src/auth/crypto.js";

// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, so this fixture never trips the secret scanner.
const TOKEN = "apify_api_testfixture";

describe("apify client", () => {
  beforeEach(() => {
    process.env.TOKEN_ENCRYPTION_KEY = "b".repeat(64);
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(new InMemoryApifyTokenRepo());
    process.env.APIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
    delete process.env.TOKEN_ENCRYPTION_KEY;
    resetKeyCacheForTests();
    configureApifyTokenRepoForTests(undefined);
  });

  describe("tenant isolation", () => {
    const savedAppId = process.env.META_APP_ID;
    const savedAppSecret = process.env.META_APP_SECRET;

    function enableMultiTenant() {
      process.env.META_APP_ID = "1234567890";
      process.env.META_APP_SECRET = "f".repeat(32);
    }

    afterEach(() => {
      if (savedAppId === undefined) delete process.env.META_APP_ID;
      else process.env.META_APP_ID = savedAppId;
      if (savedAppSecret === undefined) delete process.env.META_APP_SECRET;
      else process.env.META_APP_SECRET = savedAppSecret;
    });

    it("uses the _local bucket only when no OAuth app is configured", () => {
      expect(resolveApifyTenantId()).toBe("_local");
    });

    it("refuses to resolve a tenant for an unidentified caller in multi-tenant mode", () => {
      enableMultiTenant();

      // An API-key request has no fbUserId. It must not land in the shared
      // _local bucket alongside every other unidentified caller.
      expect(() => resolveApifyTenantId()).toThrow(/authenticated user in multi-tenant mode/);
    });

    it("scopes a stored token to its own tenant", async () => {
      const repo = new InMemoryApifyTokenRepo();
      await repo.saveToken("user-a", "apify_api_aaa", null);
      configureApifyTokenRepoForTests(repo);

      expect(await repo.getDecryptedToken("user-a")).toBe("apify_api_aaa");
      expect(await repo.getDecryptedToken("user-b")).toBeNull();
    });
  });

  describe("validateApifyId", () => {
    it("accepts a normal Apify id", () => {
      expect(validateApifyId("XtaWFhbtfxyzqrFmd", "run")).toBe("XtaWFhbtfxyzqrFmd");
    });

    it.each([
      ["../../v2/users/me", "path traversal"],
      ["", "empty"],
      ["abc12?foo=bar", "query string"],
      ["abc 12", "whitespace"],
      ["abc/def", "slash"],
      ["a".repeat(64), "too long"],
    ])("rejects %s (%s)", (id) => {
      expect(() => validateApifyId(id, "run")).toThrow(McpError);
    });
  });

  describe("helpers", () => {
    it("scrubApifyToken removes every occurrence", () => {
      const scrubbed = scrubApifyToken(`a ${TOKEN} b ${TOKEN} c`);
      expect(scrubbed).not.toContain(TOKEN);
      expect(scrubbed.match(/apify_api_\[REDACTED\]/g)).toHaveLength(2);
    });

    it("scrubApifyToken also removes an exact token that does not match the pattern", () => {
      const odd = "legacy-style-token-value";
      const scrubbed = scrubApifyToken(`failed for ${odd}`, odd);
      expect(scrubbed).not.toContain(odd);
      expect(scrubbed).toContain("[REDACTED]");
    });

    it("scrubApifyToken does not fragment a longer token that the exact value prefixes", () => {
      // Regression: replacing the exact value first split "apify_api_abcdefXYZ"
      // into "[REDACTED]defXYZ", after which the generic pattern no longer
      // recognised the remainder and the suffix leaked.
      const scrubbed = scrubApifyToken("saw apify_api_abcdefXYZ here", "apify_api_abc");
      expect(scrubbed).not.toContain("defXYZ");
      expect(scrubbed).toBe("saw apify_api_[REDACTED] here");
    });

    it("scrubApifyToken handles regex metacharacters in the exact token", () => {
      const weird = "tok+en(with)[meta].chars";
      const scrubbed = scrubApifyToken(`failed for ${weird}`, weird);
      expect(scrubbed).not.toContain(weird);
      expect(scrubbed).toContain("[REDACTED]");
    });

    it("scrubApifyToken leaves no tail when the exact token only partly matches the pattern", () => {
      // The pattern stops at the hyphen. Scrubbing the exact value must happen
      // first, or "-secret" survives.
      const hybrid = "apify_api_abc123def456-secret";
      const scrubbed = scrubApifyToken(`token ${hybrid} rejected`, hybrid);
      expect(scrubbed).not.toContain(hybrid);
      expect(scrubbed).not.toContain("-secret");
    });

    it("maskApifyToken reveals only the non-secret prefix", () => {
      const masked = maskApifyToken(TOKEN);
      expect(masked).toBe("apify_api_***");
      // Not one character of the secret body survives.
      expect(TOKEN.slice("apify_api_".length)).not.toBe("");
      expect(masked).not.toContain(TOKEN.slice("apify_api_".length));
    });

    it("maskApifyToken fully hides values with no known prefix", () => {
      expect(maskApifyToken("some-other-credential")).toBe("***");
    });
  });
});
