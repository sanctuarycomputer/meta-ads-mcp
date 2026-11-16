import { UnsafeUrlError } from "./url-guard.js";

// 254 M9/M10: the download helpers that lived here are gone with the
// downloaders; only the host allowlist check, which video delivery uses, stays.

/**
 * Host allowlist by suffix (".fbcdn.net" also matches "fbcdn.net" itself).
 * With the downloaders gone (254 M9/M10) this only screens a URL against a
 * list; video delivery passes the empty list, which refuses every host.
 */
export function assertAllowedHost(url: URL, suffixes: string[], what = "media"): void {
  const host = url.hostname.toLowerCase();
  const allowed = suffixes.some((suffix) => host.endsWith(suffix) || host === suffix.slice(1));
  if (!allowed) {
    throw new UnsafeUrlError("Host " + JSON.stringify(host) + " is not an allowed " + what + " host");
  }
}
