/**
 * M7: src/gemini and src/apify can reach no host, even with a key set. Every
 * method that would send a request throws a refusal before any fetch.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createGeminiClient,
  getGeminiClient,
  GeminiRemovedError,
  isGeminiEnvFallbackUsable,
  maskGeminiKey,
  resolveGeminiKey,
  scrubGeminiKey,
} from "../../src/gemini/client.js";
import { analyzeVideoWithGemini } from "../../src/gemini/video-analysis.js";
import {
  apifyApiClient,
  ApifyRemovedError,
  isApifyEnvFallbackUsable,
  resolveApifyToken,
  validateApifyId,
} from "../../src/apify/client.js";
import { getDatasetLookup, validateAdArchiveId } from "../../src/apify/dataset-lookup.js";
import type { VideoSource } from "../../src/media/video-sources.js";
import { fakeSecret } from "./fake-secrets.js";

const GEMINI = "removed in this fork: Gemini";
const APIFY = "removed in this fork: Apify";
const fetchSpy = vi.fn(() => Promise.reject(new Error("network used")));

beforeEach(() => {
  process.env.GEMINI_API_KEY = fakeSecret("gemini-key");
  process.env.APIFY_TOKEN = fakeSecret("apify-token");
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  delete process.env.GEMINI_API_KEY;
  delete process.env.APIFY_TOKEN;
  vi.unstubAllGlobals();
  fetchSpy.mockClear();
});

async function refusal(work: () => Promise<unknown>): Promise<unknown> {
  try {
    await work();
  } catch (err) {
    return err;
  }
  throw new Error("expected a refusal");
}

async function expectRefused(work: () => Promise<unknown>, cls: new () => Error, message: string) {
  const err = await refusal(work);
  expect(err).toBeInstanceOf(cls);
  expect((err as Error).message).toBe(message);
}

const key = fakeSecret("gemini-key");
const video = { kind: "inline" as const, data: Buffer.from("v"), mimeType: "video/mp4" };
const generateInput = {
  key,
  model: "gemini-x",
  video,
  prompt: "p",
  systemInstruction: "s",
  schema: {},
  mediaResolution: "MEDIA_RESOLUTION_LOW" as const,
};

describe("M7: Gemini reaches nothing", () => {
  it("gemini client refuses every method without fetch", async () => {
    const client = getGeminiClient();
    await expectRefused(() => client.validateKey(key), GeminiRemovedError, GEMINI);
    await expectRefused(
      () => client.uploadFile({ key, data: Buffer.from("v"), mimeType: "video/mp4", displayName: "d" }),
      GeminiRemovedError,
      GEMINI,
    );
    await expectRefused(() => client.waitForFileActive({ key, name: "files/a", budgetMs: 1 }), GeminiRemovedError, GEMINI);
    await expectRefused(() => client.generateJson(generateInput), GeminiRemovedError, GEMINI);
    await expect(client.deleteFile({ key, name: "files/a" })).resolves.toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("createGeminiClient ignores an injected fetch", async () => {
    const spy = vi.fn(() => Promise.reject(new Error("network used")));
    const client = createGeminiClient({ fetch: spy as unknown as typeof fetch });
    await expectRefused(() => client.generateJson(generateInput), GeminiRemovedError, GEMINI);
    await expectRefused(() => client.validateKey(key), GeminiRemovedError, GEMINI);
    expect(spy).not.toHaveBeenCalled();
  });

  it("resolveGeminiKey and analyzeVideoWithGemini refuse", async () => {
    await expectRefused(() => resolveGeminiKey(), GeminiRemovedError, GEMINI);
    const source: VideoSource = { key: "meta:video:1", label: "v", origin: "meta", source_url: "https://example.com/v.mp4" };
    const injected = vi.fn(() => Promise.resolve({ key, source: "env" as const, tenantId: "_local" }));
    await expectRefused(
      () => analyzeVideoWithGemini(source, { language: "en", detail: "standard", quality: "sd" }, { resolveKey: injected }),
      GeminiRemovedError,
      GEMINI,
    );
    expect(injected).not.toHaveBeenCalled();
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("M7: Apify reaches nothing", () => {
  it("env fallbacks are off", () => {
    expect(isGeminiEnvFallbackUsable()).toBe(false);
    expect(isApifyEnvFallbackUsable()).toBe(false);
  });

  it("apify client refuses", async () => {
    await expectRefused(() => apifyApiClient.get("/x"), ApifyRemovedError, APIFY);
    await expectRefused(() => apifyApiClient.post("/x", {}), ApifyRemovedError, APIFY);
    await expectRefused(() => apifyApiClient.delete("/x"), ApifyRemovedError, APIFY);
    await expectRefused(() => resolveApifyToken(), ApifyRemovedError, APIFY);
    // Ids that pass both validators, so only the refusal can decide this.
    const datasetId = validateApifyId("abcDEF1234567890", "dataset");
    const archiveId = validateAdArchiveId("1234567890123456");
    await expectRefused(() => getDatasetLookup().findDatasetItem(datasetId, archiveId), ApifyRemovedError, APIFY);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("pure helpers unchanged", () => {
    expect(validateApifyId("abcDEF123", "x")).toBe("abcDEF123");
    expect(maskGeminiKey("AQ.anything-at-all")).toBe("AQ.***");
    const odd = fakeSecret("odd-key");
    expect(scrubGeminiKey(`failed for ${odd}!`, odd)).toBe("failed for [REDACTED]!");
  });
});
