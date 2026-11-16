/**
 * Never lists and read lists (ticket 252, spec check 2).
 *
 * 2.1: the never and kept-out groups are literals here, each tied to its
 *      register function imported straight from its file, and the tools
 *      excluded by name are a literal; the never tool names come from running
 *      those imported functions. The table in src/tools/index.ts can't vouch
 *      for itself.
 * 2.2: every read tool of every allowed group sends only GET, or
 *      POST /act_<n>/insights, shown three ways:
 *      - a runtime probe of each handler, with argument sets built from its
 *        schema and two stub answers;
 *      - a static check, on the TypeScript syntax tree, of each read tool's
 *        registerTool call and of everything in the same file it names
 *        (resolved by the type checker, so by scope, not by spelling),
 *        followed transitively;
 *      - the read tools' names, pinned.
 *      What this doesn't prove: a write reached only through a function in
 *      another module (other than the known write helpers), or only by a
 *      response shape or argument combination the probe doesn't build. The
 *      static check refuses any use of the client other than a member access
 *      on its imported name, so no alias hides a call. On the read server,
 *      253's client method allowlist (META_ADS_READ_ONLY=1) is the runtime
 *      backstop.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import ts from "typescript";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { TOOL_GROUPS, EXCLUDED_TOOLS, ToolsetError, resolveToolsets, registerToolsets } from "../../src/tools/index.js";
import { registerVideoAnalysisTools } from "../../src/tools/video-analysis.js";
import { registerGeminiKeyTools } from "../../src/tools/gemini-keys.js";
import { registerAdsLibraryTools } from "../../src/tools/ads-library.js";
import { registerAdLibrarySearchTools } from "../../src/tools/ad-library-search.js";
import { registerWhatsAppTools } from "../../src/tools/whatsapp.js";
import { registerWhatsAppTemplateTools } from "../../src/tools/whatsapp-templates.js";
import { registerWhatsAppFlowTools } from "../../src/tools/whatsapp-flows.js";
import { registerWhatsAppConfigTools } from "../../src/tools/whatsapp-config.js";
import { registerCommentTools } from "../../src/tools/comments.js";
import { registerLeadTools } from "../../src/tools/leads.js";
import { registerRuleTools } from "../../src/tools/rules.js";
import { registerTokenTools } from "../../src/tools/tokens.js";
import { registerBusinessAccessTools } from "../../src/tools/business-access.js";
import { registerBillingTools } from "../../src/tools/billing.js";
import { registerBudgetTools } from "../../src/tools/budget.js";
import { registerBulkAdTools } from "../../src/tools/bulk-ads.js";
import { registerAdContentTools } from "../../src/tools/ad-content.js";
import { registerSocialProofTools } from "../../src/tools/social-proof.js";
import { registerEntityTools } from "../../src/tools/entities.js";
import { registerCreativeMediaTools } from "../../src/tools/creative-media.js";
import { registerAdDossierTools } from "../../src/tools/ad-dossier.js";
import { registerVideoMediaTools } from "../../src/tools/video-media.js";
import { createMockMcpServer, setupTestToken, cleanupTestToken } from "../setup.js";

vi.mock("../../src/utils/url-guard.js", async (importOriginal) => {
  const real = await importOriginal<typeof import("../../src/utils/url-guard.js")>();
  return {
    ...real,
    assertSafePublicUrl: vi.fn(async () => undefined),
    resolveSafePublicUrl: vi.fn(async (url: string) => ({ url: new URL(url), address: "93.184.216.34", family: 4 })),
  };
});

const SRC = new URL("../../src/", import.meta.url);
const source = (rel: string) => readFileSync(new URL(rel, SRC), "utf8");

type Register = (server: McpServer) => void;

/** design §5.3's never list, as groups. */
const NEVER_GROUPS: Record<string, Register> = {
  "video-analysis": registerVideoAnalysisTools,
  "gemini-keys": registerGeminiKeyTools,
  "ads-library": registerAdsLibraryTools,
  "ad-library-search": registerAdLibrarySearchTools,
  whatsapp: registerWhatsAppTools,
  "whatsapp-templates": registerWhatsAppTemplateTools,
  "whatsapp-flows": registerWhatsAppFlowTools,
  "whatsapp-config": registerWhatsAppConfigTools,
  comments: registerCommentTools,
  leads: registerLeadTools,
  rules: registerRuleTools,
  tokens: registerTokenTools,
  "business-access": registerBusinessAccessTools,
};

/** The fork review's keep-outs (scripts-248 §Groups, M10, M11, M17). */
const KEPT_OUT_GROUPS: Record<string, Register> = {
  billing: registerBillingTools,
  budget: registerBudgetTools,
  "bulk-ads": registerBulkAdTools,
  "ad-content": registerAdContentTools,
  "social-proof": registerSocialProofTools,
  entities: registerEntityTools,
  "creative-media": registerCreativeMediaTools,
  "ad-dossier": registerAdDossierTools,
  "video-media": registerVideoMediaTools,
};

const ALLOWED_GROUPS = [
  "accounts", "campaigns", "adsets", "ads", "creatives", "insights", "insights-views",
  "targeting", "audiences", "abtesting", "pixels", "instagram", "previews", "diagnostics",
  "reports", "macros", "activity-logs", "field-context", "help", "rate-status",
];

/** Tools excluded by name from an allowed group (spec §Names). */
const EXCLUDED_BY_NAME = ["ads_update_custom_audience_users", "ads_clone_ad_set_bundle"];

