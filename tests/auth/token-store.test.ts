import { describe, it, expect, afterEach } from "vitest";
import {
  getAccessToken,
  requestContext,
} from "../../src/auth/token-store.js";
import { tokenManager } from "../../src/auth/token-manager.js";

describe("getAccessToken", () => {
  afterEach(() => {
    delete process.env.META_ACCESS_TOKEN;
    // Reset the singleton between tests so lazy load reads the (now
    // cleared) env on the next call.
    tokenManager.resetForTests();
  });

  it("returns token from AsyncLocalStorage context", () => {
    const token = requestContext.run({ accessToken: "ctx-token" }, () => {
      return getAccessToken();
    });
    expect(token).toBe("ctx-token");
  });

  it("falls back to META_ACCESS_TOKEN env var", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    expect(getAccessToken()).toBe("env-token");
  });

  it("prefers context token over env var", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    const token = requestContext.run({ accessToken: "ctx-token" }, () => {
      return getAccessToken();
    });
    expect(token).toBe("ctx-token");
  });

  // Trimmed where it is read, so the value sent, signed, hashed and scrubbed
  // is one string (meta-ads-mcp-251 final-2b R1).
  // 254 M4: no token can be registered, so the sources are context and env.
  it("trims a context or env token", () => {
    expect(requestContext.run({ accessToken: " ctx-token\n" }, () => getAccessToken())).toBe("ctx-token");
    process.env.META_ACCESS_TOKEN = "env-token\r\n";
    expect(getAccessToken()).toBe("env-token");
  });

  it("trims an env token set after the token registry loaded empty", () => {
    expect(() => getAccessToken()).toThrow(/No Meta access token available/);
    process.env.META_ACCESS_TOKEN = " late-env-token\n";
    expect(getAccessToken()).toBe("late-env-token");
  });

  it("never lets a blank context token fall back to the process token", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    expect(requestContext.run({ accessToken: "  \n" }, () => getAccessToken())).toBe("");
  });

  // 251 final-3 F2 / final-3b R2, fixed in 254: an empty string is blank too.
  it("never lets an empty context token fall back to the process token", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    expect(requestContext.run({ accessToken: "" }, () => getAccessToken())).toBe("");
  });

  it("falls back to the env token when the context carries no token string", () => {
    process.env.META_ACCESS_TOKEN = "env-token";
    const ctx = { fbUserId: "u1" } as unknown as { accessToken: string };
    expect(requestContext.run(ctx, () => getAccessToken())).toBe("env-token");
  });

  it("throws when no token is available", () => {
    expect(() => getAccessToken()).toThrow(
      /No Meta access token available/,
    );
  });
});
