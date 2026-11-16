import type { VideoSource } from "../media/video-sources.js";
import { GeminiRemovedError, type GeminiKeySource, type GeminiUsage } from "./client.js";

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

/** Accepted for its callers' sake and never used: nothing is injected into a refusal. */
export type VideoAnalysisDeps = object;

export interface VideoAnalysisContext {
  signal?: AbortSignal;
  report?: (progress: number, total: number, message: string) => Promise<void>;
}

/** 254 M7: refuses before using any argument or dependency. */
export async function analyzeVideoWithGemini(
  _source: VideoSource,
  _options: VideoAnalysisOptions,
  _deps: VideoAnalysisDeps = {},
  _ctx: VideoAnalysisContext = {},
): Promise<VideoAnalysisResult> {
  throw new GeminiRemovedError();
}
