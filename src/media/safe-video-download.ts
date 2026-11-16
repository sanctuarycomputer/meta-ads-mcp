import type https from "node:https";
import type { AssertSafeUrlOptions } from "../utils/url-guard.js";
import { assertAllowedHost } from "../utils/safe-http.js";
import { DownloadsDisabledError } from "../utils/safe-download.js";

/**
 * 254 M9/M10: the fork downloads no video. downloadSafePublicVideo refuses
 * first; the host allowlist is empty, so assertAllowedVideoHost refuses every
 * host, and VIDEO_ALLOWED_HOST_SUFFIXES is no longer read.
 */

export interface SafeVideoDownloadOptions extends AssertSafeUrlOptions {
  /** Directory the file is written into; must already exist. */
  destDir: string;
  maxBytes?: number;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  allowedHostSuffixes?: string[];
  request?: typeof https.request;
}

export interface SafeVideoDownload {
  path: string;
  bytes: number;
  contentType: string;
  finalUrl: URL;
}

/** 254 M10: always empty; no env read. */
export function resolveAllowedVideoHostSuffixes(_env?: NodeJS.ProcessEnv): string[] {
  return [];
}

export function assertAllowedVideoHost(url: URL, suffixes: string[]): void {
  assertAllowedHost(url, suffixes, "video");
}

/** 254 M10: refuses before any I/O. */
export async function downloadSafePublicVideo(
  _rawUrl: string,
  _options: SafeVideoDownloadOptions,
): Promise<SafeVideoDownload> {
  throw new DownloadsDisabledError("video");
}
