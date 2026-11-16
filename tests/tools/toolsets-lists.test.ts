/**
 * Never lists and read lists (ticket 252, spec check 2).
 *
 * 2.1: the never and kept-out groups, and the tools excluded by name, are
 *      literals here, not read from TOOL_GROUPS, so the table can't vouch for
 *      itself.
 * 2.2: every read tool of every allowed group sends only GET, or
 *      POST /act_<n>/insights, shown three ways: a runtime probe of each
 *      handler, a static check of each read block's source, and the read
 *      tools' names pinned. What this doesn't prove: a write behind a module
 *      in another file, reached only by a response shape or argument
 *      combination neither probe builds. On the read server, 253's client
 *      method allowlist (META_ADS_READ_ONLY=1) is the runtime backstop.
 */
import { readFileSync } from "node:fs";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { z } from "zod";
import { TOOL_GROUPS, EXCLUDED_TOOLS, resolveToolsets, registerToolsets } from "../../src/tools/index.js";
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

/** design §5.3's never list, as groups: stem -> register function. */
const NEVER_GROUPS: Record<string, string> = {
  "video-analysis": "registerVideoAnalysisTools",
  "gemini-keys": "registerGeminiKeyTools",
  "ads-library": "registerAdsLibraryTools",
  "ad-library-search": "registerAdLibrarySearchTools",
  whatsapp: "registerWhatsAppTools",
  "whatsapp-templates": "registerWhatsAppTemplateTools",
  "whatsapp-flows": "registerWhatsAppFlowTools",
  "whatsapp-config": "registerWhatsAppConfigTools",
  comments: "registerCommentTools",
  leads: "registerLeadTools",
  rules: "registerRuleTools",
  tokens: "registerTokenTools",
  "business-access": "registerBusinessAccessTools",
};