/** Every read tool of every allowed group, pinned (spec check 2.2, third way). */
const ALLOWED_READ_TOOLS = [
  "ads_get_ad_accounts", "ads_get_account_info", "ads_get_pages_for_business", "ads_get_ad_account_pages",
  "ads_get_user_pages", "ads_get_campaigns", "ads_get_campaign_details", "ads_get_ad_sets",
  "ads_get_ad_set_details", "ads_get_ads", "ads_get_ad_details", "ads_get_ad_creatives",
  "ads_get_creative_details", "ads_get_ad_images", "ads_get_ad_videos", "ads_get_video_details",
  "ads_get_creative_ads", "ads_get_field_context", "ads_get_insights", "ads_insights_performance_trend",
  "ads_insights_anomaly_signal", "ads_insights_auction_ranking_benchmarks", "ads_insights_industry_benchmark",
  "ads_insights_advertiser_context", "ads_search_interests", "ads_get_interest_suggestions",
  "ads_search_behaviors", "ads_search_demographics", "ads_search_geo_locations", "ads_estimate_audience_size",
  "ads_get_targeting_description", "ads_search_locales", "ads_get_custom_audiences", "ads_get_audience_details",
  "ads_get_audience_shared_accounts", "ads_get_custom_audience_adsets", "ads_get_ad_preview",
  "ads_generate_preview", "ads_get_pixels", "ads_get_pixel_details", "ads_get_pixel_events",
  "ads_get_custom_conversions", "ads_get_ad_studies", "ads_get_study_details", "ads_experiment_check_eligibility",
  "ads_get_report_status", "ads_get_report_results", "ads_rate_status", "ads_get_opportunity_score",
  "ads_get_dataset_quality", "ads_get_errors", "ads_get_help_article", "ads_diagnose_underperformance",
  "ads_portfolio_summary", "ads_get_instagram_account", "ads_get_instagram_media", "ads_account_get_activity_logs",
].sort();

/** Read tools that make no Meta call (checked in their source: no metaApiClient request). */
const NO_META_CALL = ["ads_get_field_context", "ads_get_help_article", "ads_rate_status"];

type Registered = ReturnType<typeof createMockMcpServer>["_registeredTools"][number];

const registeredFor = (names: string): Registered[] => {
  const server = createMockMcpServer();
  registerToolsets(server as never, resolveToolsets({ META_ADS_TOOLSETS: names }));
  return server._registeredTools;
};

/** Every tool a never or kept-out group's own (imported) function registers. */
function refusedToolNames(): string[] {
  const names: string[] = [];
  for (const register of [...Object.values(NEVER_GROUPS), ...Object.values(KEPT_OUT_GROUPS)]) {
    const server = createMockMcpServer();
    register(server as never);
    names.push(...server._registeredTools.map((t) => t.name));
  }
  return names;
}

describe("never and kept-out lists (check 2.1)", () => {
  it("each never and kept-out literal is the table's function, with its status", () => {
    for (const [stem, fn] of Object.entries(NEVER_GROUPS)) {
      expect(TOOL_GROUPS[stem]?.register, stem).toBe(fn);
      expect(TOOL_GROUPS[stem].status, stem).toBe("never");
    }
    for (const [stem, fn] of Object.entries(KEPT_OUT_GROUPS)) {
      expect(TOOL_GROUPS[stem]?.register, stem).toBe(fn);
      expect(TOOL_GROUPS[stem].status, stem).toBe("kept-out");
    }
    for (const stem of ALLOWED_GROUPS) expect(TOOL_GROUPS[stem]?.status, stem).toBe("allowed");
  });

  it("the three literals together are exactly the table's keys", () => {
    const literal = [...Object.keys(NEVER_GROUPS), ...Object.keys(KEPT_OUT_GROUPS), ...ALLOWED_GROUPS].sort();
    expect(new Set(literal).size).toBe(literal.length);
    expect(Object.keys(TOOL_GROUPS).sort()).toEqual(literal);
  });

  it("the table covers every register function registerAllTools calls, each once", () => {
    const text = source("tools/index.ts");
    const start = text.indexOf("export function registerAllTools(");
    expect(start).toBeGreaterThan(-1);
    const open = text.indexOf("{", text.indexOf(")", start));
    let depth = 0;
    let end = open;
    for (; end < text.length; end++) {
      if (text[end] === "{") depth++;
      else if (text[end] === "}" && --depth === 0) break;
    }
    const body = text.slice(open, end + 1).replace(/\/\/.*$/gm, "");
    const called = [...body.matchAll(/\b(register\w+Tools)\(server\)/g)].map((m) => m[1]);
    expect(new Set(called).size).toBe(called.length);
    expect(called.sort()).toEqual(Object.values(TOOL_GROUPS).map((g) => g.register.name).sort());
  });

  it.each([...Object.keys(NEVER_GROUPS), ...Object.keys(KEPT_OUT_GROUPS)])("%s is refused, read and write", (stem) => {
    expect(() => resolveToolsets({ META_ADS_TOOLSETS: stem })).toThrow(stem);
    expect(() => resolveToolsets({ META_ADS_TOOLSETS: `${stem}:write` })).toThrow(`${stem}:write`);
  });

  it("every allowed group, read and write together, registers no refused or excluded tool", () => {
    const names = new Set<string>();
    for (const stem of ALLOWED_GROUPS) {
      for (const name of [stem, `${stem}:write`]) {
        let tools: Registered[] = [];
        try {
          tools = registeredFor(name);
        } catch (error) {
          // Only "registers nothing" is an expected refusal of an allowed group's name.
          if (!(error instanceof ToolsetError) || error.problems.some((p) => p.reason !== "registers nothing")) throw error;
        }
        for (const t of tools) names.add(t.name);
      }
    }
    const refused = [...refusedToolNames(), ...EXCLUDED_BY_NAME];
    expect(refused.length).toBeGreaterThan(80);
    for (const name of refused) expect(names.has(name), name).toBe(false);
  });

  it("the excluded-by-name literal is the code's", () => {
    expect([...EXCLUDED_TOOLS].sort()).toEqual([...EXCLUDED_BY_NAME].sort());
  });
});

