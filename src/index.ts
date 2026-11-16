#!/usr/bin/env node
/**
 * Meta Ads MCP server.
 *
 * --transport stdio|http   Required (also --transport=x, -t x, -tx). No flag,
 *                          or any other value, refuses to start (exit 2).
 * --port / PORT            HTTP only; default 3000.
 *
 * META_ADS_TOOLSETS        Comma-separated tool groups to serve. `<group>`
 *                          serves the group's read tools, `<group>:write` the
 *                          rest. Unset serves the read-only default
 *                          (accounts,campaigns,adsets,ads,creatives,insights,
 *                          audiences,abtesting,pixels,instagram,diagnostics);
 *                          set but empty refuses. An unknown, never, kept-out
 *                          or empty group refuses to start (exit 2), naming it.
 * META_ADS_READ_ONLY       Unset, empty or "1". "1" refuses any `:write` name;
 *                          any other value refuses to start.
 *
 * Every refusal is one line on stderr and exit status 2, before any transport
 * starts.
 */

import { parseArgs } from "node:util";
import { createServer, toolsetPlanFromEnv, type ServerPlan } from "./server.js";
import { startStdioTransport } from "./transport/stdio.js";
import { ToolsetError } from "./tools/index.js";
import { isStdioTransport } from "./utils/transport-mode.js";
import { logger } from "./utils/logger.js";

function refuse(message: string): never {
  process.stderr.write(`meta-ads-mcp: ${message}\n`);
  process.exit(2);
}

const { values } = parseArgs({
  options: {
    transport: { type: "string", short: "t" },
    port: { type: "string", short: "p", default: process.env.PORT ?? "3000" },
  },
  strict: false,
});

const transport = typeof values.transport === "string" ? values.transport : undefined;
if (transport !== "stdio" && transport !== "http") {
  refuse(`--transport must be stdio or http (got ${transport === undefined ? "none" : JSON.stringify(transport)})`);
}
// The logger and the tenant switch read the transport through isStdioTransport;
// starting a different one from what they see would put logs on the JSON-RPC stream.
if ((transport === "stdio") !== isStdioTransport(process.argv)) {
  refuse(`--transport is ambiguous in ${JSON.stringify(process.argv.slice(2).join(" "))}; give it as --transport ${transport}`);
}

let plan: ServerPlan;
try {
  plan = toolsetPlanFromEnv();
} catch (error) {
  if (error instanceof ToolsetError) refuse(error.message);
  throw error;
}

const port = parseInt(String(values.port ?? "3000"), 10);

async function main(): Promise<void> {
  logger.info({ transport, port: transport === "http" ? port : undefined }, "Starting Meta Ads MCP server");

  if (transport === "stdio") {
    await startStdioTransport(createServer(plan));
  } else {
    // Loaded only for HTTP, so stdio never loads its OAuth routes or store clients.
    const { startHttpTransport } = await import("./transport/http.js");
    await startHttpTransport(() => createServer(plan), port);
  }
}

main().catch((error) => {
  logger.fatal({ error }, "Failed to start server");
  process.exit(1);
});
