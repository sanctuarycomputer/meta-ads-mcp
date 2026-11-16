import { promises as fs } from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  analyzeVideoWithGemini,
  createAnalysisCache,
  type VideoAnalysisDeps,
} from "../../src/gemini/video-analysis.js";
import { type GeminiClient } from "../../src/gemini/client.js";
import type { Ffmpeg } from "../../src/media/ffmpeg.js";
import { createVideoJobRunner } from "../../src/media/video-jobs.js";
import type { VideoSource } from "../../src/media/video-sources.js";
import { createSlidingWindowLimiter } from "../../src/utils/sliding-window-limiter.js";

const KEY = "AQ.test_gemini_fixture_key_000";

function mp4(bytes: number): Buffer {
  return Buffer.concat([Buffer.from([0, 0, 0, 16]), Buffer.from("ftypmp42"), Buffer.alloc(Math.max(0, bytes - 12))]);
}

const SOURCE: VideoSource = {
  key: "meta:video:999",
  label: "Video 999",
  origin: "meta",
  video_id: "999",
  source_url: "https://video.xx.fbcdn.net/hd.mp4",
  low_res_url: "https://video.xx.fbcdn.net/sd.mp4",
};

const ANALYSIS = {
  language: "es",
  summary: "Un anuncio con gancho directo.",
  hook: { description_first_3s: "Primer plano del producto", technique: "pattern interrupt", strength_1_5: 4, rationale: "Arranca con movimiento" },
  cta: { present: true, time: "00:12", text: "Compra ahora", type: "SHOP_NOW" },
  transcript: [{ start: "00:00", end: "00:03", text: "Hola" }],
  on_screen_text: [{ time: "00:01", text: "50% OFF" }],
  scenes: [{ start: "00:00", end: "00:05", description: "Producto sobre una mesa" }],
  strengths: ["Hook claro"],
  weaknesses: ["Sin subtítulos"],
  improvement_ideas: ["Añadir subtítulos"],
};

function fakeFfmpeg(overrides: Partial<Ffmpeg> = {}, available = true): Ffmpeg {
  return {
    isAvailable: async () => available,
    lastKnownAvailability: () => available,
    probe: async () => ({ duration_seconds: 15, width: 720, height: 1280, fps: 30, has_audio: true, video_codec: "h264", bytes: 100, demuxer: "mov,mp4,m4a,3gp,3g2,mj2" }),
    extractFrames: async () => [],
    contactSheet: async () => ({ buffer: Buffer.alloc(0), timestamps_seconds: [], columns: 3, rows: 1 }),
    compact: async (_input, options) => {
      const out = path.join(options.outDir, "compact.mp4");
      await fs.writeFile(out, mp4(2048));
      return { path: out, bytes: 2048, height: options.height };
    },
    extractAudio: async () => ({ buffer: Buffer.alloc(0), mimeType: "audio/aac" }),
    ...overrides,
  };
}

function fakeClient(overrides: Partial<GeminiClient> = {}): GeminiClient & Record<string, ReturnType<typeof vi.fn>> {
  return {
    validateKey: vi.fn(async () => undefined),
    uploadFile: vi.fn(async () => ({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "PROCESSING" })),
    waitForFileActive: vi.fn(async () => ({ name: "files/abc-123", uri: "https://generativelanguage.googleapis.com/v1beta/files/abc-123", state: "ACTIVE" })),
    generateJson: vi.fn(async () => ({ json: ANALYSIS, usage: { prompt_tokens: 1500, output_tokens: 300, total_tokens: 1800 }, model: "gemini-3.8-flash", finish_reason: "STOP", schema_enforced: true })),
    deleteFile: vi.fn(async () => true),
    ...overrides,
  } as never;
}

function setup(overrides: Partial<VideoAnalysisDeps> = {}, videoBytes = 4096) {
  const downloadVideo = vi.fn(async (url: string, opts: { destDir: string }) => {
    const file = path.join(opts.destDir, "in.mp4");
    await fs.writeFile(file, mp4(videoBytes));
    return { path: file, bytes: videoBytes, contentType: "video/mp4", finalUrl: new URL(url) };
  });
  const client = fakeClient();
  const deps: VideoAnalysisDeps = {
    downloadVideo: downloadVideo as never,
    ffmpeg: fakeFfmpeg(),
    runner: createVideoJobRunner({ maxConcurrent: 2 }),
    client,
    resolveKey: async () => ({ key: KEY, source: "encrypted_user_storage", tenantId: "tenant-1" }),
    limiter: createSlidingWindowLimiter({ limit: 20, windowMs: 3_600_000 }),
    cache: createAnalysisCache(),
    model: "gemini-3.8-flash",
    inlineMaxBytes: 8 * 1024,
    maxUploadBytes: 64 * 1024,
    ...overrides,
  };
  return { deps, client: (deps.client ?? client) as ReturnType<typeof fakeClient>, downloadVideo };
}

const OPTIONS = { language: "es", detail: "standard" as const, quality: "sd" as const };

describe("createAnalysisCache", () => {
  it("evicts the oldest entry beyond its capacity and expires entries by age", () => {
    let now = 0;
    const cache = createAnalysisCache({ maxEntries: 2, ttlMs: 1000, now: () => now });
    cache.set("a", { value: 1 } as never);
    cache.set("b", { value: 2 } as never);
    cache.set("c", { value: 3 } as never);
    expect(cache.get("a")).toBeUndefined();
    expect(cache.get("b")).toBeDefined();
    now = 2000;
    expect(cache.get("b")).toBeUndefined();
    expect(cache.size()).toBeLessThanOrEqual(1);
  });
});

describe("round-2 review fixes", () => {

  it("does not leave one behind when the caller was already gone", async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => unhandled.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      const controller = new AbortController();
      controller.abort();
      const { deps } = setup();
      await expect(analyzeVideoWithGemini(SOURCE, OPTIONS, deps, { signal: controller.signal })).rejects.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});
