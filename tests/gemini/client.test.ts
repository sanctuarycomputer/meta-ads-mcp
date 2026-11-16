import { afterEach, describe, expect, it, vi } from "vitest";
import {
  GeminiApiError,
  buildGenerateBody,
  createGeminiClient,
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

describe("buildGenerateBody", () => {
  const base = {
    prompt: "Analyze this ad.",
    systemInstruction: "You are an ad analyst.",
    schema: { type: "object", properties: { summary: { type: "string" } } },
    mediaResolution: "MEDIA_RESOLUTION_LOW" as const,
    maxOutputTokens: 4096,
  };

  it("references an uploaded file, puts the text after the video and asks for schema-bound JSON", () => {
    const body = buildGenerateBody({ ...base, video: { kind: "file", fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", mimeType: "video/mp4" } });
    expect(body).toEqual({
      systemInstruction: { parts: [{ text: "You are an ad analyst." }] },
      contents: [
        {
          role: "user",
          parts: [
            { fileData: { fileUri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", mimeType: "video/mp4" } },
            { text: "Analyze this ad." },
          ],
        },
      ],
      generationConfig: {
        responseMimeType: "application/json",
        responseJsonSchema: base.schema,
        mediaResolution: "MEDIA_RESOLUTION_LOW",
        maxOutputTokens: 4096,
        temperature: 0.2,
      },
    });
  });

  it("embeds a small video as inlineData", () => {
    const body = buildGenerateBody({ ...base, video: { kind: "inline", data: Buffer.from("mp4bytes"), mimeType: "video/mp4" } }) as {
      contents: Array<{ parts: Array<Record<string, unknown>> }>;
    };
    expect(body.contents[0].parts[0]).toEqual({ inlineData: { mimeType: "video/mp4", data: Buffer.from("mp4bytes").toString("base64") } });
  });

  it("can drop the schema for the one-shot fallback while still asking for JSON", () => {
    const body = buildGenerateBody({ ...base, video: { kind: "inline", data: Buffer.from("x"), mimeType: "video/mp4" } }, { withSchema: false }) as {
      generationConfig: Record<string, unknown>;
    };
    expect(body.generationConfig.responseMimeType).toBe("application/json");
    expect(body.generationConfig).not.toHaveProperty("responseJsonSchema");
  });
});

describe("GeminiClient", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("scrubs the key out of transport errors", async () => {
    const client = createGeminiClient({ fetch: vi.fn(async () => { throw new Error(`connect failed for key ${KEY}`); }) as never });
    const error = (await client.validateKey(KEY).catch((e: unknown) => e)) as Error;
    expect(error.message).not.toContain(KEY);
  });
});

describe("round-1 review fixes (client)", () => {

  it("carries no file name when the failure happened before any byte was sent", async () => {
    const fetchMock = vi.fn().mockRejectedValueOnce(new Error("offline"));
    const client = createGeminiClient({ fetch: fetchMock as never });
    const error = (await client.uploadFile({ key: KEY, data: Buffer.from("x"), mimeType: "video/mp4", displayName: "ad-video" }).catch((e: unknown) => e)) as GeminiApiError & { fileName?: string };
    expect(error.fileName).toBeUndefined();
  });
});
