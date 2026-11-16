import { readFileSync } from "node:fs";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAllTools, registerToolsets, resolveToolsets } from "./tools/index.js";
import { SERVER_INSTRUCTIONS } from "./skills/instructions.js";
import { registerSkillPrompts } from "./skills/prompts.js";
import { registerSkillResources } from "./skills/resources.js";
import { logger } from "./utils/logger.js";

/**
 * Read from package.json rather than kept in step by hand: the two had already
 * drifted. `rootDir: src` rules out importing the file, so it is read at
 * startup, once, and a failure falls back rather than taking the server down.
 */
let cachedVersion: string | undefined;

function serverVersion(): string {
  if (cachedVersion) return cachedVersion;
  try {
    const raw = readFileSync(new URL("../package.json", import.meta.url), "utf8");
    const version = (JSON.parse(raw) as { version?: unknown }).version;
    if (typeof version === "string" && /^\d+\.\d+\.\d+/.test(version)) {
      cachedVersion = version;
      return version;
    }
  } catch {
    // fall through
  }
  logger.warn({ event: "server_version_unknown" }, "Could not read the version from package.json");
  cachedVersion = "0.0.0";
  return cachedVersion;
}

/**
 * What a server serves: which tools, and whether the skill instructions,
 * prompts and resources come with them.
 */
export interface ServerPlan {
  readonly register: (server: McpServer) => void;
  readonly skills: boolean;
}

/**
 * Every tool and the skills that describe them: the upstream catalogue.
 * Reachable only from code (tests); no env or flag selects it (ticket 252).
 */
export const CATALOGUE: ServerPlan = Object.freeze({ register: registerAllTools, skills: true });

/**
 * The tools META_ADS_TOOLSETS selects (unset: the read-only default), and no
 * skill text, since the skills name tools that may not be served. Throws a
 * ToolsetError naming each bad name.
 */
export function toolsetPlanFromEnv(env: NodeJS.ProcessEnv = process.env): ServerPlan {
  const selection = resolveToolsets(env);
  return Object.freeze({ register: (server: McpServer) => registerToolsets(server, selection), skills: false });
}

/**
 * Create a new MCP server instance. With no plan it fails closed: it serves
 * only what the env selects (see toolsetPlanFromEnv).
 *
 * In stateless HTTP mode, a new server is created per request.
 * In stdio mode, a single server is used for the session.
 */
export function createServer(plan: ServerPlan = toolsetPlanFromEnv()): McpServer {
  const server = new McpServer(
    {
      name: "meta-ads-mcp",
      version: serverVersion(),
    },
    plan.skills ? { instructions: SERVER_INSTRUCTIONS } : undefined,
  );

  plan.register(server);
  if (plan.skills) {
    registerSkillPrompts(server);
    registerSkillResources(server);
  }

  return server;
}
