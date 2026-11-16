import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * Standard ToolAnnotations by tool kind, applied across all v3 tools so that
 * MCP clients (Claude, ChatGPT, Perplexity) get consistent confirmation hints.
 *
 * Spread these into the `annotations` field of `server.registerTool(...)`.
 */

export const READ: ToolAnnotations = { readOnlyHint: true };

/** Creates a new entity. Re-running may produce duplicates. */
export const CREATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
};

/** Updates fields on an existing entity. Same input → same result. */
export const UPDATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Deletes an entity. Cannot be undone; re-deleting is a no-op. */
export const DELETE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
};

/** Status toggle (activate/pause/archive) or comment moderation. */
export const TOGGLE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Uploads media (image/video). New asset every call. */
export const UPLOAD: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
};

/** Token / session management. */
export const TOKEN: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Prefix every write-tool description so clients that ignore annotations still see the warning. */
export const WRITE_WARNING = "⚠️ Modifies live ads/account data. ";

/** Same, for WhatsApp Business tools. */
export const WHATSAPP_WRITE_WARNING = "⚠️ Modifies live WhatsApp Business data. ";

/** Same, for Apify-backed tools: these spend the tenant's Apify credit or touch their stored credentials. */
export const APIFY_WRITE_WARNING = "⚠️ Uses your Apify account (paid credits / stored credentials). ";

/** Same, for Gemini-backed tools: these spend the tenant's Gemini quota or touch their stored key. */
export const GEMINI_WRITE_WARNING = "⚠️ Uses your Gemini API key (paid quota / stored credentials). ";

/**
 * The only face of the server a tool group sees when toolsets are in force
 * (ticket 252): one method, `registerTool`, which hands a tool to the real
 * server only when `admit` says so and drops it otherwise. It is a plain
 * object, not a Proxy and not linked to McpServer's prototype, so a group
 * calling `tool`, `registerPrompt` or anything else throws instead of
 * registering past the filter.
 */
export function toolFilter(
  server: McpServer,
  admit: (name: string, annotations: ToolAnnotations | undefined) => boolean,
): Pick<McpServer, "registerTool"> {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const registerTool = (name: string, config: { annotations?: ToolAnnotations }, handler: unknown): unknown =>
    admit(name, config.annotations) ? register(name, config, handler) : undefined;
  return { registerTool: registerTool as unknown as McpServer["registerTool"] };
}
