import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import { tokenManager } from "./token-manager.js";

export interface RequestContext {
  accessToken: string;
  fbUserId?: string;
}

/**
 * AsyncLocalStorage to thread a per-call Meta access token through to the
 * MetaApiClient without passing it explicitly. In this stdio-only fork its
 * writer is page-token.ts (a Page token for one call); the HTTP middleware
 * that resolved tenant tokens is removed (254 M5).
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

/**
 * Get the current request's access token.
 *
 * Priority:
 *  1. AsyncLocalStorage context (a Page token for one call, page-token.ts)
 *  2. TokenManager active token (254 M4: META_ACCESS_TOKEN, read once)
 *  3. META_ACCESS_TOKEN env var, read now (set after the manager loaded)
 */
export function getAccessToken(): string {
  // Each source is trimmed here, once, so the value sent, signed, hashed and
  // scrubbed is one string. A blank token is returned as "", not passed over
  // for the next source: the client refuses it rather than send another
  // token in its place.
  // Any context with a string token decides, an empty one included (251
  // final-3 F2): "" is refused downstream, never replaced by the env token.
  const ctx = requestContext.getStore();
  if (ctx !== undefined && typeof ctx.accessToken === "string") {
    return ctx.accessToken.trim();
  }

  const managerToken = tokenManager.getActiveToken();
  if (managerToken) {
    return managerToken.trim();
  }

  const envToken = process.env.META_ACCESS_TOKEN;
  if (envToken) {
    return envToken.trim();
  }

  throw new Error(
    "No Meta access token available. Set META_ACCESS_TOKEN.",
  );
}

export function getCurrentFbUserId(): string | undefined {
  return requestContext.getStore()?.fbUserId;
}

/**
 * Short, stable, non-reversible identifier for the currently active access token.
 *
 * Used as a bucket key for rate-limit and circuit-breaker state so we never
 * log or serialize the raw token. SHA-256 truncated to 12 hex chars ≈ 48 bits
 * of entropy — enough to avoid collisions across an agency's handful of tokens.
 */
export function getAccessTokenHash(): string {
  const token = getAccessToken();
  return hashToken(token);
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 12);
}

/**
 * Hash personally-identifying values (email, fbUserId, etc.) before
 * including them in log lines (CODE-B5). The output is a stable
 * 12-hex-char prefix of SHA-256 — enough to correlate events from the
 * same user without storing the raw value in our log retention.
 *
 * Returns null if input is null/undefined so callers can pass through
 * optional fields without conditional clutter:
 *
 *   logger.info({ tenant: hashPii(tenant) }, "Gemini key registered");
 */
export function hashPii(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") return null;
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
