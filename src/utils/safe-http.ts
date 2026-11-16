import { UnsafeUrlError } from "./url-guard.js";

// 254 M9/M10: the download helpers that lived here are gone with the
// downloaders; only the host allowlist check, which video delivery uses, stays.

/**
 * Host allowlist by suffix (".fbcdn.net" also matches "fbcdn.net" itself).
 * Applied to the first hop and to every redirect so a permitted host cannot
 * bounce the request elsewhere.
 */
export function assertAllowedHost(url: URL, suffixes: string[], what = "media"): void {
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
  if (!allowed) {
    throw new UnsafeUrlError("Host " + JSON.stringify(host) + " is not an allowed " + what + " host");
  }
}
