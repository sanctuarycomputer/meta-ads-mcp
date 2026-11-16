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
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { Tool } from "@modelcontextprotocol/sdk/types.js";
import { installEgressSpies, sampleArgs, tokenOf, type EgressSpies, type JSONSchema } from "./egress-helpers.js";
import { fakeSecret, OTHER, SECRET, TOKEN } from "./fake-secrets.js";
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

/** Per-tool arguments where the schema alone cannot reach Meta. */
const OVERRIDES: Record<string, Record<string, unknown>> = {
  ads_boost_ig_post: { call_to_action_type: "LEARN_MORE" },
  ads_clone_ad_set_bundle: { dry_run: true },
  ads_create_ad_creative: { page_id: "123" },
  ads_create_ad_study: {
    start_time: "2026-10-01",
    end_time: "2026-10-15",
    cells: [
      { name: "a", treatment_percentage: 50, ad_sets: ["123"] },
      { name: "b", treatment_percentage: 50, ad_sets: ["456"] },
    ],
  },
  ads_create_custom_audience: { customer_file_source: "USER_PROVIDED_ONLY" },
  ads_generate_preview: { page_id: "123" },
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

let spies: EgressSpies;
let client: Client;
let closeAll: () => Promise<void>;
let tools: Tool[] = [];

/** Each tool's requests and DNS lookups, attributed after its call settles. */
const perTool = new Map<string, { requests: EgressSpies["requests"]; dns: string[]; args: Record<string, unknown>; said: string }>();

function realTurn(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

async function connect(): Promise<void> {
  const { createServer } = await import("../../src/server.js");
  const server = createServer();
  client = new Client({ name: "egress-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  closeAll = async () => {
    await client.close();
    await server.close();
  };
}

async function listAll(): Promise<Tool[]> {
  const out: Tool[] = [];
  let cursor: string | undefined;
  do {
    const page = await client.listTools({ cursor });
    out.push(...page.tools);
    cursor = page.nextCursor;
  } while (cursor);
  return out;
}

async function groupToolNames(): Promise<Set<string>> {
  const mods = await Promise.all([
    import("../../src/tools/accounts.js").then((m) => m.registerAccountTools),
    import("../../src/tools/campaigns.js").then((m) => m.registerCampaignTools),
    import("../../src/tools/adsets.js").then((m) => m.registerAdSetTools),
    import("../../src/tools/ads.js").then((m) => m.registerAdTools),
    import("../../src/tools/creatives.js").then((m) => m.registerCreativeTools),
    import("../../src/tools/insights.js").then((m) => m.registerInsightsTools),
    import("../../src/tools/targeting.js").then((m) => m.registerTargetingTools),
    import("../../src/tools/audiences.js").then((m) => m.registerAudienceTools),
    import("../../src/tools/abtesting.js").then((m) => m.registerABTestingTools),
    import("../../src/tools/pixels.js").then((m) => m.registerPixelTools),
    import("../../src/tools/instagram.js").then((m) => m.registerInstagramTools),
    import("../../src/tools/previews.js").then((m) => m.registerPreviewTools),
    import("../../src/tools/diagnostics.js").then((m) => m.registerDiagnosticTools),
  ]);
  const names = new Set<string>();
  for (const register of mods) {
    const server = createMockMcpServer();
    register(server as never);
    for (const t of server._registeredTools) names.add(t.name);
  }
  return names;
}

beforeAll(async () => {
  for (const [k, v] of Object.entries(ENV)) {
    savedEnv[k] = process.env[k];
    process.env[k] = v;
  }
  process.argv = [savedArgv[0], savedArgv[1], "--transport", "stdio"];
  const { tokenManager } = await import("../../src/auth/token-manager.js");
  tokenManager.resetForTests();
  spies = installEgressSpies();
  await connect();
});

afterAll(async () => {
  await closeAll?.();
  spies?.restore();
  globalThis.setTimeout = realSetTimeout;
  process.argv = savedArgv;
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

describe("stdio egress (done-whens 2, 5)", () => {
  it("server start makes no request", async () => {
    tools = await listAll();
    expect(tools.length).toBeGreaterThan(50);
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
      expect(perTool.size).toBe(tools.length);
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

/** Block comments and whole-line comments out; a `//` inside a string stays. */
function code(file: string): string {
  return readFileSync(file, "utf8")
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .replace(/^\s*\/\/.*$/gm, "");
}

/** Value module specifiers (type-only imports and exports don't count), and non-literal loads. */
function specifiersOf(text: string): { specs: string[]; dynamic: string[] } {
  const specs: string[] = [];
  const dynamic: string[] = [];
  const fromRe = /\b(import|export)\s+(type\s+)?([^;'"]*?)\s*from\s*['"]([^'"]+)['"]/g;
  for (const m of text.matchAll(fromRe)) {
    if (m[2]) continue;
    const list = m[3].match(/^\{([\s\S]*)\}$/);
    if (list) {
      const items = list[1].split(",").map((s) => s.trim()).filter(Boolean);
      if (items.length > 0 && items.every((s) => s.startsWith("type "))) continue;
    }
    specs.push(m[4]);
  }
  for (const m of text.matchAll(/\bimport\s*['"]([^'"]+)['"]/g)) specs.push(m[1]);
  for (const m of text.matchAll(/\b(?:import|require)\s*\(\s*([^)]*?)\s*\)/g)) {
    const lit = m[1].match(/^['"`]([^'"`$]+)['"`]$/);
    if (lit) specs.push(lit[1]);
    else dynamic.push(m[0]);
  }
  return { specs, dynamic };
}

function normalise(spec: string): string {
  const bare = spec.replace(/^node:/, "");
  if (bare.startsWith("@")) return bare.split("/").slice(0, 2).join("/");
  return bare.split("/")[0];
}

const FORBIDDEN = new Set(["http", "https", "net", "tls", "http2", "dgram", "dns", "child_process", "undici", "@google-cloud/firestore", "express"]);
const ALLOWED: Record<string, string[]> = {
  "src/utils/url-guard.ts": ["dns", "net"],
  "src/media/ffmpeg.ts": ["child_process"],
};

describe("static egress sweeps", () => {
  it("no network module outside the allowlist", () => {
    const hits: string[] = [];
    for (const file of walk(SRC)) {
      const { specs, dynamic } = specifiersOf(code(file));
      for (const d of dynamic) hits.push(`${rel(file)}: non-literal load ${d}`);
      for (const s of specs) {
        const mod = normalise(s);
        if (FORBIDDEN.has(mod) && !(ALLOWED[rel(file)] ?? []).includes(mod)) hits.push(`${rel(file)}: ${s}`);
      }
    }
    expect(hits).toEqual([]);
  });

  it("fetch only in the Meta client and OAuth", () => {
    const re = /\bfetch\s*\(|\bdoFetch\b|\bconfig\.fetch\b|\bdeps\.fetch\b/;
    const hits = walk(SRC)
      .filter((f) => !rel(f).startsWith("src/meta/") && rel(f) !== "src/auth/meta-oauth.ts")
      .filter((f) => re.test(code(f)))
      .map(rel);
    expect(hits).toEqual([]);
  });

  it("env reads in 254's files are META_ACCESS_TOKEN, META_APP_SECRET and PATH", () => {
    const files = [
      ...["utils", "apify", "gemini", "store", "media", "transport"].flatMap((d) => walk(path.join(SRC, d))),
      path.join(SRC, "auth/token-manager.ts"),
    ];
    const names = new Set<string>();
    const bare: string[] = [];
    for (const file of files) {
      const text = code(file);
      for (const m of text.matchAll(/process\.env\.([A-Za-z_][A-Za-z0-9_]*)/g)) names.add(m[1]);
      for (const m of text.matchAll(/process\.env\[\s*['"]([^'"]+)['"]\s*\]/g)) names.add(m[1]);
      for (const m of text.matchAll(/\benv\.([A-Z_][A-Z0-9_]*)/g)) names.add(m[1]);
      // Any other use of process.env (a computed key, a spread, the whole
      // object passed on) hides which names are read.
      for (const m of text.matchAll(/process\.env(?!\.[A-Za-z_]|\[\s*['"])/g)) bare.push(`${rel(file)}: ${text.slice(m.index, m.index + 24)}`);
    }
    expect(bare).toEqual([]);
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
