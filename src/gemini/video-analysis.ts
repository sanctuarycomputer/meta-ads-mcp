import type { SafeVideoDownload, SafeVideoDownloadOptions } from "../media/safe-video-download.js";
import type { Ffmpeg } from "../media/ffmpeg.js";
import type { VideoJobRunner } from "../media/video-jobs.js";
import type { VideoSource } from "../media/video-sources.js";
import type { SlidingWindowLimiter } from "../utils/sliding-window-limiter.js";
import {
  GeminiRemovedError,
  type GeminiClient,
  type GeminiKeySource,
  type GeminiUsage,
  type ResolvedGeminiKey,
} from "./client.js";

/**
 * 254 M7: Gemini video analysis is removed from this fork. The exported names
 * and types stay for the files that import them; analyzeVideoWithGemini
 * refuses before it reads a key, downloads a video or calls an injected
 * dependency. The GEMINI_* tuning knobs are never read.
 */

export class GeminiAnalysisRateLimitError extends Error {
  constructor(limit: number) {
    super(`Gemini analysis limit reached (${limit} per hour for this user). Cached repeats are free; try again later, or use ads_get_video_media delivery=frames in the meantime.`);
    this.name = "GeminiAnalysisRateLimitError";
  }
}

export interface VideoAnalysisOptions {
  focus?: string;
  /** Language the analysis is written in (BCP-47). */
  language: string;
  detail: "standard" | "deep";
  quality: "sd" | "hd";
}

export interface AnalyzedVideo {
  key: string;
  label: string;
  origin: VideoSource["origin"];
  video_id?: string;
  ad_archive_id?: string;
  card_index?: number;
  duration_seconds?: number;
  width?: number;
  height?: number;
  has_audio?: boolean;
  rendition: "sd" | "hd";
  analyzed_bytes: number;
  transcoded: boolean;
}

export interface VideoAnalysisResult {
  analysis: Record<string, unknown>;
  usage: GeminiUsage;
  model: string;
  prompt_version: string;
  cached: boolean;
  schema_enforced: boolean;
  transport: "inline" | "files_api";
  key_source: GeminiKeySource;
  video: AnalyzedVideo;
  warnings: string[];
}

type CachedAnalysis = Omit<VideoAnalysisResult, "cached" | "key_source">;

export interface AnalysisCache {
  get(key: string): CachedAnalysis | undefined;
  set(key: string, value: CachedAnalysis): void;
  size(): number;
}

/**
 * Small LRU with a TTL, so an agent retrying the same question does not bill
 * the tenant twice. Values are cloned both ways: a caller can never edit what
 * the next caller receives.
 */
export function createAnalysisCache(config: { maxEntries?: number; ttlMs?: number; now?: () => number } = {}): AnalysisCache {
  const maxEntries = config.maxEntries ?? 100;
  const ttlMs = config.ttlMs ?? 30 * 60 * 1000;
  const now = config.now ?? Date.now;
  const entries = new Map<string, { value: CachedAnalysis; expiresAt: number }>();
  return {
    get(key) {
      const entry = entries.get(key);
      if (!entry) return undefined;
      if (entry.expiresAt <= now()) {
        entries.delete(key);
        return undefined;
      }
      entries.delete(key);
      entries.set(key, entry);
      return structuredClone(entry.value);
    },
    set(key, value) {
      entries.delete(key);
      entries.set(key, { value: structuredClone(value), expiresAt: now() + ttlMs });
      while (entries.size > maxEntries) {
        const oldest = entries.keys().next().value;
        if (oldest === undefined) break;
        entries.delete(oldest);
      }
    },
    size() {
      return entries.size;
    },
  };
}

export interface VideoAnalysisDeps {
  downloadVideo?: (url: string, options: SafeVideoDownloadOptions) => Promise<SafeVideoDownload>;
  ffmpeg?: Ffmpeg;
  runner?: VideoJobRunner;
  client?: GeminiClient;
  resolveKey?: () => Promise<ResolvedGeminiKey>;
  limiter?: SlidingWindowLimiter;
  cache?: AnalysisCache;
  model?: string;
  inlineMaxBytes?: number;
  maxUploadBytes?: number;
}

export interface VideoAnalysisContext {
  signal?: AbortSignal;
  report?: (progress: number, total: number, message: string) => Promise<void>;
}

export class VideoAnalysisAbortedError extends Error {
  constructor() {
    super("Video analysis aborted by the caller.");
    this.name = "VideoAnalysisAbortedError";
  }
}

/** Kept for its importers; there is no state left to reset. */
export function resetVideoAnalysisStateForTests(): void {}

/** 254 M7: refuses before using any argument or dependency. */
export async function analyzeVideoWithGemini(
  _source: VideoSource,
  _options: VideoAnalysisOptions,
  _deps: VideoAnalysisDeps = {},
  _ctx: VideoAnalysisContext = {},
): Promise<VideoAnalysisResult> {
  throw new GeminiRemovedError();
}
