import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import { boundedClone, registerAdsLibraryTools } from "../../src/tools/ads-library.js";
import {
  InMemoryApifyTokenRepo,
  configureApifyTokenRepoForTests,
} from "../../src/store/apify-token-repo.js";
import { createMockMcpServer } from "../setup.js";
import { configureDatasetLookupForTests, createDatasetLookup } from "../../src/apify/dataset-lookup.js";


// Kept under the 20-char suffix that .gitleaks.toml's apify-api-token rule
// matches, so this fixture never trips the secret scanner.
const TOKEN = "apify_api_testfixture";

type ToolResult = { content: Array<{ type: string; text: string }>; isError?: boolean };

function setup(deps: Record<string, unknown> = {}) {
  const server = createMockMcpServer();
  registerAdsLibraryTools(server as never, deps as never);
  const byName = (name: string) => {
    const tool = server._registeredTools.find((t) => t.name === name);
    if (!tool) throw new Error(`tool ${name} not registered`);
    return tool.handler as (args: Record<string, unknown>) => Promise<ToolResult>;
  };
  return { server, byName };
}

const SCRAPE_DEFAULTS = {
  query: undefined,
  url: undefined,
  country: "ALL",
  active_status: "active",
  ad_type: "all",
  search_type: "keyword_unordered",
  period: undefined,
  sort_by: "impressions_desc",
  count: 100,
  scrape_ad_details: false,
};

