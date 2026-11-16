/**
 * createServer fails closed (ticket 252, spec §Fail closed and review M15):
 * with no argument it serves only what META_ADS_TOOLSETS selects, and no
 * skill instructions, prompts or resources; the full catalogue is reachable
 * only from code, as createServer(CATALOGUE).
 */
import { describe, it, expect, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CATALOGUE, createServer } from "../../src/server.js";
import { ToolsetError } from "../../src/tools/index.js";

const ENV_KEYS = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

function setEnv(values: Partial<Record<(typeof ENV_KEYS)[number], string>>): void {
  for (const k of ENV_KEYS) delete process.env[k];
  Object.assign(process.env, values);
}

async function connect(server: McpServer) {
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

async function served(server: McpServer) {
  const { client, close } = await connect(server);
  try {
    const list = await client.listTools();
    return {
      tools: list.tools.map((t) => t.name).sort(),
      bytes: Buffer.byteLength(JSON.stringify(list), "utf8"),
      instructions: client.getInstructions(),
      capabilities: client.getServerCapabilities() ?? {},
    };
  } finally {
    await close();
  }
}

describe("createServer() reads the toolsets from the env", () => {
  it("with nothing set, serves only read tools and no skill text", async () => {
    setEnv({});
    const s = await served(createServer());
    expect(s.tools).toContain("ads_get_campaigns");
    expect(s.tools).not.toContain("ads_create_campaign");
    expect(s.tools).not.toContain("ads_library_scrape");
    expect(s.tools.length).toBe(34);
    expect(s.instructions).toBeUndefined();
    expect(s.capabilities.prompts).toBeUndefined();
    expect(s.capabilities.resources).toBeUndefined();
  });

  it("with META_ADS_TOOLSETS set, serves exactly that", async () => {
    setEnv({ META_ADS_TOOLSETS: "campaigns:write" });
    expect((await served(createServer())).tools).toEqual(
      ["ads_create_campaign", "ads_delete_campaign", "ads_update_campaign"],
    );
  });

  it("refuses a bad name instead of building a server", () => {
    setEnv({ META_ADS_TOOLSETS: "tokens" });
    expect(() => createServer()).toThrow(ToolsetError);
  });
});

describe("createServer(CATALOGUE)", () => {
  it("serves all 168 tools and the skill instructions, whatever the env says", async () => {
    setEnv({ META_ADS_TOOLSETS: "campaigns", META_ADS_READ_ONLY: "1" });
    const s = await served(createServer(CATALOGUE));
    expect(s.tools.length).toBe(168);
    expect(s.tools).toContain("ads_library_scrape");
    expect(s.instructions).toMatch(/ads_get_ad_dossier/);
    expect(s.capabilities.prompts).toBeDefined();
    expect(s.capabilities.resources).toBeDefined();
  });
});

/** Size (done-when 4 as amended, d-20261116-052159749): 4 bytes per token. */
const READ_LIMIT_BYTES = 8_000 * 4;
const WRITE_LIMIT_BYTES = 16_000 * 4;
const DEFAULT_READ = "accounts,campaigns,adsets,ads,creatives,insights,audiences,abtesting,pixels,instagram,diagnostics";
const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";

describe("tools/list size (check 4)", () => {
  it("the read list, unset, is under 8k tokens", async () => {
    setEnv({ META_ADS_READ_ONLY: "1" });
    const { bytes } = await served(createServer());
    expect(bytes).toBeLessThan(READ_LIMIT_BYTES);
  });

  it("the read list, set to the default string, is the same and under 8k tokens", async () => {
    setEnv({ META_ADS_READ_ONLY: "1" });
    const unset = await served(createServer());
    setEnv({ META_ADS_READ_ONLY: "1", META_ADS_TOOLSETS: DEFAULT_READ });
    const set = await served(createServer());
    expect(set.tools).toEqual(unset.tools);
    expect(set.bytes).toBeLessThan(READ_LIMIT_BYTES);
  });

  it("the write list is under 16k tokens", async () => {
    setEnv({ META_ADS_TOOLSETS: WRITE_LIST });
    const { tools, bytes } = await served(createServer());
    expect(tools.length).toBe(16);
    expect(bytes).toBeLessThan(WRITE_LIMIT_BYTES);
  });
});
