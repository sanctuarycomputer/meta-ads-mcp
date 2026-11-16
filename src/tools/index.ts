import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { toolFilter } from "./_register.js";
import { registerAccountTools } from "./accounts.js";
import { registerCampaignTools } from "./campaigns.js";
import { registerAdSetTools } from "./adsets.js";
import { registerAdTools } from "./ads.js";
import { registerCreativeTools } from "./creatives.js";
import { registerCreativeMediaTools } from "./creative-media.js";
import { registerVideoMediaTools } from "./video-media.js";
import { registerVideoAnalysisTools } from "./video-analysis.js";
import { registerAdDossierTools } from "./ad-dossier.js";
import { registerGeminiKeyTools } from "./gemini-keys.js";
import { registerInsightsTools } from "./insights.js";
import { registerInsightsViewTools } from "./insights-views.js";
import { registerTargetingTools } from "./targeting.js";
import { registerBudgetTools } from "./budget.js";
import { registerLeadTools } from "./leads.js";
import { registerAudienceTools } from "./audiences.js";
import { registerPreviewTools } from "./previews.js";
import { registerPixelTools } from "./pixels.js";
import { registerCommentTools } from "./comments.js";
import { registerRuleTools } from "./rules.js";
import { registerABTestingTools } from "./abtesting.js";
import { registerReportTools } from "./reports.js";
import { registerBillingTools } from "./billing.js";
import { registerTokenTools } from "./tokens.js";
import { registerInstagramTools } from "./instagram.js";
import { registerAdsLibraryTools } from "./ads-library.js";
import { registerAdLibrarySearchTools } from "./ad-library-search.js";
import { registerActivityLogTools } from "./activity-logs.js";
import { registerRateStatusTools } from "./rate-status.js";
import { registerEntityTools } from "./entities.js";
import { registerFieldContextTools } from "./field-context.js";
import { registerDiagnosticTools } from "./diagnostics.js";
import { registerHelpTools } from "./help.js";
import { registerMacroTools } from "./macros.js";
import { registerBulkAdTools } from "./bulk-ads.js";
import { registerAdContentTools } from "./ad-content.js";
import { registerSocialProofTools } from "./social-proof.js";
import { registerBusinessAccessTools } from "./business-access.js";
import { registerWhatsAppTools } from "./whatsapp.js";
import { registerWhatsAppTemplateTools } from "./whatsapp-templates.js";
import { registerWhatsAppFlowTools } from "./whatsapp-flows.js";
import { registerWhatsAppConfigTools } from "./whatsapp-config.js";

/**
 * Register all Meta Ads tools on the MCP server.
 *
 * v3.0.0 alignment with Meta's official MCP vocabulary:
 *   - all tools prefixed `ads_*` (no more `meta_ads_*`)
 *   - `ad_set` (with underscore) replaces `adset`
 *   - all tools annotated with ToolAnnotations (readOnlyHint / destructiveHint)
 *   - 5 named insight views + diagnostic + help + agency macro-tools added
 */