// ─── 2.2: read tools send only GET or POST /act_<n>/insights ───────────────

function allowedReadTools(): Array<Registered & { group: string }> {
  const tools: Array<Registered & { group: string }> = [];
  for (const stem of ALLOWED_GROUPS) {
    // A stem missing from the table is reported by the key-equality test, not by a crash here.
    if (!Object.hasOwn(TOOL_GROUPS, stem)) continue;
    for (const t of registeredFor(stem)) tools.push({ ...t, group: stem });
  }
  return tools;
}

describe("read tools are pinned (check 2.2, names)", () => {
  it("the read tools across allowed groups are exactly the pinned list", () => {
    expect(allowedReadTools().map((t) => t.name).sort()).toEqual(ALLOWED_READ_TOOLS);
  });
});

// Argument values built from a zod 4 schema. Ids are fresh on every call, so
// no per-id cache or throttle in the fork (account currency, report polling)
// carries state from one call to the next.
type Def = { type: string; [k: string]: unknown };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;
const WRAPPERS = ["optional", "default", "nullable", "prefault", "readonly", "catch", "nonoptional"];

function sample(key: string): string {
  if (/account/.test(key)) return "act_100000000";
  if (/since|until|date|time_start|time_stop/.test(key)) return "2026-01-01";
  if (/url|link/.test(key)) return "https://example.com/a.png";
  return "100000000";
}

/** mode "required" leaves out optional and defaulted fields (so the schema's defaults apply); "all" fills every field. */
function build(s: z.ZodType, key: string, mode: "required" | "all"): unknown {
  const d = defOf(s);
  switch (d.type) {
    case "optional": case "default": case "prefault":
      return mode === "all" ? build(d.innerType as z.ZodType, key, mode) : undefined;
    case "nullable": case "readonly": case "catch": case "nonoptional":
      return build(d.innerType as z.ZodType, key, mode);
    case "pipe": return build(d.in as z.ZodType, key, mode);
    case "lazy": return build((d.getter as () => z.ZodType)(), key, mode);
    case "string": return sample(key);
    case "number": case "int": case "bigint": return 1;
    case "boolean": return false;
    case "enum": return Object.values(d.entries as Record<string, unknown>)[0];
    case "literal": return (d.values as unknown[])[0];
    case "array": return [build(d.element as z.ZodType, key, mode === "required" ? "all" : mode)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape as Record<string, z.ZodType>)) {
        const x = build(v, k, mode);
        if (x !== undefined) out[k] = x;
      }
      return out;
    }
    case "union": return build((d.options as z.ZodType[])[0], key, mode);
    case "record": return {};
    case "any": case "unknown": return "1";
    default: return undefined;
  }
}

function inner(s: z.ZodType): z.ZodType {
  let cur = s;
  for (;;) {
    const d = defOf(cur);
    if (WRAPPERS.includes(d.type)) cur = d.innerType as z.ZodType;
    else if (d.type === "pipe") cur = d.in as z.ZodType;
    else return cur;
  }
}

let seq = 0;
/** A copy of args with every sample id replaced by a fresh one. */
function freshen(value: unknown): unknown {
  if (typeof value === "string") {
    if (value === "100000000") return String(100000000 + ++seq);
    if (value === "act_100000000") return `act_${100000000 + ++seq}`;
    return value;
  }
  if (Array.isArray(value)) return value.map(freshen);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, freshen(v)]));
  return value;
}

type ArgSet = { label: string; args: Record<string, unknown> };

/** Starting sets: required only (defaults applied), every field, and required plus each other field alone. */
function starterSets(shape: Record<string, z.ZodType>): ArgSet[] {
  const obj = z.object(shape);
  const base = build(obj, "", "required") as Record<string, unknown>;
  const full = build(obj, "", "all") as Record<string, unknown>;
  const sets: ArgSet[] = [{ label: "required", args: base }, { label: "all", args: full }];
  for (const k of Object.keys(shape)) {
    if (!(k in base) && k in full) sets.push({ label: `+${k}`, args: { ...base, [k]: full[k] } });
  }
  return sets;
}

/** On top of a starting set: each enum value and each boolean, one field at a time. */
function variantsOf(shape: Record<string, z.ZodType>, start: ArgSet): ArgSet[] {
  const out: ArgSet[] = [];
  for (const [k, v] of Object.entries(shape)) {
    const d = defOf(inner(v));
    if (d.type === "enum") {
      for (const value of Object.values(d.entries as Record<string, unknown>)) out.push({ label: `${start.label} ${k}=${String(value)}`, args: { ...start.args, [k]: value } });
    } else if (d.type === "boolean") {
      for (const value of [true, false]) out.push({ label: `${start.label} ${k}=${value}`, args: { ...start.args, [k]: value } });
    }
  }
  return out;
}

const ALLOWED_REQUEST = /^(GET \/\S*|POST \/act_\d+\/insights)$/;

