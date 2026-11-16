/**
 * The "registers nothing" rule on shapes no real group has at f4dbacb
 * (ticket 252, spec §Names): two allowed groups' modules are replaced, so
 * the rule is decided here for a group with no read tools and for a group
 * whose only write tool is excluded by name.
 */
import { describe, it, expect, vi } from "vitest";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ToolsetError, resolveToolsets, registerToolsets } from "../../src/tools/index.js";
import { createMockMcpServer } from "../setup.js";

const handler = async () => ({ content: [] });

// help: one write tool and no read tool.
vi.mock("../../src/tools/help.js", () => ({
  registerHelpTools: (server: McpServer) => {
    server.registerTool("seam_write", { description: "w", annotations: { destructiveHint: false } }, handler);
  },
}));

// rate-status: one read tool, and one write tool that is excluded by name.
vi.mock("../../src/tools/rate-status.js", () => ({
  registerRateStatusTools: (server: McpServer) => {
    server.registerTool("seam_read", { description: "r", annotations: { readOnlyHint: true } }, handler);
    server.registerTool("ads_clone_ad_set_bundle", { description: "w", annotations: { destructiveHint: false } }, handler);
  },
}));

function reason(value: string): string | undefined {
  try {
    resolveToolsets({ META_ADS_TOOLSETS: value });
    return undefined;
  } catch (error) {
    expect(error).toBeInstanceOf(ToolsetError);
    return (error as ToolsetError).problems[0]?.reason;
  }
}

describe("registers nothing", () => {
  it("refuses the read name of a group with no read tools", () => {
    expect(reason("help")).toBe("registers nothing");
  });

  it("accepts the write name of that group, which registers its write tool", () => {
    expect(reason("help:write")).toBeUndefined();
    const server = createMockMcpServer();
    registerToolsets(server as never, resolveToolsets({ META_ADS_TOOLSETS: "help:write" }));
    expect(server._registeredTools.map((t) => t.name)).toEqual(["seam_write"]);
  });

  it("refuses a write name whose only write tool is excluded by name", () => {
    expect(reason("rate-status:write")).toBe("registers nothing");
    expect(reason("rate-status")).toBeUndefined();
  });
});
