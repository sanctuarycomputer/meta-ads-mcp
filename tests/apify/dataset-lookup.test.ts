import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createDatasetLookup } from "../../src/apify/dataset-lookup.js";
import { mockFetchResponse } from "../setup.js";

const TOKEN = "apify_api_testfixture";

describe("findDatasetItem", () => {
  beforeEach(() => {
    process.env.APIFY_TOKEN = TOKEN;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.APIFY_TOKEN;
  });

  it("leaves no orphan generation behind after a lookup that failed on a second mismatch", async () => {
    let version = 0;
    vi.stubGlobal("fetch", vi.fn().mockImplementation(async (input: string) => {
      const params = new URL(input).searchParams;
      if (params.get("fields")) return mockFetchResponse([{ ad_archive_id: "1000000000001" }]);
      version += 1;
      return mockFetchResponse([{ ad_archive_id: String(2000000000000 + version) }]);
    }));
    const lookup = createDatasetLookup({ pageSize: 1000 });
    for (const ds of ["ds123abcde", "ds123abcdf", "ds123abcdg"]) {
      await expect(lookup.findDatasetItem(ds, "1000000000001")).rejects.toThrow();
    }
    expect(lookup.stats()).toMatchObject({ cached_datasets: 0, in_flight: 0, generations: 0 });
  });

  it("rejects malformed ids before any request", async () => {
    vi.stubGlobal("fetch", vi.fn());
    const lookup = createDatasetLookup();
    await expect(lookup.findDatasetItem("../etc", "5550000000001")).rejects.toThrow(/Invalid Apify dataset id/);
    await expect(lookup.findDatasetItem("ds123abcde", "abc")).rejects.toThrow(/ad_archive_id/);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });
});