export function registerAllTools(server: McpServer): void {
  // ─── Core Ad Management ─────────────────────────────────
  registerAccountTools(server);      // 5 tools (+ ads_get_ad_account_pages, ads_get_user_pages)
  registerCampaignTools(server);     // 5 tools
  registerAdSetTools(server);        // 6 tools
  registerAdTools(server);           // 6 tools
  registerCreativeTools(server);     // 10 tools (+ ads_get_creative_ads)
  registerCreativeMediaTools(server); // 1 tool — creative media as inline image blocks
  registerVideoMediaTools(server);   // 1 tool — ads_get_video_media (keyframes / inline MP4 / urls)
  registerVideoAnalysisTools(server); // 1 tool — ads_analyze_video (Gemini video understanding)
  registerAdDossierTools(server);    // 1 tool — ads_get_ad_dossier (everything about one ad in one call)
  registerEntityTools(server);       // 3 tools — generic helpers (get_ad_entities, update_entity, activate_entity)
  registerFieldContextTools(server); // 1 tool — ads_get_field_context (types, levels, filters, values; no Meta call)
  registerInsightsTools(server);     // 1 tool  — power-tool ads_get_insights
  registerInsightsViewTools(server); // 5 tools — semantic insight views
  registerTargetingTools(server);    // 8 tools (+ ads_search_locales)
  registerBudgetTools(server);       // 1 tool

  // ─── Extended Features ──────────────────────────────────
  registerLeadTools(server);         // 10 tools — Instant forms, leads, test leads, lead access
  registerAudienceTools(server);     // 11 tools — Custom & lookalike audiences (+ share/unshare/get-shared-accounts, update, customer-list users, ad sets using one)
  registerPreviewTools(server);      // 2 tools — Ad preview links
  registerPixelTools(server);        // 5 tools — Pixel & events manager
  registerCommentTools(server);      // 4 tools — Ad comment moderation
  registerRuleTools(server);         // 5 tools — Automated rules
  registerABTestingTools(server);    // 5 tools — A/B tests and lift studies (+ eligibility check, edit/cancel)
  registerReportTools(server);       // 4 tools — Async scheduled reports (+ run_and_wait)
  registerBillingTools(server);      // 4 tools — Billing, spend limits & invoices
  registerRateStatusTools(server);   // 1 tool — Rate-limit usage + circuit status
  registerBusinessAccessTools(server); // 4 tools — Business Manager members and their access to ad accounts, Pages, pixels

  // ─── Diagnostics & Help ─────────────────────────────────
  registerDiagnosticTools(server);   // 3 tools — opportunity_score, dataset_quality, errors
  registerHelpTools(server);         // 1 tool  — help_article search

  // ─── Agency Macros (cross-account) ──────────────────────
  registerMacroTools(server);        // 2 tools — diagnose_underperformance, portfolio_summary
  registerBulkAdTools(server);       // 1 tool  — ads_bulk_create_video_ads (upload → creative → ad)
  registerAdContentTools(server);    // 1 tool  — ads_update_ad_content (edit copy/link/media of live ads)
  registerSocialProofTools(server);  // 2 tools — ads_duplicate_ad (keeps the post) + ads_get_ad_social_proof

  // ─── Instagram ──────────────────────────────────────────
  registerInstagramTools(server);    // 3 tools — IG account & media lookup + ads_boost_ig_post

  // ─── WhatsApp Business ──────────────────────────────────
  registerWhatsAppTools(server);         // 8 tools — WABAs, phone numbers, business profile
  registerWhatsAppTemplateTools(server); // 6 tools — message templates + analytics
  registerWhatsAppFlowTools(server);     // 6 tools — WhatsApp Flows lifecycle
  registerWhatsAppConfigTools(server);   // 7 tools — QR deep links + webhook subscriptions

  // ─── Ad Library scraping (Apify) ─────────────────────────
  registerAdsLibraryTools(server);   // 9 tools — competitor ad research via Apify + token mgmt + ad details with media
  registerAdLibrarySearchTools(server); // 1 tool — ads_library_search (Meta's own Ad Library API, free)

  // ─── Account history ────────────────────────────────────
  registerActivityLogTools(server);  // 1 tool — ads_account_get_activity_logs

  // ─── Gemini video analysis ───────────────────────────────
  registerGeminiKeyTools(server);    // 3 tools — per-tenant Gemini key registration / status / delete

  // ─── Token Management ────────────────────────────────────
  registerTokenTools(server);        // 4 tools — list / set-active / register / delete

  // Total: 168 tools (79 renamed + 14 new in v3 + 3 audience-sharing + 1 invoices + 27 WhatsApp + 1 url-tags + 1 bulk video ads + 1 creative media + 9 Ad Library/Apify + 1 video media + 1 video analysis + 3 Gemini key mgmt + 1 ad dossier + 1 ad content editor + 2 social proof + 4 Business Manager access + 1 locale search + 7 official-parity tools + 2 experiment tools + 3 audience tools + 6 lead form tools)
}

