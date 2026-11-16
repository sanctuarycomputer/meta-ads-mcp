import { McpError, ErrorCode } from "@modelcontextprotocol/sdk/types.js";
import { isStdioTransport } from "../utils/transport-mode.js";
import { getCurrentFbUserId } from "./token-store.js";

/**
 * Storage key for stdio / single-operator mode, the only mode this fork runs
 * in (254 M5: no HTTP transport). Facebook user ids are numeric, so this
 * cannot collide with a real tenant. It is only ever reachable via
 * isSingleTenantMode().
 */
export const LOCAL_TENANT_ID = "_local";

/**
 * True under --transport stdio. The env branch is left from the removed HTTP
 * transport's multi-tenant mode (254 M5); it never decides in stdio.
 */
export function isSingleTenantMode(argv: readonly string[] = process.argv): boolean {
  if (isStdioTransport(argv)) return true;
  return !(process.env.META_APP_ID?.trim() && process.env.META_APP_SECRET?.trim());
}

/**
 * Which per-tenant bucket (in-memory credentials, rate limits) this call may
 * use. In this stdio-only fork no request context carries an fbUserId (254
 * M5 removed the OAuth and API-key flows that set one), so it is `_local`.
 * The throw below is the removed multi-tenant HTTP mode's fail-closed branch.
 */
export function resolveTenantId(options: { feature: string; argv?: readonly string[] }): string {
  const fbUserId = getCurrentFbUserId();
  if (fbUserId) return fbUserId;

  if (isSingleTenantMode(options.argv)) return LOCAL_TENANT_ID;

  throw new McpError(
    ErrorCode.InvalidRequest,
    `The ${options.feature} tools need an authenticated user in multi-tenant mode. Sign in through the Meta OAuth flow — API-key requests have no tenant identity, so no per-user credential or quota can be resolved for them.`,
  );
}
