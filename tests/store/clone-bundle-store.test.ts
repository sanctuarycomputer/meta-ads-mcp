import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { configureCloneBundleStoreForTests, getCloneBundleStore, resetCloneBundleStoreForTests, STALE_IN_PROGRESS_MS } from "../../src/store/clone-bundle-store.js";
import { persistentCloneBundleStore } from "../setup.js";

describe.each([
  ["in memory", () => resetCloneBundleStoreForTests(), false],
  // The tests' persistent double (tests/setup.ts) must keep the same rules.
  ["persistent test double", () => configureCloneBundleStoreForTests(persistentCloneBundleStore()), true],
])("clone bundle store (%s)", (_name, reset, persistent) => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  async function staleRunWithAd(key: string): Promise<void> {
    const store = getCloneBundleStore();
    await store.claim(key, "sig");
    await store.update(key, { createdResources: { creativeIds: [], adIds: ["5001"] } });
    const later = Date.now() + STALE_IN_PROGRESS_MS + 1000;
    vi.spyOn(Date, "now").mockReturnValue(later);
  }

  it("says whether its records outlive this process", () => {
    expect(getCloneBundleStore().persistent).toBe(persistent);
  });

  it("takes over a stale run by default", async () => {
    await staleRunWithAd("k");

    const claim = await getCloneBundleStore().claim("k", "sig");

    expect(claim.status).toBe("claimed");
  });

  it("never takes over a run still in progress that is not yet stale", async () => {
    await getCloneBundleStore().claim("k", "sig");
    vi.spyOn(Date, "now").mockReturnValue(Date.now() + STALE_IN_PROGRESS_MS - 1000);

    const claim = await getCloneBundleStore().claim("k", "sig");

    expect(claim.status).toBe("duplicate");
  });

  it("never takes over a run, however stale, when asked not to", async () => {
    await staleRunWithAd("k");

    const claim = await getCloneBundleStore().claim("k", "sig", { reclaimStale: false });

    expect(claim.status).toBe("duplicate");
    expect(claim.existing?.createdResources.adIds).toEqual(["5001"]);
    expect((await getCloneBundleStore().getDoc("k"))?.createdResources.adIds).toEqual(["5001"]);
  });
});
