/**
 * Done-whens 2 and 5: in stdio mode the server reaches no host but
 * graph.facebook.com. Server start makes no request; every registered tool,
 * called once through an MCP client, connects only to graph.facebook.com and
 * carries META_ACCESS_TOKEN; the OAuth config is never reached. Static
 * sweeps: no network module or fetch outside the allowlist, and 254's files
 * read only META_ACCESS_TOKEN, META_APP_SECRET and PATH from the env.
 */
import { describe, it, expect, beforeAll, afterAll, vi } from "vitest";
import { readdirSync, readFileSync, statSync } from "node:fs";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { installEgressSpies, sampleArgs, tokenOf, type EgressSpies, type JSONSchema, type Override } from "./egress-helpers.js";
import { fakeSecret, OTHER, SECRET, TOKEN } from "./fake-secrets.js";
import { envReads, fetchNames, moduleLoads, normaliseSpecifier } from "./static-sweep.js";
import { createMockMcpServer } from "../setup.js";

const oauthCalls = vi.hoisted(() => ({ load: 0, exchange: 0 }));

vi.mock("../../src/auth/meta-oauth.js", async (orig) => {
  const m = await orig<typeof import("../../src/auth/meta-oauth.js")>();
  return {
    ...m,
    loadMetaOAuthConfig: (...a: Parameters<typeof m.loadMetaOAuthConfig>) => {
      oauthCalls.load++;
      return m.loadMetaOAuthConfig(...a);
    },
    exchangeForLongLivedToken: (...a: Parameters<typeof m.exchangeForLongLivedToken>) => {
      oauthCalls.exchange++;
      return m.exchangeForLongLivedToken(...a);
    },
  };
});

const root = fileURLToPath(new URL("../../", import.meta.url));
const GRAPH = "graph.facebook.com";
/** The SDK client's own request timer: passed through, never collapsed. */
const SDK_TIMEOUT_MS = 600_000;
const PER_CALL_MS = 10_000;
const realSetTimeout = globalThis.setTimeout;

/**
 * Per-tool arguments where the schema alone cannot reach Meta. None drops a
 * URL argument without another URL argument staying in the call.
 */
const OVERRIDES: Record<string, Override> = {
  ads_boost_ig_post: { call_to_action_type: "LEARN_MORE" },
  // Each sampled creative override (it carries image/link URLs) names its source.
  ads_clone_ad_set_bundle: (a) => ({
    ...a,
    dry_run: true,
    creative_overrides: (a.creative_overrides as Array<Record<string, unknown>> | undefined)?.map((o) => ({ ...o, source_ad_id: "123" })),
  }),
  // One layout at a time: the single-image ad (image_url, link_url, site_links) stays; the other layouts go.
  ads_create_ad_creative: { page_id: "123", cards: undefined, dynamic_creative: undefined, language_variants: undefined },
  ads_create_ad_study: {
    start_time: "2026-10-01",
    end_time: "2026-10-15",
    cells: [
      { name: "a", treatment_percentage: 50, ad_sets: ["123"] },
      { name: "b", treatment_percentage: 50, ad_sets: ["456"] },
    ],
  },
  ads_create_custom_audience: { customer_file_source: "USER_PROVIDED_ONLY" },
  // The simple fields (image_url, link_url) stay; the raw creative spec goes.
  ads_generate_preview: { page_id: "123", creative: undefined },
  ads_get_ad_creatives: { ad_id: "123" },
  ads_get_targeting_description: { ad_id: "123" },
  ads_update_ad: { status: "PAUSED" },
  ads_update_ad_creative: { name: "x" },
  ads_update_custom_audience: { name: "x" },
};

/** §5.3-group tools that make no Meta request, each with its reason. */
const NO_REQUEST: Record<string, string> = {
  ads_upload_ad_image: "M9: the server fetches no image URL; refused before any request (253 wires local files)",
};

