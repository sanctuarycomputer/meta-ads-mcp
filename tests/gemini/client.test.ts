import { describe, expect, it } from "vitest";
import {
  maskGeminiKey,
  scrubGeminiKey,
  validateGeminiKeyInput,
} from "../../src/gemini/client.js";

// Fixture marker keeps the secret scanner quiet; never placed after a GEMINI_API_KEY assignment.
const KEY = "AQ.test_gemini_fixture_key_000";


describe("validateGeminiKeyInput", () => {
  it("accepts AQ. and legacy AIza keys without requiring a prefix", () => {
    expect(validateGeminiKeyInput(`  ${KEY}  `)).toEqual({ ok: true, key: KEY });
    expect(validateGeminiKeyInput("AIza_fixture_legacy_key_00000")).toMatchObject({ ok: true });
    expect(validateGeminiKeyInput("some-future-format-fixture-0000")).toMatchObject({ ok: true });
  });

  it("rejects empty, short, long and header-injecting values", () => {
    expect(validateGeminiKeyInput(undefined)).toEqual({ ok: false, reason: "empty" });
    expect(validateGeminiKeyInput("   ")).toEqual({ ok: false, reason: "empty" });
    expect(validateGeminiKeyInput("short")).toEqual({ ok: false, reason: "too-short" });
    expect(validateGeminiKeyInput("k".repeat(513))).toEqual({ ok: false, reason: "too-long" });
    expect(validateGeminiKeyInput("AQ.fixture_key_with\r\nX-Evil: 1")).toEqual({ ok: false, reason: "illegal-chars" });
    expect(validateGeminiKeyInput("AQ.fixture key with spaces 00")).toEqual({ ok: false, reason: "illegal-chars" });
    expect(validateGeminiKeyInput("AQ.fixture_clé_non_ascii_0000")).toEqual({ ok: false, reason: "illegal-chars" });
  });
});

describe("scrubGeminiKey / maskGeminiKey", () => {
  it("removes the exact key and anything key-shaped from a message", () => {
    const message = `API key not valid: ${KEY}. Also AIza${"B".repeat(35)} and AQ.${"c".repeat(30)}`;
    const scrubbed = scrubGeminiKey(message, KEY);
    expect(scrubbed).not.toContain(KEY);
    expect(scrubbed).not.toContain("B".repeat(20));
    expect(scrubbed).not.toContain("c".repeat(20));
    expect(scrubbed).toContain("[REDACTED]");
  });

  it("scrubs an exact key of an unknown shape", () => {
    const odd = "weird-format-fixture-0000000";
    expect(scrubGeminiKey(`failed for ${odd}!`, odd)).toBe("failed for [REDACTED]!");
  });

  it("masks without revealing any character of the secret body", () => {
    expect(maskGeminiKey(KEY)).toBe("AQ.***");
    expect(maskGeminiKey("AIza_fixture_legacy_key_00000")).toBe("AIza***");
    expect(maskGeminiKey("other-fixture-key-000000000")).toBe("***");
  });
});