/** Any key named method or _method, any case, in a query string or a body. */
function overrideKey(params: Iterable<string>): boolean {
  for (const k of params) if (/^_?method$/i.test(k)) return true;
  return false;
}

function bodyKeys(body: unknown): string[] {
  if (body === undefined || body === null) return [];
  if (typeof body === "string") {
    try {
      return Object.keys(JSON.parse(body) as object);
    } catch {
      return [...new URLSearchParams(body).keys()];
    }
  }
  if (body instanceof URLSearchParams || body instanceof FormData) return [...body.keys()];
  return ["<opaque body>"];
}

describe("read tools send only GET or POST /act_<n>/insights (check 2.2, runtime probe)", () => {
  let requests: string[] = [];
  let populated = false;
  let served = 0;
  let cursorFollowed = false;

  beforeEach(() => {
    setupTestToken();
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const req = input instanceof Request ? input : undefined;
      const u = new URL(req ? req.url : String(input));
      const method = (init?.method ?? req?.method ?? "GET").toUpperCase();
      const path = u.pathname.replace(/^\/v[\d.]+/, "");
      const override = overrideKey(u.searchParams.keys()) || overrideKey(bodyKeys(init?.body));
      requests.push(override ? `OVERRIDE ${method} ${path}` : `${method} ${path}`);
      if (u.searchParams.get("after") === "c1") cursorFollowed = true;
      served++;
      const body = populated
        ? { id: "100000000", success: true, data: [{ id: "100000000", name: "n" }],
            paging: served === 1 ? { cursors: { after: "c1" }, next: `${u.origin}${u.pathname}?after=c1` } : {} }
        : { data: [] };
      return new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    }));
  });

  afterEach(() => {
    cleanupTestToken();
    vi.unstubAllGlobals();
  });

  it.each(allowedReadTools().map((t) => [t.name, t] as const))("%s", async (_name, tool) => {
    const shape = (tool.schema ?? {}) as Record<string, z.ZodType>;
    const obj = z.object(shape);
    const starters = starterSets(shape);
    expect(obj.safeParse(starters[0].args).success, "required arguments must pass the schema").toBe(true);
    expect(obj.safeParse(starters[1].args).success, "all-field arguments must pass the schema").toBe(true);

    const run = async (set: ArgSet, stub: boolean): Promise<string[]> => {
      const parsed = obj.safeParse(freshen(set.args));
      expect(parsed.success, `${tool.name} [${set.label}] arguments must pass the schema`).toBe(true);
      if (!parsed.success) return [];
      populated = stub;
      served = 0;
      requests = [];
      cursorFollowed = false;
      try {
        await tool.handler(parsed.data, {});
      } catch {
        // A refusal is fine; what was sent before it is checked below.
      }
      for (const r of requests) expect(r, `${tool.name} [${set.label}, ${stub ? "populated" : "empty"}]`).toMatch(ALLOWED_REQUEST);
      return requests;
    };

    // Starting sets under both answers; the ones that reach Meta are "live".
    const live: ArgSet[] = [];
    for (const set of starters) {
      const sent = await run(set, false);
      await run(set, true);
      if (sent.length > 0) live.push(set);
    }
    // Enum and boolean variants on every live starting set (or on all of them, if none is live).
    for (const start of live.length > 0 ? live : starters) {
      for (const set of variantsOf(shape, start)) {
        await run(set, false);
        await run(set, true);
      }
    }

    if (NO_META_CALL.includes(tool.name)) {
      expect(live, `${tool.name} is listed as making no Meta call`).toEqual([]);
    } else {
      // Some tools need one of several optional fields, so the required-only set
      // may stop before calling Meta; then another starting set must reach it.
      expect(live.length, `${tool.name} made no request under any starting set`).toBeGreaterThan(0);
    }
  }, 60_000);

  it.each(["ads_get_ad_account_pages", "ads_get_user_pages", "ads_get_ad_studies"])(
    "%s follows the populated answer's cursor to a second page, so later pages are probed too",
    async (name) => {
      const tool = allowedReadTools().find((t) => t.name === name);
      expect(tool).toBeDefined();
      const shape = (tool?.schema ?? {}) as Record<string, z.ZodType>;
      const args = z.object(shape).parse(freshen(starterSets(shape)[0].args));
      populated = true;
      served = 0;
      requests = [];
      cursorFollowed = false;
      await tool?.handler(args, {});
      expect(cursorFollowed, `${name} requests: ${requests.join(", ")}`).toBe(true);
    },
  );
});

// ─── 2.2, static: read tools' blocks call no client write method or write helper ───
// Parsed with the TypeScript compiler, so types, generics, regex and template
// literals, comments and multi-line expressions are read as the compiler reads them.

const WRITE_METHODS = new Set(["post", "postForm", "postMultipart", "delete", "execute"]);