const ENV: Record<string, string> = {
  META_ACCESS_TOKEN: TOKEN,
  META_APP_SECRET: SECRET,
  META_TOKENS: JSON.stringify({ other: OTHER }),
  FIRESTORE_PROJECT_ID: "p",
  GOOGLE_CLOUD_PROJECT: "p",
  FIRESTORE_EMULATOR_HOST: "localhost:1",
  GEMINI_API_KEY: fakeSecret("gemini"),
  APIFY_TOKEN: fakeSecret("apify"),
};
const savedEnv: Record<string, string | undefined> = {};
const savedArgv = process.argv;

/** §5.3's groups (design stacksbot-runs-meta-ads §5.3), as 252 names them. */
const SECTION_53_GROUPS = [
  "accounts", "campaigns", "adsets", "ads", "creatives", "insights", "targeting",
  "audiences", "abtesting", "pixels", "instagram", "previews", "diagnostics",
];

let spies: EgressSpies;
let client: Client;
const closers: Array<() => Promise<void>> = [];
/** Every tool (252's CATALOGUE), and what §5.3's read and write servers list. */
let tools: Tool[] = [];
let readTools: Tool[] = [];
let writeTools: Tool[] = [];

/** Each tool's requests and DNS lookups, attributed after its call settles. */
const perTool = new Map<string, { requests: EgressSpies["requests"]; dns: string[]; args: Record<string, unknown>; said: string }>();

function realTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function connect(server: McpServer): Promise<Client> {
  const c = new Client({ name: "egress-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), c.connect(clientTransport)]);
  closers.push(async () => {
    await c.close();
    await server.close();
  });
  return c;
}

async function listAll(c: Client): Promise<Tool[]> {
  const out: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.listTools({ cursor });
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

/**
 * Starts the server on 252's full catalogue (every tool, called below), and
 * §5.3's read server (META_ADS_TOOLSETS unset: the read-only default) and
 * write server (each §5.3 group and its `:write` half, where it has one).
 */
async function startServers(): Promise<void> {
  const { createServer, CATALOGUE, toolsetPlanFromEnv } = await import("../../src/server.js");
  const { ToolsetError } = await import("../../src/tools/index.js");
  client = await connect(createServer(CATALOGUE));
  tools = await listAll(client);
  readTools = await listAll(await connect(createServer(toolsetPlanFromEnv({}))));
  let names = SECTION_53_GROUPS.flatMap((g) => [g, `${g}:write`]);
  let plan;
  try {
    plan = toolsetPlanFromEnv({ META_ADS_TOOLSETS: names.join(",") });
  } catch (err) {
    if (!(err instanceof ToolsetError)) throw err;
    // A group with no write tools refuses its `:write` half by name.
    const refused = new Set(err.problems.map((p) => p.name));
    names = names.filter((n) => !refused.has(n));
    plan = toolsetPlanFromEnv({ META_ADS_TOOLSETS: names.join(",") });
  }
  writeTools = await listAll(await connect(createServer(plan)));
}

async function groupToolNames(): Promise<Set<string>> {
  const { TOOL_GROUPS } = await import("../../src/tools/index.js");
  const names = new Set<string>();
  for (const group of SECTION_53_GROUPS) {
    const server = createMockMcpServer();
    TOOL_GROUPS[group].register(server as never);
    for (const t of server._registeredTools) names.add(t.name);
  }
  return names;
}

describe("stdio egress (done-whens 2, 5)", () => {
  beforeAll(async () => {
    for (const [k, v] of Object.entries(ENV)) {
      savedEnv[k] = process.env[k];
      process.env[k] = v;
    }
    process.argv = [savedArgv[0], savedArgv[1], "--transport", "stdio"];
    const { tokenManager } = await import("../../src/auth/token-manager.js");
    tokenManager.resetForTests();
    spies = installEgressSpies();
    await startServers();
    // Loading every tool module under a busy suite can pass the 10 s default.
  }, 120_000);

  afterAll(async () => {
    for (const close of closers) await close();
    spies?.restore();
    globalThis.setTimeout = realSetTimeout;
    process.argv = savedArgv;
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  });

  it("server start makes no request, for the catalogue and §5.3's read and write servers", async () => {
    expect(tools.length).toBeGreaterThan(150);
    const all = new Set(tools.map((t) => t.name));
    expect(readTools.length).toBeGreaterThan(20);
    expect(writeTools.length).toBeGreaterThan(readTools.length);
    // Every tool the §5.3 servers serve is one the run below calls.
    for (const t of [...readTools, ...writeTools]) expect(all.has(t.name), t.name).toBe(true);
    expect(spies.connects).toEqual([]);
    expect(spies.dns).toEqual([]);
    expect(spies.requests).toEqual([]);
  });

  it(
    "every tool call connects only to graph.facebook.com, and OAuth is never reached",
    async () => {
      // Collapse every delay to 0 ms but the SDK client's own request timer.
      globalThis.setTimeout = ((fn: (...a: unknown[]) => void, ms?: number, ...args: unknown[]) =>
        realSetTimeout(fn, ms === SDK_TIMEOUT_MS ? ms : 0, ...args)) as typeof setTimeout;
      try {
        const sorted = [...tools].sort((a, b) => a.name.localeCompare(b.name));
        for (const tool of sorted) {
          const args = sampleArgs(tool.inputSchema as JSONSchema, OVERRIDES[tool.name]);
          const reqStart = spies.requests.length;
          const dnsStart = spies.dns.length;
          const connStart = spies.connects.length;
          let timer: NodeJS.Timeout | undefined;
          let said = "";
          const outcome = await Promise.race([
            client
              .callTool({ name: tool.name, arguments: args }, undefined, { timeout: SDK_TIMEOUT_MS })
              .then((result) => {
                const first = (result.content as Array<{ text?: string }> | undefined)?.[0];
                said = (first?.text ?? "").slice(0, 160);
                return "done";
              }, (err: unknown) => `rejected: ${(err as Error).message}`),
            new Promise<string>((resolve) => {
              timer = realSetTimeout(() => resolve("timed out"), PER_CALL_MS);
            }),
          ]);
          clearTimeout(timer);
          expect(outcome, `${tool.name}`).toBe("done");
          await realTurn();
          await realTurn();
          const requests = spies.requests.slice(reqStart);
          const lookups = spies.dns.slice(dnsStart);
          perTool.set(tool.name, { requests, dns: lookups, args, said });
          for (const host of spies.connects.slice(connStart)) expect(host, `${tool.name} connected`).toBe(GRAPH);
          for (const r of requests) expect(r.url.host, `${tool.name} fetched`).toBe(GRAPH);
          const argText = JSON.stringify(args);
          for (const host of lookups) {
            expect(host === GRAPH || argText.includes(host), `${tool.name} looked up ${host}`).toBe(true);
          }
        }
      } finally {
        globalThis.setTimeout = realSetTimeout;
      }
      // Whatever a call left running and recorded after its own window (the
      // last tool's especially) is checked here, over the whole run.
      await realTurn();
      await realTurn();
      const allArgs = JSON.stringify([...perTool.values()].map((t) => t.args));
      for (const host of spies.connects) expect(host, "a connect after its tool's window").toBe(GRAPH);
      for (const r of spies.requests) expect(r.url.host, "a request after its tool's window").toBe(GRAPH);
      for (const host of spies.dns) expect(host === GRAPH || allArgs.includes(host), `late lookup of ${host}`).toBe(true);
      expect(perTool.size).toBe(tools.length);
      // A caller URL under an optional parent is sent too (the lead form's
      // cover image), so the run sees the lookup a tool makes for it.
      expect(JSON.stringify(perTool.get("ads_create_lead_form")?.args.context_card)).toContain("cdn.example.test");
      expect(oauthCalls.load).toBe(0);
      expect(oauthCalls.exchange).toBe(0);
    },
    300_000,
  );

  it("§5.3-group tools reach Meta, or are named with a reason", async () => {
    const names = await groupToolNames();
    expect(names.size).toBeGreaterThan(30);
    const silent: string[] = [];
    for (const name of names) {
      const seen = perTool.get(name);
      expect(seen, `${name} was called`).toBeDefined();
      if (seen!.requests.length === 0 && !(name in NO_REQUEST)) silent.push(`${name}: ${seen!.said}`);
    }
    expect(silent, "tools that made no request and are not in NO_REQUEST").toEqual([]);
    for (const name of Object.keys(NO_REQUEST)) {
      expect(names.has(name), `${name} in NO_REQUEST is a §5.3-group tool`).toBe(true);
      expect(perTool.get(name)?.requests.length, `${name} in NO_REQUEST made a request`).toBe(0);
    }
  });

  it("§5.3-group requests carry META_ACCESS_TOKEN", async () => {
    const names = await groupToolNames();
    let checked = 0;
    for (const name of names) {
      for (const r of perTool.get(name)?.requests ?? []) {
        expect(tokenOf(r), `${name} ${r.url.pathname}`).toBe(TOKEN);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });

  it("no request goes to an OAuth path or www.facebook.com", () => {
    expect(spies.requests.length).toBeGreaterThan(0);
    for (const r of spies.requests) {
      expect(r.url.pathname).not.toContain("/oauth/");
      expect(r.url.host).not.toBe("www.facebook.com");
    }
  });
});

// ─── Static sweeps ──────────────────────────────────────────────────────────

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = path.join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (full.endsWith(".ts")) out.push(full);
  }
  return out;
}

const SRC = path.join(root, "src");
const rel = (file: string) => path.relative(root, file).split(path.sep).join("/");

const FORBIDDEN = new Set(["http", "https", "net", "tls", "http2", "dgram", "dns", "child_process", "undici", "@google-cloud/firestore", "express"]);
const ALLOWED: Record<string, string[]> = {
  "src/utils/url-guard.ts": ["dns", "net"],
  "src/media/ffmpeg.ts": ["child_process"],
  "src/meta/write-guard.ts": ["child_process"],
};

describe("static egress sweeps", () => {
  it("no network module outside the allowlist", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const { specs, dynamic } = moduleLoads(file, readFileSync(file, "utf8"));
      for (const d of dynamic) hits.push(`${rel(file)}: non-literal load ${d}`);
      for (const spec of specs) {
        const mod = normaliseSpecifier(spec);
        if (FORBIDDEN.has(mod) && !(ALLOWED[rel(file)] ?? []).includes(mod)) hits.push(`${rel(file)}: ${spec}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("fetch only in the Meta client and OAuth", () => {
    const hits = walk(SRC)
      .filter((f) => !rel(f).startsWith("src/meta/") && rel(f) !== "src/auth/meta-oauth.ts")
      .flatMap((f) => fetchNames(f, readFileSync(f, "utf8")).map((h) => `${rel(f)}: ${h}`));
    expect(hits).toEqual([]);
  });

  it("env reads in 254's files are META_ACCESS_TOKEN, META_APP_SECRET and PATH", () => {
    const files = [
      ...["utils", "apify", "gemini", "store", "media", "transport"].flatMap((d) => walk(path.join(SRC, d))),
      path.join(SRC, "auth/token-manager.ts"),
    ];
    const names = new Set<string>();
    const opaque: string[] = [];
    for (const file of files) {
      const found = envReads(file, readFileSync(file, "utf8"));
      for (const n of found.names) names.add(n);
      for (const o of found.opaque) opaque.push(`${rel(file)}: ${o}`);
    }
    expect(opaque).toEqual([]);
    expect([...names].sort()).toEqual(["META_ACCESS_TOKEN", "META_APP_SECRET", "PATH"]);
  });

  it("no src file but meta-oauth.ts names loadMetaOAuthConfig", () => {
    const hits = walk(SRC)
      .filter((f) => rel(f) !== "src/auth/meta-oauth.ts")
      .filter((f) => readFileSync(f, "utf8").includes("loadMetaOAuthConfig"))
      .map(rel);
    expect(hits).toEqual([]);
  });
});
