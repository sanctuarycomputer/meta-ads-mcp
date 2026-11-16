/**
 * META_ADS_TOOLSETS: which tool groups a server registers (ticket 252,
 * spec checks 1.1 and 1.3-1.6; check 1.2, the refusals through src/index.ts,
 * is at the end of this file).
 */
import { describe, it, expect } from "vitest";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import {
  TOOL_GROUPS,
  ToolsetError,
  resolveToolsets,
  registerToolsets,
} from "../../src/tools/index.js";
import { toolFilter } from "../../src/tools/_register.js";
import { createMockMcpServer } from "../setup.js";

/** The read tools the unset default registers, pinned (spec check 1.3). */
const DEFAULT_READ_TOOLS = [
  "ads_get_ad_accounts", "ads_get_account_info", "ads_get_pages_for_business",
  "ads_get_ad_account_pages", "ads_get_user_pages",
  "ads_get_campaigns", "ads_get_campaign_details",
  "ads_get_ad_sets", "ads_get_ad_set_details",
  "ads_get_ads", "ads_get_ad_details",
  "ads_get_ad_creatives", "ads_get_creative_details", "ads_get_ad_images",
  "ads_get_ad_videos", "ads_get_video_details", "ads_get_creative_ads",
  "ads_get_insights",
  "ads_get_custom_audiences", "ads_get_audience_details",
  "ads_get_audience_shared_accounts", "ads_get_custom_audience_adsets",
  "ads_get_ad_studies", "ads_get_study_details", "ads_experiment_check_eligibility",
  "ads_get_pixels", "ads_get_pixel_details", "ads_get_pixel_events", "ads_get_custom_conversions",
  "ads_get_instagram_account", "ads_get_instagram_media",
  "ads_get_opportunity_score", "ads_get_dataset_quality", "ads_get_errors",
].sort();

/** The write server's list (spec §Size) and exactly what it registers (spec check 1.1). */
const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";
const WRITE_LIST_TOOLS = [
  "ads_create_campaign", "ads_update_campaign", "ads_delete_campaign",
  "ads_create_ad_set", "ads_update_ad_set", "ads_delete_ad_set",
  "ads_create_ad", "ads_update_ad", "ads_update_ad_url_tags", "ads_delete_ad",
  "ads_create_ad_creative", "ads_update_ad_creative", "ads_upload_ad_image", "ads_upload_ad_video",
  "ads_create_ad_study", "ads_experiment_abtest_update_test",
].sort();

function registered(env: Record<string, string | undefined>): string[] {
  const server = createMockMcpServer();
  registerToolsets(server as never, resolveToolsets(env));
  return server._registeredTools.map((t) => t.name).sort();
}

/** One group's tools, by class, straight from its own register function. */
function groupTools(group: string): { read: string[]; write: string[] } {
  const server = createMockMcpServer();
  TOOL_GROUPS[group].register(server as never);
  const read: string[] = [];
  const write: string[] = [];
  for (const t of server._registeredTools) (t.annotations?.readOnlyHint === true ? read : write).push(t.name);
  return { read: read.sort(), write: write.sort() };
}

function refusal(env: Record<string, string | undefined>): ToolsetError {
  try {
    resolveToolsets(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ToolsetError);
    return error as ToolsetError;
  }
  throw new Error(`expected ${JSON.stringify(env)} to be refused`);
}