function exportedFunctions(rel: string): string[] {
  return [...source(rel).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
}
const WRITE_HELPERS = new Set([...exportedFunctions("meta/post-edit.ts"), ...exportedFunctions("meta/creative-rebuild.ts")]);

const parse = (text: string) => ts.createSourceFile("f.ts", text, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);

function walk(node: ts.Node, visit: (n: ts.Node) => void): void {
  visit(node);
  ts.forEachChild(node, (c) => walk(c, visit));
}

const insideImport = (n: ts.Node): boolean => {
  for (let p: ts.Node | undefined = n; p; p = p.parent) if (ts.isImportDeclaration(p)) return true;
  return false;
};

/**
 * A write helper imported under another name, and every use of the client other than `metaApiClient.x` / `metaApiClient?.x` on
 * its imported name: renamed or namespace imports of it, casts, arguments,
 * destructuring, element access, shorthand properties. Any of these could carry
 * the client out of the static check's sight, so each is refused.
 */
function aliases(text: string): string[] {
  const sf = parse(text);
  const out: string[] = [];
  walk(sf, (n) => {
    if (ts.isImportSpecifier(n) && n.propertyName && n.propertyName.text !== n.name.text
      && (n.propertyName.text === "metaApiClient" || WRITE_HELPERS.has(n.propertyName.text))) {
      out.push(n.getText());
    } else if (ts.isNamespaceImport(n) && /meta\/client(\.js)?["']$/.test(n.parent.parent.moduleSpecifier.getText())) {
      out.push(n.getText());
    } else if (ts.isIdentifier(n) && n.text === "metaApiClient" && !insideImport(n)) {
      const p = n.parent;
      if (ts.isTypeQueryNode(p)) return; // typeof metaApiClient in a type: no value escapes
      if (!(ts.isPropertyAccessExpression(p) && p.expression === n)) out.push(p.getText().slice(0, 80));
    }
  });
  return out;
}

/** Client write calls and write-helper references inside a node (or, with deep false, at the node itself). */
function writesIn(node: ts.Node, deep = true): string[] {
  const out: string[] = [];
  const check = (n: ts.Node) => {
    if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression) && n.expression.text === "metaApiClient" && WRITE_METHODS.has(n.name.text)) {
      out.push(n.getText());
    } else if (ts.isIdentifier(n) && WRITE_HELPERS.has(n.text)) {
      out.push(n.text);
    }
  };
  if (deep) walk(node, check);
  else check(node);
  return out;
}

/** A file parsed into a one-file program, so the type checker resolves each name to its own declaration. */
type Analysed = { sf: ts.SourceFile; checker: ts.TypeChecker };
function analyse(text: string): Analysed {
  const file = "/probe.ts";
  const host = ts.createCompilerHost({});
  host.getSourceFile = (f, target) => (f === file ? ts.createSourceFile(f, text, target, true, ts.ScriptKind.TS) : undefined);
  host.fileExists = (f) => f === file;
  host.readFile = (f) => (f === file ? text : undefined);
  const program = ts.createProgram([file], { noResolve: true, noLib: true, types: [], target: ts.ScriptTarget.Latest }, host);
  return { sf: program.getSourceFile(file) as ts.SourceFile, checker: program.getTypeChecker() };
}

/** Each tool's registerTool(...) call in a file, by tool name. */
function blocks(sf: ts.SourceFile): Map<string, ts.Node> {
  const out = new Map<string, ts.Node>();
  walk(sf, (n) => {
    if (!ts.isCallExpression(n)) return;
    const callee = n.expression;
    const named = ts.isPropertyAccessExpression(callee) ? callee.name.text : ts.isIdentifier(callee) ? callee.text : "";
    const first = n.arguments[0];
    if (named === "registerTool" && first && ts.isStringLiteralLike(first)) out.set(first.text, n);
  });
  return out;
}

/** Strip parentheses, casts, `satisfies` and `!` around an expression. */
function bare(e: ts.Expression): ts.Expression {
  let cur = e;
  while (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isTypeAssertionExpression(cur)
    || ts.isSatisfiesExpression(cur) || ts.isNonNullExpression(cur)) cur = cur.expression;
  return cur;
}

const isFunctionValue = (e: ts.Expression | undefined): boolean => !!e && (ts.isArrowFunction(bare(e)) || ts.isFunctionExpression(bare(e)));

/** A member of an object literal or class whose value is a function: reached by its own name, not through its holder. */
const isFunctionMember = (m: ts.Node): boolean =>
  ts.isMethodDeclaration(m) || ts.isGetAccessorDeclaration(m) || ts.isSetAccessorDeclaration(m)
  || ((ts.isPropertyAssignment(m) || ts.isPropertyDeclaration(m)) && isFunctionValue(m.initializer));

/** Inside the left side of a destructuring assignment. */
const inDestructuringTarget = (n: ts.Node): boolean => {
  for (let c: ts.Node = n, p = n.parent; p; c = p, p = p.parent) {
    if (ts.isBinaryExpression(p)) return p.left === c && p.operatorToken.kind === ts.SyntaxKind.EqualsToken;
    if (!ts.isObjectLiteralExpression(p) && !ts.isArrayLiteralExpression(p) && !ts.isPropertyAssignment(p)
      && !ts.isShorthandPropertyAssignment(p) && !ts.isParenthesizedExpression(p)) return false;
  }
  return false;
};

/**
 * The member a name selects, if it is in a member position: `x.name`, or a key
 * of a destructuring (`const { name } = …`, `({ name: v } = …)`), so the member
 * is found by spelling in whatever object was destructured.
 */
function memberKey(n: ts.Identifier | ts.PrivateIdentifier): string | undefined {
  const p = n.parent;
  if (ts.isPropertyAccessExpression(p) && p.name === n) return n.text;
  if (ts.isBindingElement(p) && ts.isObjectBindingPattern(p.parent)) return nameOfKey(p.propertyName ?? p.name);
  if ((ts.isShorthandPropertyAssignment(p) && p.name === n) || (ts.isPropertyAssignment(p) && inDestructuringTarget(p))) {
    return inDestructuringTarget(p) ? nameOfKey(p.name) : undefined;
  }
  return undefined;
}
const nameOfKey = (k: ts.Node): string | undefined => (ts.isIdentifier(k) || ts.isStringLiteral(k) ? k.text : undefined);