// ─── Toolsets (ticket 252) ─────────────────────────────────
//
// META_ADS_TOOLSETS is a comma list of group names. `<group>` registers the
// group's read tools (annotated readOnlyHint: true); `<group>:write` registers
// the rest of it. Unset means DEFAULT_READ_TOOLSETS. Any name that is unknown,
// in a never or kept-out group, or would register nothing refuses to start, and
// so does META_ADS_READ_ONLY=1 with a `:write` name. Groups are named after
// their files in src/tools. The never groups are design §5.3's; the kept-out
// ones are the fork review's (scripts-248 §Groups, M10, M11, M17).

type GroupStatus = "allowed" | "never" | "kept-out";

interface ToolGroup {
  readonly register: (server: McpServer) => void;
  readonly status: GroupStatus;
}

export const TOOL_GROUPS: Readonly<Record<string, ToolGroup>> = Object.freeze({
  accounts: { register: registerAccountTools, status: "allowed" },
  campaigns: { register: registerCampaignTools, status: "allowed" },
  adsets: { register: registerAdSetTools, status: "allowed" },
  ads: { register: registerAdTools, status: "allowed" },
  creatives: { register: registerCreativeTools, status: "allowed" },
  insights: { register: registerInsightsTools, status: "allowed" },
  "insights-views": { register: registerInsightsViewTools, status: "allowed" },
  targeting: { register: registerTargetingTools, status: "allowed" },
  audiences: { register: registerAudienceTools, status: "allowed" },
  abtesting: { register: registerABTestingTools, status: "allowed" },
  pixels: { register: registerPixelTools, status: "allowed" },
  instagram: { register: registerInstagramTools, status: "allowed" },
  previews: { register: registerPreviewTools, status: "allowed" },
  diagnostics: { register: registerDiagnosticTools, status: "allowed" },
  reports: { register: registerReportTools, status: "allowed" },
  macros: { register: registerMacroTools, status: "allowed" },
  "activity-logs": { register: registerActivityLogTools, status: "allowed" },
  "field-context": { register: registerFieldContextTools, status: "allowed" },
  help: { register: registerHelpTools, status: "allowed" },
  "rate-status": { register: registerRateStatusTools, status: "allowed" },

  "video-analysis": { register: registerVideoAnalysisTools, status: "never" },
  "gemini-keys": { register: registerGeminiKeyTools, status: "never" },
  "ads-library": { register: registerAdsLibraryTools, status: "never" },
  "ad-library-search": { register: registerAdLibrarySearchTools, status: "never" },
  whatsapp: { register: registerWhatsAppTools, status: "never" },
  "whatsapp-templates": { register: registerWhatsAppTemplateTools, status: "never" },
  "whatsapp-flows": { register: registerWhatsAppFlowTools, status: "never" },
  "whatsapp-config": { register: registerWhatsAppConfigTools, status: "never" },
  comments: { register: registerCommentTools, status: "never" },
  leads: { register: registerLeadTools, status: "never" },
  rules: { register: registerRuleTools, status: "never" },
  tokens: { register: registerTokenTools, status: "never" },
  "business-access": { register: registerBusinessAccessTools, status: "never" },

  billing: { register: registerBillingTools, status: "kept-out" },
  budget: { register: registerBudgetTools, status: "kept-out" },
  "bulk-ads": { register: registerBulkAdTools, status: "kept-out" },
  "ad-content": { register: registerAdContentTools, status: "kept-out" },
  "social-proof": { register: registerSocialProofTools, status: "kept-out" },
  entities: { register: registerEntityTools, status: "kept-out" },
  "creative-media": { register: registerCreativeMediaTools, status: "kept-out" },
  "ad-dossier": { register: registerAdDossierTools, status: "kept-out" },
  "video-media": { register: registerVideoMediaTools, status: "kept-out" },
});

/**
 * Tools never registered from an allowed group, whatever the list says:
 * customer-list upload (design §5.3's never list), and the ad-set bundle
 * clone, which builds a Firestore client when called with a Firestore variable
 * set (scripts-248 M6) and sends its copies' status unforced (M13).
 */
export const EXCLUDED_TOOLS: ReadonlySet<string> = new Set([
  "ads_update_custom_audience_users",
  "ads_clone_ad_set_bundle",
]);

export const DEFAULT_READ_TOOLSETS: readonly string[] = Object.freeze([
  "accounts", "campaigns", "adsets", "ads", "creatives", "insights",
  "audiences", "abtesting", "pixels", "instagram", "diagnostics",
]);

