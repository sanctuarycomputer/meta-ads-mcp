import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatasetLookup } from "../../src/apify/dataset-lookup.js";

const TOKEN = "apify_api_testfixture";

describe("findDatasetItem", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
  });

  it("rejects malformed ids before any request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const lookup = createDatasetLookup();
    await expect(lookup.findDatasetItem("../etc", "5550000000001")).rejects.toThrow(/Invalid Apify dataset id/);
    await expect(lookup.findDatasetItem("ds123abcde", "abc")).rejects.toThrow(/ad_archive_id/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