describe("resolveToolsets and registerToolsets (check 1.1)", () => {
  it("a read name registers exactly that group's read tools", () => {
    expect(registered({ META_ADS_TOOLSETS: "campaigns" })).toEqual(groupTools("campaigns").read);
    expect(registered({ META_ADS_TOOLSETS: "campaigns" })).toEqual(["ads_get_campaign_details", "ads_get_campaigns"]);
  });

  it("a :write name registers exactly that group's write tools", () => {
    expect(registered({ META_ADS_TOOLSETS: "ads:write" })).toEqual(groupTools("ads").write);
    expect(registered({ META_ADS_TOOLSETS: "ads:write" })).toEqual(
      ["ads_create_ad", "ads_delete_ad", "ads_update_ad", "ads_update_ad_url_tags"],
    );
  });

  it("names from several groups register the union and nothing from other groups", () => {
    const expected = [...groupTools("accounts").read, ...groupTools("pixels").write].sort();
    expect(registered({ META_ADS_TOOLSETS: "accounts,pixels:write" })).toEqual(expected);
  });

  it("a group's read and write names together register the whole group", () => {
    const { read, write } = groupTools("pixels");
    expect(registered({ META_ADS_TOOLSETS: "pixels,pixels:write" })).toEqual([...read, ...write].sort());
  });

  it("the write list registers exactly its 16 pinned tools", () => {
    expect(registered({ META_ADS_TOOLSETS: WRITE_LIST })).toEqual(WRITE_LIST_TOOLS);
  });

  it("audiences:write never registers the customer-list upload", () => {
    const tools = registered({ META_ADS_TOOLSETS: "audiences:write" });
    expect(groupTools("audiences").write).toContain("ads_update_custom_audience_users");
    expect(tools).not.toContain("ads_update_custom_audience_users");
    expect(tools).toEqual(groupTools("audiences").write.filter((n) => n !== "ads_update_custom_audience_users"));
  });

  it("adsets:write never registers ads_clone_ad_set_bundle", () => {
    const tools = registered({ META_ADS_TOOLSETS: "adsets:write" });
    expect(groupTools("adsets").write).toContain("ads_clone_ad_set_bundle");
    expect(tools).not.toContain("ads_clone_ad_set_bundle");
    expect(tools).toEqual(groupTools("adsets").write.filter((n) => n !== "ads_clone_ad_set_bundle"));
  });
});

describe("refusals (check 1.2, at the resolver)", () => {
  it.each([
    ["unknown", "nonsense", "unknown"],
    ["unknown write", "nonsense:write", "unknown"],
    ["unknown suffix", "campaigns:read", "unknown"],
    ["upper case", "Campaigns", "unknown"],
    ["never", "tokens", "never registered"],
    ["never, write", "whatsapp:write", "never registered"],
    ["kept out", "entities", "kept out"],
    ["kept out, write", "billing:write", "kept out"],
    ["no write tools", "accounts:write", "registers nothing"],
    ["no write tools (insights)", "insights:write", "registers nothing"],
  ])("refuses a %s name and names it", (_label, name, reason) => {
    const error = refusal({ META_ADS_TOOLSETS: `accounts,${name}` });
    expect(error.problems).toEqual([{ name, reason }]);
    expect(error.message).toContain(name);
    expect(error.message).toContain(reason);
  });

  it("names every bad name in a mixed list", () => {
    const error = refusal({ META_ADS_TOOLSETS: "nonsense,accounts,leads,ad-dossier:write,help:write" });
    expect(error.problems).toEqual([
      { name: "nonsense", reason: "unknown" },
      { name: "leads", reason: "never registered" },
      { name: "ad-dossier:write", reason: "kept out" },
      { name: "help:write", reason: "registers nothing" },
    ]);
    for (const name of ["nonsense", "leads", "ad-dossier:write", "help:write"]) expect(error.message).toContain(name);
  });

  it("a group with no read tools refuses its read name", () => {
    // Every allowed group has read tools at f4dbacb; check the rule itself on each group.
    for (const [group, entry] of Object.entries(TOOL_GROUPS)) {
      if (entry.status !== "allowed") continue;
      const { read, write } = groupTools(group);
      if (read.length === 0) expect(refusal({ META_ADS_TOOLSETS: group }).problems[0].reason).toBe("registers nothing");
      else expect(() => resolveToolsets({ META_ADS_TOOLSETS: group })).not.toThrow();
      if (write.length === 0) expect(refusal({ META_ADS_TOOLSETS: `${group}:write` }).problems[0].reason).toBe("registers nothing");
      else expect(() => resolveToolsets({ META_ADS_TOOLSETS: `${group}:write` })).not.toThrow();
    }
  });
});

