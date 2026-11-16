import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { LOCAL_TENANT_ID, resolveTenantId } from "../auth/tenant.js";

/**
 * 254 M7: Apify is removed from this fork. The module keeps the names and
 * types other files import; every request, and the token lookup that would
 * precede one, throws ApifyRemovedError before any I/O. APIFY_TOKEN and
 * registered tokens are never read.
 */
export class ApifyRemovedError extends Error {
  constructor() {
    super("removed in this fork: Apify");
    this.name = "ApifyRemovedError";
  }
}

export const ADS_LIBRARY_ACTOR_ID = "curious_coder~facebook-ads-library-scraper";

export { LOCAL_TENANT_ID };

const APIFY_TOKEN_PATTERN = /apify_api_[A-Za-z0-9]+/g;

/**
 * Belt-and-braces: Apify does not echo tokens in error bodies today, but a
 * malformed request could surface one, and these strings end up in McpError
 * messages that travel back to the MCP client.
 *
 * `exactToken` covers credentials that do not match the `apify_api_` shape —
 * legacy, future, or simply malformed values the pattern alone would miss.
 */
export function scrubApifyToken(text: string, exactToken?: string): string {
  if (!exactToken || exactToken.length < 8) {
    return text.replace(APIFY_TOKEN_PATTERN, "apify_api_[REDACTED]");
  }

  // Both alternatives must be considered in a single left-to-right pass.
  // Neither sequential order is safe: running the pattern first leaves the
  // tail of a hybrid value (`apify_api_abc-secret` → `…[REDACTED]-secret`),
  // while running the exact value first fragments a longer token that the
  // exact value happens to prefix (`apify_api_abc` inside `apify_api_abcdef`
  // → `[REDACTED]def`). Folding trailing base62 into the exact alternative
  // makes it swallow the whole credential either way.
  const combined = new RegExp(
    `${escapeRegExp(exactToken)}[A-Za-z0-9]*|apify_api_[A-Za-z0-9]+`,
    "g",
  );
  return text.replace(combined, (match) =>
    match.startsWith("apify_api_") ? "apify_api_[REDACTED]" : "[REDACTED]",
  );
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Apify run/dataset/actor ids are 17-char base62. Validating keeps them out of the URL path as anything else. */
export function validateApifyId(id: string, label: string): string {
  const trimmed = id.trim();
  if (!/^[A-Za-z0-9]{5,32}$/.test(trimmed)) {
    throw new McpError(
      ErrorCode.InvalidParams,
      `Invalid Apify ${label} id "${trimmed}". Expected 5-32 alphanumeric characters.`,
    );
  }
  return trimmed;
}

/**
 * Shows only the non-secret `apify_api_` prefix. Deliberately reveals no
 * characters of the secret body — not even a suffix — since nothing downstream
 * needs to disambiguate between two tokens for the same user (there is only
 * ever one).
 */
export function maskApifyToken(token: string): string {
  return token.startsWith("apify_api_") ? "apify_api_***" : "***";
}

/**
 * Which encrypted-token bucket this request may read. Fails closed in
 * multi-tenant mode without an OAuth identity (see src/auth/tenant.ts): an
 * unidentified caller must never land on the shared `_local` bucket or the
 * server-wide APIFY_TOKEN and spend another tenant's Apify credit.
 */
export function resolveApifyTenantId(): string {
  return resolveTenantId({ feature: "ads_library_*" });
}

/** 254 M7: no Apify token, the server-wide one included, is ever used. */
export function isApifyEnvFallbackUsable(): boolean {
  return false;
}

/** 254 M7: refuses; no token is looked up. */
export async function resolveApifyToken(): Promise<string> {
  throw new ApifyRemovedError();
}

export interface ApifyRequestParams {
  [key: string]: string | number | boolean | undefined;
}

/** Same methods and signatures as before; each refuses before any request. */
export class ApifyApiClient {
  constructor(_config?: { timeout?: number; maxRetries?: number }) {}

  async get<T>(_path: string, _params?: ApifyRequestParams, _tokenOverride?: string): Promise<T> {
    throw new ApifyRemovedError();
  }

  async post<T>(_path: string, _body?: unknown, _params?: ApifyRequestParams, _tokenOverride?: string): Promise<T> {
    throw new ApifyRemovedError();
  }

  async delete<T>(_path: string, _params?: ApifyRequestParams, _tokenOverride?: string): Promise<T> {
    throw new ApifyRemovedError();
  }
}

export const apifyApiClient = new ApifyApiClient();