/**
 * Writes in the node and in everything in the same file it names, followed
 * transitively:
 * - plain names (variables, parameters, functions, classes) by symbol, through
 *   the type checker, so a local never stands for an unrelated function of the
 *   same spelling: each name's declaration (for a destructured name, the whole
 *   declaration; for a for...of or for...in binding, also the iterated
 *   expression), the value a shorthand property stands for, and every assignment
 *   to it, including destructuring assignments and `??=` and the other
 *   assignment operators;
 * - member names (`x.h`, or a destructuring key), and names the checker can't resolve, also by
 *   spelling, as the approved check did: every function-valued declaration,
 *   property, method or accessor of that name anywhere in the file, and the
 *   value of every assignment to a property of that name (`holder.h = …`,
 *   `holder["h"] = …`, through casts), so a function put on an object by
 *   Object.assign, a placeholder filled later, or an override reached through a
 *   base type is found.
 * A holder reached by name (an object literal or class) is read without its
 * function-valued members, which are reached by their own names when used; so
 * a block calling helpers.r() is not charged with helpers.w(). Type annotations
 * are not read: a member named only in a type adds nothing.
 */
function reachableWrites(start: ts.Node, { sf, checker }: Analysed): string[] {
  const bySymbol = new Map<ts.Symbol, ts.Node[]>();
  const bySpelling = new Map<string, ts.Node[]>();
  const file = <K>(map: Map<K, ts.Node[]>, key: K | undefined, n: ts.Node) => {
    if (key !== undefined) map.set(key, [...(map.get(key) ?? []), n]);
  };
  const nameOf = (name: ts.Node | undefined) => (name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : undefined);

  walk(sf, (n) => {
    // Function-valued things, by spelling.
    if (ts.isFunctionDeclaration(n) || isFunctionMember(n)) file(bySpelling, nameOf((n as ts.NamedDeclaration).name), n);
    else if (ts.isVariableDeclaration(n) && isFunctionValue(n.initializer)) file(bySpelling, nameOf(n.name), n);
    // Assignments.
    if (!ts.isBinaryExpression(n)) return;
    const op = n.operatorToken.kind;
    if (op < ts.SyntaxKind.FirstAssignment || op > ts.SyntaxKind.LastAssignment) return;
    const left = bare(n.left);
    if (ts.isObjectLiteralExpression(left) || ts.isArrayLiteralExpression(left)) {
      // `({ a, b: c } = …)`, `[a] = …`: filed under every name bound on the left.
      walk(left, (m) => {
        if (ts.isShorthandPropertyAssignment(m)) file(bySymbol, checker.getShorthandAssignmentValueSymbol(m), n);
        else if (ts.isIdentifier(m) && !(ts.isPropertyAssignment(m.parent) && m.parent.name === m)) file(bySymbol, checker.getSymbolAtLocation(m), n);
      });
      return;
    }
    file(bySymbol, checker.getSymbolAtLocation(left), n);
    // `holder.h = v`, `holder["h"] = v`: the value, under the property's spelling.
    if (ts.isPropertyAccessExpression(left)) file(bySpelling, left.name.text, n.right);
    else if (ts.isElementAccessExpression(left) && ts.isStringLiteralLike(left.argumentExpression)) file(bySpelling, left.argumentExpression.text, n.right);
  });

  /** What to read for a declaration: the whole declaration around a binding pattern, and a loop binding's iterable. */
  const declared = (d: ts.Node): ts.Node[] => {
    let cur = d;
    while (ts.isBindingElement(cur) || ts.isObjectBindingPattern(cur) || ts.isArrayBindingPattern(cur)) cur = cur.parent;
    const loop = ts.isVariableDeclaration(cur) && ts.isVariableDeclarationList(cur.parent) ? cur.parent.parent : undefined;
    return loop && (ts.isForOfStatement(loop) || ts.isForInStatement(loop)) ? [cur, loop.expression] : [cur];
  };

  /** Walk a reached node: no type annotations, and (outside the block itself) no function-valued members of a holder. */
  const visit = (node: ts.Node, isStart: boolean, f: (n: ts.Node) => void): void => {
    const go = (n: ts.Node): void => {
      if (ts.isTypeNode(n)) return;
      if (!isStart && n !== node && isFunctionMember(n) && (ts.isObjectLiteralExpression(n.parent) || ts.isClassLike(n.parent))) return;
      f(n);
      ts.forEachChild(n, go);
    };
    go(node);
  };

  const out: string[] = [];
  const seenSymbols = new Set<ts.Symbol>();
  const seenSpellings = new Set<string>();
  const queue: Array<[string, ts.Node, boolean]> = [["(block)", start, true]];
  // Each symbol and spelling is followed once, so a declaration is queued at most once per name;
  // one inside the node being read is queued too, since a holder's function members are skipped there.
  const enqueue = (label: string, d: ts.Node) => {
    if (d.getSourceFile() === sf) queue.push([label, d, false]);
  };
  while (queue.length > 0) {
    const [label, node, isStart] = queue.shift() as [string, ts.Node, boolean];
    visit(node, isStart, (n) => {
      for (const w of writesIn(n, false)) out.push(`${label}: ${w}`);
      if (!ts.isIdentifier(n) && !ts.isPrivateIdentifier(n)) return;
      const syms = [checker.getSymbolAtLocation(n)];
      if (ts.isShorthandPropertyAssignment(n.parent) && n.parent.name === n) syms.push(checker.getShorthandAssignmentValueSymbol(n.parent));
      for (const sym of syms) {
        if (!sym || seenSymbols.has(sym)) continue;
        seenSymbols.add(sym);
        for (const d of (sym.declarations ?? []).flatMap(declared)) enqueue(sym.name, d);
        for (const d of bySymbol.get(sym) ?? []) enqueue(sym.name, d);
      }
      // Spelling for member names and unresolved names only, so a plain local that
      // shares a name with an unrelated function elsewhere doesn't pull that function in.
      const key = memberKey(n) ?? (syms[0] ? undefined : n.text);
      if (key !== undefined && !seenSpellings.has(key)) {
        seenSpellings.add(key);
        for (const d of bySpelling.get(key) ?? []) enqueue(key, d);
      }
    });
  }
  return out;
}

