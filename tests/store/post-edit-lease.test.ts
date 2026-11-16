import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  advancePostEditGeneration,
  claimPostEditLease,
  postEditState,
  releasePostEditLease,
  resetPostEditLeasesForTests,
} from "../../src/store/post-edit-lease.js";

describe.each([
  ["in memory", () => resetPostEditLeasesForTests()],
])("post edit leases (%s)", (_name, reset) => {
  beforeEach(() => {
    reset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("lets one edit of a post run at a time", async () => {
    expect(await claimPostEditLease("6001_888", "a")).toBe(true);
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    expect(await claimPostEditLease("6001_999", "b")).toBe(true);
  });

  it("frees the post a while after its holder releases it, and only its holder", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    await claimPostEditLease("6001_888", "a");
    await releasePostEditLease("6001_888", "b");
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    await releasePostEditLease("6001_888", "a");
    // Meta's reads can lag behind the edit that just ended.
    vi.setSystemTime(new Date("2026-10-26T12:02:59Z"));
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    expect((await postEditState("6001_888")).busy).toBe(true);
    vi.setSystemTime(new Date("2026-10-26T12:03:01Z"));
    expect((await postEditState("6001_888")).busy).toBe(false);
    expect(await claimPostEditLease("6001_888", "b")).toBe(true);
  });

  it("shows a post as busy to everyone but the holder of its lease", async () => {
    expect(await postEditState("6001_888")).toEqual({ generation: 0, busy: false });
    await claimPostEditLease("6001_888", "a");
    expect((await postEditState("6001_888")).busy).toBe(true);
    expect((await postEditState("6001_888", "b")).busy).toBe(true);
    expect((await postEditState("6001_888", "a")).busy).toBe(false);
  });

  it("frees a post whose holder never released it after ten minutes", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    await claimPostEditLease("6001_888", "a");
    vi.setSystemTime(new Date("2026-10-26T12:09:00Z"));
    expect(await claimPostEditLease("6001_888", "b")).toBe(false);
    vi.setSystemTime(new Date("2026-10-26T12:10:01Z"));
    expect(await claimPostEditLease("6001_888", "b")).toBe(true);
  });

  it("counts the edits started on a post, each one only by the holder of its lease", async () => {
    const generation = async (post: string) => (await postEditState(post)).generation;
    expect(await generation("6001_888")).toBe(0);
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(false);
    await claimPostEditLease("6001_888", "a");
    expect(await advancePostEditGeneration("6001_888", "b")).toBe(false);
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(true);
    expect(await generation("6001_888")).toBe(1);
    expect(await generation("6001_999")).toBe(0);
  });

  it("keeps the count of a post across its leases", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    await claimPostEditLease("6001_888", "a");
    await advancePostEditGeneration("6001_888", "a");
    await releasePostEditLease("6001_888", "a");
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(false);
    vi.setSystemTime(new Date("2026-10-26T12:05:00Z"));
    await claimPostEditLease("6001_888", "b");
    await advancePostEditGeneration("6001_888", "b");
    expect((await postEditState("6001_888")).generation).toBe(2);
  });

  it("does not count an edit for a holder whose lease ran out", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-26T12:00:00Z"));
    await claimPostEditLease("6001_888", "a");
    vi.setSystemTime(new Date("2026-10-26T12:10:01Z"));
    expect(await advancePostEditGeneration("6001_888", "a")).toBe(false);
    expect((await postEditState("6001_888")).generation).toBe(0);
  });
});