describe("ads_library_* tools", () => {
  let repo: InMemoryApifyTokenRepo;

  beforeEach(() => {
    repo = new InMemoryApifyTokenRepo();
    configureApifyTokenRepoForTests(repo);
    process.env.APIFY_TOKEN = TOKEN;
    configureDatasetLookupForTests(createDatasetLookup());
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    configureDatasetLookupForTests(undefined);
    delete process.env.APIFY_TOKEN;
    configureApifyTokenRepoForTests(undefined);
  });

  describe("registration", () => {
    it("registers exactly 9 tools", () => {
      const { server } = setup();
      expect(server.registerTool).toHaveBeenCalledTimes(9);
    });

    it("registers the expected names", () => {
      const { server } = setup();
      expect(server._registeredTools.map((t) => t.name)).toEqual([
        "ads_library_register_apify_token",
        "ads_library_get_apify_token_status",
        "ads_library_delete_apify_token",
        "ads_library_scrape",
        "ads_library_get_run_status",
        "ads_library_get_results",
        "ads_library_abort_run",
        "ads_library_list_runs",
        "ads_library_get_ad_details",
      ]);
    });

    it("warns on every non-read tool", () => {
      const { server } = setup();
      for (const tool of server._registeredTools) {
        if (tool.annotations?.readOnlyHint !== true) {
          expect(tool.description).toContain("⚠️");
        }
      }
    });
  });

  describe("ads_library_register_apify_token", () => {

    it("does not store the token when validation fails", async () => {

      const result = await setup().byName("ads_library_register_apify_token")({
        apify_token: "apify_api_bogus",
      });

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toContain("NOT stored");
      expect(await repo.getDecryptedToken("_local")).toBeNull();
    });
  });

  describe("ads_library_get_apify_token_status", () => {
    it("reports the encrypted per-user source once registered", async () => {
      await repo.saveToken("_local", TOKEN, { id: "u1", username: "byads" });

      const result = await setup().byName("ads_library_get_apify_token_status")({
        verify: false,
      });

      expect(result.content[0].text).toContain("encrypted_user_storage");
      expect(JSON.stringify(result)).not.toContain(TOKEN);
    });

    it("does not advertise the env fallback in multi-tenant mode, where it is unreachable", async () => {
      const savedId = process.env.META_APP_ID;
      const savedSecret = process.env.META_APP_SECRET;
      process.env.META_APP_ID = "1234567890";
      process.env.META_APP_SECRET = "f".repeat(32);

      try {
        // No OAuth identity + multi-tenant → the resolver refuses outright, so
        // the status tool must not claim an env token has us covered.
        await expect(
          setup().byName("ads_library_get_apify_token_status")({ verify: false }),
        ).rejects.toThrow(/authenticated user in multi-tenant mode/);
      } finally {
        if (savedId === undefined) delete process.env.META_APP_ID;
        else process.env.META_APP_ID = savedId;
        if (savedSecret === undefined) delete process.env.META_APP_SECRET;
        else process.env.META_APP_SECRET = savedSecret;
      }
    });

    it("reports none when there is no token anywhere", async () => {
      const result = await setup().byName("ads_library_get_apify_token_status")({
        verify: false,
      });
      expect(result.content[0].text).toContain("No Apify token available");
    });
  });

  describe("ads_library_delete_apify_token", () => {

    it("deletes a stored token", async () => {
      await repo.saveToken("_local", TOKEN, null);

      const result = await setup().byName("ads_library_delete_apify_token")({});

      expect(result.isError).toBeUndefined();
      expect(await repo.getDecryptedToken("_local")).toBeNull();
      // 254 M7: there is no env fallback to mention any more.
      expect(result.content[0].text).not.toContain("environment fallback is still active");
    });

    it("errors when there is nothing to delete", async () => {
      const result = await setup().byName("ads_library_delete_apify_token")({});
      expect(result.isError).toBe(true);
    });
  });

  describe("ads_library_scrape", () => {

    it("still accepts a legacy explicit period of '' by normalizing it to undefined", () => {
      const { server } = setup();
      const tool = server._registeredTools.find((t) => t.name === "ads_library_scrape");
      const shape = tool?.schema as {
        period: { safeParse: (v: unknown) => { success: boolean; data?: unknown } };
      };
      expect(shape.period.safeParse("")).toEqual({ success: true, data: undefined });
      expect(shape.period.safeParse("last7d")).toEqual({ success: true, data: "last7d" });
      expect(shape.period.safeParse("bogus").success).toBe(false);
    });

    it.each([
      ["http://www.facebook.com/ads/library/", "plain http"],
      ["https://evil.com/ads/library/", "non-facebook host"],
      ["https://facebook.com.evil.com/x", "suffix lookalike host"],
      ["https://notfacebook.com/x", "prefix lookalike host"],
      ["https://www.facebook.com@evil.com/x", "userinfo host confusion"],
      ["https://user:pass@www.facebook.com/x", "embedded credentials"],
      ["https://www.facebook.com:8443/x", "non-default port"],
      ["https://www.facebook.com/l.php?u=https://evil.com", "outbound redirector"],
      ["https://www.facebook.com/%6c.php?u=https://evil.com", "percent-encoded redirector"],
      ["https://www.facebook.com//l.php?u=https://evil.com", "doubled-slash redirector"],
      ["https://www.facebook.com/l.php/?u=https://evil.com", "trailing-slash redirector"],
      ["https://www.facebook.com/AWAY.PHP?u=https://evil.com", "uppercase redirector"],
      ["not a url", "unparseable"],
    ])("rejects %s (%s)", async (url) => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_scrape")({ ...SCRAPE_DEFAULTS, url }),
      ).rejects.toThrow(McpError);

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects passing both query and url", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_scrape")({
          ...SCRAPE_DEFAULTS,
          query: "nike",
          url: "https://www.facebook.com/Nike",
        }),
      ).rejects.toThrow(/exactly one/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("rejects passing neither query nor url", async () => {
      vi.stubGlobal("fetch", vi.fn());

      await expect(
        setup().byName("ads_library_scrape")({ ...SCRAPE_DEFAULTS }),
      ).rejects.toThrow(/exactly one/i);
    });

    it("rejects a whitespace-only query instead of starting a billable open search", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_scrape")({ ...SCRAPE_DEFAULTS, query: "   " }),
      ).rejects.toThrow(/exactly one/i);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("ads_library_get_run_status", () => {

    it("rejects a malformed run id before calling Apify", async () => {
      const fetchMock = vi.fn();
      vi.stubGlobal("fetch", fetchMock);

      await expect(
        setup().byName("ads_library_get_run_status")({ run_id: "../../v2/users/me" }),
      ).rejects.toThrow(McpError);
      expect(fetchMock).not.toHaveBeenCalled();
    });
  });

  describe("ads_library_get_ad_details", () => {

    it("is read-only, without a write warning, and documents the video delivery modes", () => {
      const tool = setup().server._registeredTools.find((t) => t.name === "ads_library_get_ad_details");
      expect(tool?.annotations?.readOnlyHint).toBe(true);
      expect(tool?.description).not.toContain("⚠️");
      expect(tool?.description).toMatch(/ads_get_video_media/);
    });
  });

  describe("boundedClone", () => {
    it("counts every visited value, null included, against the node budget", () => {
      const out = boundedClone(Array.from({ length: 40_000 }, () => null), { maxNodes: 300, maxKeys: 1000 }) as unknown[];
      // 300 nodes: the array itself plus 299 nulls, then the omission marker.
      expect(out.length).toBe(300);
      expect(out.slice(0, 299).every((v) => v === null)).toBe(true);
      expect(String(out[299])).toMatch(/omitted/);
    });
  });
});