/** The fork review's keep-outs (scripts-248 §Groups, M10, M11, M17). */
const KEPT_OUT_GROUPS: Record<string, string> = {
  billing: "registerBillingTools",
  budget: "registerBudgetTools",
  "bulk-ads": "registerBulkAdTools",
  "ad-content": "registerAdContentTools",
  "social-proof": "registerSocialProofTools",
  entities: "registerEntityTools",
  "creative-media": "registerCreativeMediaTools",
  "ad-dossier": "registerAdDossierTools",
  "video-media": "registerVideoMediaTools",
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

const allNames = (groups: string) => {
  const server = createMockMcpServer();
  registerToolsets(server as never, resolveToolsets({ META_ADS_TOOLSETS: groups }));
  return server._registeredTools;
};

/** Every tool a never or kept-out group's own function registers. */
function refusedToolNames(): string[] {
  const names: string[] = [];
  for (const stem of [...Object.keys(NEVER_GROUPS), ...Object.keys(KEPT_OUT_GROUPS)]) {
    const server = createMockMcpServer();
    TOOL_GROUPS[stem].register(server as never);
    names.push(...server._registeredTools.map((t) => t.name));
  }
  return names;
}

describe("never and kept-out lists (check 2.1)", () => {
  it("each never and kept-out literal matches the table's function and status", () => {
    for (const [stem, fn] of Object.entries(NEVER_GROUPS)) {
      expect(TOOL_GROUPS[stem]?.register.name, stem).toBe(fn);
      expect(TOOL_GROUPS[stem].status, stem).toBe("never");
    }
    for (const [stem, fn] of Object.entries(KEPT_OUT_GROUPS)) {
      expect(TOOL_GROUPS[stem]?.register.name, stem).toBe(fn);
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
        try {
          for (const t of allNames(name)) names.add(t.name);
        } catch {
          // a name that registers nothing is refused; nothing to collect
        }
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

function allowedReadTools() {
  const tools: Array<ReturnType<typeof createMockMcpServer>["_registeredTools"][number] & { group: string }> = [];
  for (const stem of ALLOWED_GROUPS) {
    // A stem missing from the table is reported by the key-equality test, not by a crash here.
    if (!Object.hasOwn(TOOL_GROUPS, stem)) continue;
    for (const t of allNames(stem)) tools.push({ ...t, group: stem });
  }
  return tools;
}

describe("read tools are pinned (check 2.2, names)", () => {
  it("the read tools across allowed groups are exactly the pinned list", () => {
    expect(allowedReadTools().map((t) => t.name).sort()).toEqual(ALLOWED_READ_TOOLS);
  });
});

/** Argument values built from a zod 4 schema. */
type Def = { type: string; [k: string]: unknown };
const defOf = (s: z.ZodType): Def => (s as unknown as { _zod: { def: Def } })._zod.def;

function sample(key: string): string {
  if (/account/.test(key)) return "act_1234567890";
  if (/since|until|date|time_start|time_stop/.test(key)) return "2026-01-01";
  if (/url|link/.test(key)) return "https://example.com/a.png";
  return "1234567890";
}

function build(s: z.ZodType, key: string, all: boolean): unknown {
  const d = defOf(s);
  switch (d.type) {
    case "optional":
      return all ? build(d.innerType as z.ZodType, key, all) : undefined;
    case "default": case "nullable": case "prefault": case "readonly": case "catch": case "nonoptional":
      return build(d.innerType as z.ZodType, key, all);
    case "pipe": return build(d.in as z.ZodType, key, all);
    case "lazy": return build((d.getter as () => z.ZodType)(), key, all);
    case "string": return sample(key);
    case "number": case "int": case "bigint": return 1;
    case "boolean": return false;
    case "enum": return Object.values(d.entries as Record<string, unknown>)[0];
    case "literal": return (d.values as unknown[])[0];
    case "array": return [build(d.element as z.ZodType, key, all)];
    case "object": {
      const out: Record<string, unknown> = {};
      for (const [k, v] of Object.entries(d.shape as Record<string, z.ZodType>)) {
        const x = build(v, k, all);
        if (x !== undefined) out[k] = x;
      }
      return out;
    }
    case "union": return build((d.options as z.ZodType[])[0], key, all);
    case "record": return {};
    case "any": case "unknown": return "1";
    default: return undefined;
  }
}

/** Unwraps to the field's inner type, for variants. */
function inner(s: z.ZodType): z.ZodType {
  let cur = s;
  for (;;) {
    const d = defOf(cur);
    if (["optional", "default", "nullable", "prefault", "readonly", "catch", "nonoptional"].includes(d.type)) cur = d.innerType as z.ZodType;
    else if (d.type === "pipe") cur = d.in as z.ZodType;
    else return cur;
  }
}

/** Argument sets: required only, every field, required plus each optional field alone, then one variant per enum value and per boolean, per field. */
function argumentSets(shape: Record<string, z.ZodType>): Array<{ label: string; args: Record<string, unknown> }> {
  const obj = z.object(shape);
  const base = build(obj, "", false) as Record<string, unknown>;
  const full = build(obj, "", true) as Record<string, unknown>;
  const sets = [{ label: "required", args: base }, { label: "all", args: full }];
  // required fields plus one optional field at a time, for tools whose optional fields exclude each other
  for (const k of Object.keys(shape)) {
    if (!(k in base) && k in full) sets.push({ label: `+${k}`, args: { ...base, [k]: full[k] } });
  }
  for (const [k, v] of Object.entries(shape)) {
    const d = defOf(inner(v));
    if (d.type === "enum") {
      for (const value of Object.values(d.entries as Record<string, unknown>)) sets.push({ label: `${k}=${String(value)}`, args: { ...full, [k]: value } });
    } else if (d.type === "boolean") {
      sets.push({ label: `${k}=true`, args: { ...full, [k]: true } }, { label: `${k}=false`, args: { ...full, [k]: false } });
    }
  }
  return sets;
}

const ALLOWED_REQUEST = /^(GET \/.*|POST \/act_\d+\/insights)$/;

describe("read tools send only GET or POST /act_<n>/insights (check 2.2, runtime probe)", () => {
  let requests: string[] = [];
  let populated = false;
  let served = 0;

  beforeEach(() => {
    setupTestToken();
    requests = [];
    vi.stubGlobal("fetch", vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = new URL(String(url));
      requests.push(`${init?.method ?? "GET"} ${u.pathname.replace(/^\/v[\d.]+/, "")}`);
      served++;
      const body = populated
        ? { id: "1234567890", success: true, data: [{ id: "1234567890", name: "n" }],
            paging: served === 1 ? { next: `${u.origin}${u.pathname}?after=x` } : {} }
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
    const sets = argumentSets(shape);
    expect(z.object(shape).safeParse(sets[0].args).success, "required arguments must pass the schema").toBe(true);
    expect(z.object(shape).safeParse(sets[1].args).success, "all-field arguments must pass the schema").toBe(true);
    const silent: string[] = [];
    let anyRequest = false;
    for (const stub of [false, true]) {
      for (const { label, args } of sets) {
        populated = stub;
        served = 0;
        requests = [];
        const parsed = z.object(shape).safeParse(args);
        if (!parsed.success) continue; // only the base set is required to build; variants that don't parse are skipped
        let result: unknown;
        let thrown: unknown;
        try {
          result = await tool.handler(parsed.data, {});
        } catch (error) {
          thrown = error;
        }
        for (const r of requests) expect(r, `${tool.name} [${label}, ${stub ? "populated" : "empty"}]`).toMatch(ALLOWED_REQUEST);
        if (requests.length > 0) anyRequest = true;
        else silent.push(`[${label}] ${String(thrown ?? JSON.stringify(result)).slice(0, 160)}`);
      }
    }
    // Some tools need one of several optional fields, so the required-only set
    // may stop before calling Meta; the all-field set and the variants reach it.
    // Every tool that calls Meta at all must be seen calling it here.
    if (!NO_META_CALL.includes(tool.name)) {
      expect(anyRequest, `${tool.name} made no request under any argument set: ${silent.slice(0, 3).join(" | ")}`).toBe(true);
    } else {
      expect(anyRequest, `${tool.name} is listed as making no Meta call`).toBe(false);
    }
  }, 20_000);
});

// ─── 2.2, static: read blocks call no client write method or write helper ───

const WRITE_CALL = /metaApiClient\s*\.\s*(post|postForm|postMultipart|delete|execute)\b/;

function helperExports(rel: string): string[] {
  return [...source(rel).matchAll(/^export (?:async )?function (\w+)/gm)].map((m) => m[1]);
}
const WRITE_HELPERS = [...helperExports("meta/post-edit.ts"), ...helperExports("meta/creative-rebuild.ts")];

/** Module-level functions in a file (outside any block), name -> body text. */
function moduleFunctions(text: string): Map<string, string> {
  const out = new Map<string, string>();
  const starts = [...text.matchAll(/^(?:export )?(?:async )?function (\w+)|^(?:export )?const (\w+)\s*=\s*(?:async\s*)?(?:\([^)]*\)|\w+)\s*(?::[^=]+)?=>/gm)];
  for (let i = 0; i < starts.length; i++) {
    const name = starts[i][1] ?? starts[i][2];
    if (/^register\w*Tools$/.test(name)) continue;
    const end = i + 1 < starts.length ? starts[i + 1].index : text.length;
    out.set(name, text.slice(starts[i].index, end));
  }
  return out;
}

describe("read blocks call no client write method or write helper (check 2.2, static)", () => {
  it.each(ALLOWED_GROUPS)("%s", (stem) => {
    const text = source(`tools/${stem}.ts`);
    const helpers = moduleFunctions(text);
    // each block ends where the register function does (a "}" at column 0)
    const parts = text.split(/server\.registerTool\(/).slice(1).map((b) => b.split(/\n\}/)[0]);
    expect(parts.length).toBeGreaterThan(0);
    for (const block of parts) {
      const name = /^\s*["'`](\w+)["'`]/.exec(block)?.[1] ?? "?";
      if (!/annotations:\s*\{\s*\.\.\.READ\b/.test(block)) continue;
      expect(block, `${name}: client write call in a read block`).not.toMatch(WRITE_CALL);
      for (const h of WRITE_HELPERS) expect(new RegExp(`\\b${h}\\s*\\(`).test(block), `${name} calls write helper ${h}`).toBe(false);
      for (const [h, body] of helpers) {
        if (!new RegExp(`\\b${h}\\s*\\(`).test(block)) continue;
        expect(body, `${name} calls ${h}, which makes a client write call`).not.toMatch(WRITE_CALL);
      }
    }
  });
});
