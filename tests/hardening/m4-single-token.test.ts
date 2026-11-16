/**
 * M4 (done-when 5, part 1): the fork has one token, META_ACCESS_TOKEN.
 * META_TOKENS is never read, and nothing can register or switch a token.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { tokenManager, maskToken } from "../../src/auth/token-manager.js";
import { getAccessToken } from "../../src/auth/token-store.js";
import { TOKEN, OTHER } from "./fake-secrets.js";

beforeEach(() => {
  process.env.META_TOKENS = JSON.stringify({ other: OTHER });
  process.env.META_ACCESS_TOKEN = TOKEN;
  tokenManager.resetForTests();
});
afterEach(() => {
  delete process.env.META_TOKENS;
  delete process.env.META_ACCESS_TOKEN;
  tokenManager.resetForTests();
});

describe("M4: one token", () => {
  it("ignores META_TOKENS and uses META_ACCESS_TOKEN", () => {
    expect(getAccessToken()).toBe(TOKEN);
    expect(tokenManager.listTokens()).toEqual({ active: "default", available: ["default"] });
  });

  it("registerToken refuses", () => {
    expect(() => tokenManager.registerToken("x", OTHER)).toThrow(
      /^removed in this fork: tokens come only from META_ACCESS_TOKEN$/,
    );
    expect(tokenManager.getActiveToken()).toBe(TOKEN);
    expect(tokenManager.listTokens().available).toEqual(["default"]);
  });

  it("setActiveToken refuses every name", () => {
    expect(tokenManager.setActiveToken("default")).toBe(false);
    expect(tokenManager.setActiveToken("other")).toBe(false);
    expect(tokenManager.getActiveToken()).toBe(TOKEN);
  });

  it("maskToken shows no token characters", () => {
    const masked = maskToken(TOKEN);
    for (let i = 0; i + 3 <= TOKEN.length; i++) {
      expect(masked).not.toContain(TOKEN.slice(i, i + 3));
    }
    expect(masked).toBe("[masked]");
  });

  it("has no token and no active name when META_ACCESS_TOKEN is unset", () => {
    delete process.env.META_ACCESS_TOKEN;
    tokenManager.resetForTests();
    expect(tokenManager.getActiveToken()).toBeNull();
    expect(tokenManager.getActiveTokenName()).toBeNull();
    expect(tokenManager.hasTokens()).toBe(false);
    expect(tokenManager.listTokens()).toEqual({ active: null, available: [] });
    expect(() => getAccessToken()).toThrow(/^No Meta access token available\. Set META_ACCESS_TOKEN\.$/);
  });

  it("does not read META_TOKENS", () => {
    const original = process.env;
    const reads: string[] = [];
    process.env = new Proxy(original, {
      get(target, key) {
        reads.push(String(key));
        return Reflect.get(target, key) as unknown;
      },
    });
    try {
      tokenManager.resetForTests();
      tokenManager.getActiveToken();
    } finally {
      process.env = original;
    }
    expect(reads).toContain("META_ACCESS_TOKEN");
    expect(reads).not.toContain("META_TOKENS");
  });
});