describe("read tools' blocks call no client write method or write helper (check 2.2, static)", () => {
  const readByGroup = new Map<string, string[]>();
  for (const t of allowedReadTools()) readByGroup.set(t.group, [...(readByGroup.get(t.group) ?? []), t.name]);

  it.each(ALLOWED_GROUPS)("%s", (stem) => {
    const text = source(`tools/${stem}.ts`);
    expect(aliases(text), `${stem}: metaApiClient used other than by member access on its own name`).toEqual([]);
    const analysed = analyse(text);
    const byName = blocks(analysed.sf);
    for (const name of readByGroup.get(stem) ?? []) {
      const block = byName.get(name);
      expect(block, `${name}: no registerTool call found in tools/${stem}.ts`).toBeDefined();
      if (!block) continue;
      expect(reachableWrites(block, analysed), `${name}: writes reachable from its registration`).toEqual([]);
    }
  });
});

describe("the static check's parser", () => {
  const writes = (text: string, name = "t") => {
    const analysed = analyse(text);
    const block = blocks(analysed.sf).get(name);
    expect(block).toBeDefined();
    return reachableWrites(block as ts.Node, analysed);
  };
  const reg = (body: string) => `server.registerTool("t", { annotations: {} }, async (a: { id: string }) => { ${body} });\n`;
  const W = "await metaApiClient.postForm('/x', {});";

  it.each([
    ["a typed object return", `async function h(): Promise<{ a: string }> { const f = () => 1; ${W} return { a: "" }; }\n${reg("await h();")}`],
    ["an object-typed parameter", `function h(o: { a: string }) { ${W} }\n${reg("h({ a: '' });")}`],
    ["a generic arrow", `const h = async <T,>(x: T): Promise<T> => { ${W} return x; };\n${reg("await h(1);")}`],
    ["a multi-line expression body", `const h = (x: number) =>\n  x > 0 &&\n  metaApiClient.postForm('/x', {});\n${reg("h(1);")}`],
    ["an arrow-valued property", `const helpers = { h: async () => { ${W} } };\n${reg("await helpers.h();")}`],
    ["a method", `const helpers = { async h() { ${W} } };\n${reg("await helpers.h();")}`],
    ["a helper passed by reference", `async function h() { ${W} }\n${reg("await Promise.resolve().then(h);")}`],
    ["two helpers deep", `async function h2() { ${W} }\nasync function h() { await h2(); }\n${reg("await h();")}`],
    ["after a template literal with column-0 lines", reg("const s = `\n}\nconst x = ${'{'}`;\n" + W)],
    ["after a regex literal holding a quote", reg(`const m = /src="([^"]+)"/.exec(a.id);\n${W}`)],
    ["through optional chaining", reg("await metaApiClient?.postForm('/x', {});")],
    ["a helper wrapped in a call", `const h = Object.assign(async () => { ${W} }, {});\n${reg("await h();")}`],
    ["a helper held in an array", `const hs = [async () => { ${W} }];\n${reg("await hs[0]();")}`],
    ["a class constructor", `class C { constructor() { void metaApiClient.postForm('/x', {}); } }\n${reg("new C();")}`],
    ["a helper assigned after its declaration", `let h: () => Promise<unknown>;\nh = async () => { ${W} };\n${reg("await h();")}`],
    ["a getter", `const o = { get h() { return metaApiClient.postForm('/x', {}); } };\n${reg("await o.h;")}`],
    ["a helper reached through a shorthand property", `const sneak = async () => { ${W} };\nconst o = { sneak };\n${reg("await o.sneak();")}`],
    ["a helper bound by destructuring", `const { sneak } = { sneak: async () => { ${W} } };\n${reg("await sneak();")}`],
    ["a helper bound by array destructuring", `const [sneak] = [async () => { ${W} }];\n${reg("await sneak();")}`],
    ["a helper set by ??=", `let h: (() => Promise<unknown>) | undefined;\nh ??= async () => { ${W} };\n${reg("await h?.();")}`],
    ["a helper set by destructuring assignment", `let sneak: any;\n({ sneak } = { sneak: async () => { ${W} } });\n${reg("await sneak();")}`],
    ["a helper set by renamed destructuring assignment", `let s: any;\n({ sneak: s } = { sneak: async () => { ${W} } });\n${reg("await s();")}`],
    ["a helper set by array destructuring assignment", `let s: any;\n[s] = [async () => { ${W} }];\n${reg("await s();")}`],
    ["a for...of binding around the registration", `for (const { h } of [{ h: async () => { ${W} } }]) {\n${reg("await h();")}}\n`],
    ["a plain for...of binding around the registration", `for (const h of [async () => { ${W} }]) {\n${reg("await h();")}}\n`],
    ["a helper put on a holder by Object.assign", `const box: any = {};\nObject.assign(box, { sneak: async () => { ${W} } });\n${reg("await box.sneak();")}`],
    ["a helper set through a cast", `const box = {};\n(box as any).sneak = async () => { ${W} };\n${reg("await (box as any).sneak();")}`],
    ["a helper set through a non-null holder", `const box: { h?: () => Promise<unknown> } | undefined = {};\nbox!.h = async () => { ${W} };\n${reg("await box!.h?.();")}`],
    ["a helper set on an any-typed holder", `const holder: any = {};\nholder.h = async () => { ${W} };\n${reg("await holder.h();")}`],
    ["a helper named like a register function", `async function registerSneakTools() { ${W} }\n${reg("await registerSneakTools();")}`],
  ])("finds a write in %s", (_label, text) => {
    expect(writes(text)).not.toEqual([]);
  });

  it("does not charge a block that reads one property of a holder with writes stored under another", () => {
    const text = `const memo: any = {};\nexport async function other() { memo.w = await metaApiClient.postForm('/x', {}); }\n${reg("void memo.v;")}`;
    expect(writes(text)).toEqual([]);
  });

  it("does not pull in a writing function elsewhere because a local shares its name", () => {
    const text = `export async function sneak() { return metaApiClient.postForm('/x', {}); }\n${reg("const sneak = 1; void sneak;")}`;
    expect(writes(text)).toEqual([]);
  });

  it.each([
    ["a placeholder property filled by Object.assign", `const box = { sneak: undefined as any };\nObject.assign(box, { sneak: async () => { ${W} } });\n${reg("await box.sneak();")}`],
    ["a class field filled by Object.assign", `class Box { sneak!: () => Promise<unknown>; }\nconst box = new Box();\nObject.assign(box, { sneak: async () => { ${W} } });\n${reg("await box.sneak();")}`],
    ["an override reached through a base type", `class Base { async sneak(): Promise<unknown> { return 1; } }\nclass Impl extends Base { async sneak() { return metaApiClient.postForm('/x', {}); } }\nlet cur: Base = new Base();\nfunction use(b: Base) { cur = b; }\nuse(new Impl());\n${reg("await cur.sneak();")}`],
    ["a named function stored on a typed holder", `async function sneak() { ${W} }\nconst holder: { h?: () => Promise<unknown> } = {};\nholder.h = sneak;\n${reg("await holder.h?.();")}`],
    ["a wrapped function stored on a holder", `const holder: { h?: unknown } = {};\nholder.h = Object.assign(async () => { ${W} }, {});\n${reg("void holder.h;")}`],
    ["a function stored by string key", `const holder: Record<string, () => Promise<unknown>> = {};\nholder["h"] = async () => { ${W} };\n${reg("await holder.h();")}`],
    ["a function stored through a cast on the left", `let s: any;\n(s as any) = async () => { ${W} };\n${reg("await s();")}`],
  ])("finds a write through %s", (_label, text) => {
    expect(writes(text)).not.toEqual([]);
  });

  it.each([
    ["a typed holder with the write stored under another member", `const memo: { v?: number; w?: unknown } = {};\nexport async function other() { memo.w = await metaApiClient.postForm('/x', {}); }\n${reg("void memo.v;")}`],
    ["a helper object whose other method writes", `const helpers = { async r() { return 1; }, async w() { ${W} } };\n${reg("await helpers.r();")}`],
    ["a helper class whose other method writes", `class Helpers { async r() { return 1; } async w() { ${W} } }\nconst helpers = new Helpers();\n${reg("await helpers.r();")}`],
    ["a member named only in a type", `interface T { w: () => void }\nexport async function w() { ${W} }\n${reg("const t: T | undefined = undefined; void t;")}`],
  ])("charges nothing for %s", (_label, text) => {
    expect(writes(text)).toEqual([]);
  });

  it("finds a function reached through a property typed only by an interface", () => {
    const text = `interface Box { h: () => Promise<unknown> }\nfunction make(): Box { return { h: async () => { ${W} } }; }\nconst box = make();\n${reg("await box.h();")}`;
    expect(writes(text)).not.toEqual([]);
  });

  it("follows a name to its own declaration, not to another of the same spelling", () => {
    const text = `function other() { const result = metaApiClient.postForm('/x', {}); return result; }\n${reg("const result = 1; return result;")}`;
    expect(writes(text)).toEqual([]);
  });

  it("reads a block to its end and no further, past regex and template literals", () => {
    const text = `${reg("const m = /\"/.test(a.id); const s = `}`;")}server.registerTool("w", {}, async () => { ${W} });\n`;
    expect(writes(text, "t")).toEqual([]);
    expect(writes(text, "w")).not.toEqual([]);
  });

  it.each([
    ["a cast", "const api = metaApiClient as typeof metaApiClient;"],
    ["an argument", "use(metaApiClient);"],
    ["destructuring", "const { postForm } = metaApiClient;"],
    ["element access", "metaApiClient['postForm']('/x', {});"],
    ["a renamed import", "import { metaApiClient as api } from \"../meta/client.js\";"],
    ["a namespace import", "import * as client from \"../meta/client.js\";"],
    ["a renamed import of a write helper", `import { ${[...WRITE_HELPERS][0]} as h } from "../meta/post-edit.js";`],
  ])("refuses %s of the client", (_label, text) => {
    expect(aliases(text)).not.toEqual([]);
  });

  it("allows member access on the imported name, and the client's type", () => {
    expect(aliases("import { metaApiClient } from \"../meta/client.js\";\nmetaApiClient.get('/a');\nmetaApiClient?.get('/b');\ntype C = typeof metaApiClient;")).toEqual([]);
  });
});