type ToolClass = "read" | "write";

export interface ToolsetSelection {
  readonly groups: ReadonlyArray<{ readonly group: string; readonly cls: ToolClass }>;
}

export interface ToolsetProblem {
  readonly name: string;
  readonly reason: string;
}

export class ToolsetError extends Error {
  constructor(message: string, readonly problems: readonly ToolsetProblem[] = []) {
    super(message);
    this.name = "ToolsetError";
  }
}

const classOf = (annotations: ToolAnnotations | undefined): ToolClass =>
  annotations?.readOnlyHint === true ? "read" : "write";

const toolCounts = new Map<string, Record<ToolClass, number>>();

/** How many tools of each class a group would register, exclusions applied. */
function countTools(group: string): Record<ToolClass, number> {
  let counts = toolCounts.get(group);
  if (!counts) {
    const c = { read: 0, write: 0 };
    const counter = {
      registerTool: (name: string, config: { annotations?: ToolAnnotations }) => {
        if (!EXCLUDED_TOOLS.has(name)) c[classOf(config.annotations)]++;
      },
    };
    TOOL_GROUPS[group].register(counter as unknown as McpServer);
    counts = c;
    toolCounts.set(group, counts);
  }
  return counts;
}

function readOnlyMode(value: string | undefined): boolean {
  if (value === undefined || value === "") return false;
  if (value === "1") return true;
  throw new ToolsetError(
    `META_ADS_READ_ONLY must be unset, empty or 1; got ${JSON.stringify(value)}`,
  );
}

/** Reads META_ADS_TOOLSETS and META_ADS_READ_ONLY; throws a ToolsetError on any bad value. */
export function resolveToolsets(env: Readonly<Record<string, string | undefined>>): ToolsetSelection {
  const readOnly = readOnlyMode(env.META_ADS_READ_ONLY);
  const raw = env.META_ADS_TOOLSETS;
  let names: string[];
  if (raw === undefined) {
    names = [...DEFAULT_READ_TOOLSETS];
  } else {
    names = [...new Set(raw.split(",").map((n) => n.trim()).filter((n) => n !== ""))];
    if (names.length === 0) {
      throw new ToolsetError("META_ADS_TOOLSETS is set but empty; unset it for the read-only default");
    }
  }

  const problems: ToolsetProblem[] = [];
  const groups: Array<{ group: string; cls: ToolClass }> = [];
  for (const name of names) {
    const write = name.endsWith(":write");
    const group = write ? name.slice(0, -":write".length) : name;
    const cls: ToolClass = write ? "write" : "read";
    const entry = Object.hasOwn(TOOL_GROUPS, group) ? TOOL_GROUPS[group] : undefined;
    let reason: string | undefined;
    if (!entry) reason = "unknown";
    else if (entry.status === "never") reason = "never registered";
    else if (entry.status === "kept-out") reason = "kept out";
    else if (countTools(group)[cls] === 0) reason = "registers nothing";
    else if (write && readOnly) reason = "write name on a read-only server";
    if (reason) problems.push({ name, reason });
    else groups.push({ group, cls });
  }
  if (problems.length > 0) {
    const list = problems.map((p) => `${p.name} (${p.reason})`).join(", ");
    throw new ToolsetError(`META_ADS_TOOLSETS refused: ${list}`, problems);
  }
  return { groups };
}

/** Registers only the selected groups' tools of the selected class, exclusions applied. */
export function registerToolsets(server: McpServer, selection: ToolsetSelection): void {
  for (const { group } of selection.groups) {
    if (!Object.hasOwn(TOOL_GROUPS, group) || TOOL_GROUPS[group].status !== "allowed") {
      throw new ToolsetError(`not an allowed tool group: ${group}`, [{ name: group, reason: "not allowed" }]);
    }
  }
  for (const { group, cls } of selection.groups) {
    const filter = toolFilter(server, (name, annotations) =>
      !EXCLUDED_TOOLS.has(name) && classOf(annotations) === cls);
    TOOL_GROUPS[group].register(filter as unknown as McpServer);
  }
}