describe("the default and the empty list (check 1.3)", () => {
  it("unset registers exactly the pinned read-only default", () => {
    expect(registered({})).toEqual(DEFAULT_READ_TOOLS);
  });

  it("the default registers no write tool", () => {
    const server = createMockMcpServer();
    registerToolsets(server as never, resolveToolsets({}));
    for (const t of server._registeredTools) expect(t.annotations?.readOnlyHint, t.name).toBe(true);
  });

  it.each(["", " ", ",", " , ,"])("set but empty (%j) refuses", (value) => {
    expect(refusal({ META_ADS_TOOLSETS: value }).message).toMatch(/empty/);
  });
});

describe("META_ADS_READ_ONLY (check 1.4)", () => {
  it("=1 refuses a :write name and names it", () => {
    const error = refusal({ META_ADS_READ_ONLY: "1", META_ADS_TOOLSETS: "campaigns,ads:write" });
    expect(error.problems).toEqual([{ name: "ads:write", reason: "write name on a read-only server" }]);
  });

  it("=1 accepts read names and the default", () => {
    expect(registered({ META_ADS_READ_ONLY: "1", META_ADS_TOOLSETS: "campaigns" })).toEqual(groupTools("campaigns").read);
    expect(registered({ META_ADS_READ_ONLY: "1" })).toEqual(DEFAULT_READ_TOOLS);
  });

  it.each([undefined, ""])("%j is not read-only", (value) => {
    expect(registered({ META_ADS_READ_ONLY: value, META_ADS_TOOLSETS: "ads:write" })).toEqual(groupTools("ads").write);
  });

  it.each(["0", "true", "yes", " 1", "1 "])("any other value (%j) refuses to start", (value) => {
    expect(refusal({ META_ADS_READ_ONLY: value, META_ADS_TOOLSETS: "campaigns" }).message).toContain("META_ADS_READ_ONLY");
  });
});

describe("list syntax (check 1.5)", () => {
  it("trims names, drops empty items and duplicates", () => {
    expect(registered({ META_ADS_TOOLSETS: " campaigns , ,campaigns,, pixels:write " })).toEqual(
      [...groupTools("campaigns").read, ...groupTools("pixels").write].sort(),
    );
  });
});

describe("the filter (check 1.6)", () => {
  const annotations: ToolAnnotations = { readOnlyHint: true };

  it("has no method but registerTool", () => {
    const server = createMockMcpServer();
    const filter = toolFilter(server as never, () => true);
    expect(Object.keys(filter)).toEqual(["registerTool"]);
    expect(Object.getPrototypeOf(filter)).toBe(Object.prototype);
    expect(() => (filter as unknown as { tool: (...a: unknown[]) => void }).tool("x", "d", {}, async () => ({}))).toThrow();
    expect(server.tool).not.toHaveBeenCalled();
  });

  it("passes an admitted tool through and drops the rest", () => {
    const server = createMockMcpServer();
    const filter = toolFilter(server as never, (name) => name === "keep");
    const handler = async () => ({ content: [] });
    filter.registerTool("keep", { description: "k", annotations }, handler);
    filter.registerTool("drop", { description: "d", annotations }, handler);
    expect(server._registeredTools.map((t) => t.name)).toEqual(["keep"]);
    expect(server._registeredTools[0].handler).toBe(handler);
  });

  it("passes the name and annotations to the admit function", () => {
    const seen: Array<[string, ToolAnnotations | undefined]> = [];
    const filter = toolFilter(createMockMcpServer() as never, (name, a) => { seen.push([name, a]); return false; });
    filter.registerTool("t", { description: "x", annotations }, async () => ({ content: [] }));
    expect(seen).toEqual([["t", annotations]]);
  });
});
