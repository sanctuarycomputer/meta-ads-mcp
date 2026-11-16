import type https from "node:https";
import type { AssertSafeUrlOptions } from "./url-guard.js";

/**
 * 254 M9/M10: this fork downloads no URL itself. Both downloaders (this one
 * and media/safe-video-download.ts) keep their signatures and throw this as
 * their first statement, before any DNS lookup or request, whatever the URL,
 * options or injected request. The URL is not echoed: it may carry a token.
 */
export class DownloadsDisabledError extends Error {
  constructor(what: "image" | "video") {
    super(`downloads are disabled in this fork: the server does not fetch ${what} URLs`);
    this.name = "DownloadsDisabledError";
  }
}

export interface SafeImageDownloadOptions extends AssertSafeUrlOptions {
  maxBytes?: number;
  /** Also accept application/pdf (a lead form's gated file), with every other guard unchanged. */
  allowPdf?: boolean;
  maxRedirects?: number;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Optional host allowlist by suffix, enforced on every hop. */
  allowedHostSuffixes?: string[];
  request?: typeof https.request;
}

export interface SafeImageDownload {
  buffer: Buffer;
  contentType: string;
  extension: ".jpg" | ".png" | ".gif" | ".webp" | ".pdf";
  finalUrl: URL;
}

/** 254 M9/M10: refuses before any I/O. */
export async function downloadSafePublicImage(
  _rawUrl: string,
  _options: SafeImageDownloadOptions = {},
): Promise<SafeImageDownload> {
  throw new DownloadsDisabledError("image");
}
