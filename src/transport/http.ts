import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * 254 M5: this fork has no HTTP transport. The shim keeps the signature so a
 * launch with --transport http fails at once (exit 1 through index.ts's
 * catch) instead of opening a port.
 */
export async function startHttpTransport(_createServer: () => McpServer, _port: number): Promise<void> {
  throw new Error("HTTP transport removed in this fork: start with --transport stdio");
}
