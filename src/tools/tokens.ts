import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ, TOKEN, DELETE, WRITE_WARNING } from "./_register.js";

// The token tools stay registered (the catalogue and the toolsets keep their names) but refuse before any request:
// this fork takes its token from the environment, and no tool accepts, stores or switches a caller's token.
const REMOVED = { isError: true, content: [{ type: "text" as const, text: "removed in this fork" }] };

const TOOLS = [
  ["ads_list_tokens", READ],
  ["ads_set_active_token", TOKEN],
  ["ads_register_token", TOKEN],
  ["ads_delete_token", DELETE],
] as const;

export function registerTokenTools(server: McpServer): void {
  for (const [name, annotations] of TOOLS) {
    server.registerTool(
      name,
      {
        // registration.test.ts holds every non-read-only tool's description to the warning prefix.
        description: `${annotations.readOnlyHint ? "" : WRITE_WARNING}Removed in this fork.`,
        inputSchema: {},
        annotations: { ...annotations },
      },
      async () => REMOVED,
    );
  }
}
