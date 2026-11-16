/**
 * M9 and M10: the fork downloads no URL itself. Both downloaders refuse before
 * any DNS lookup or request, whatever the URL, options or injected request,
 * and the media env knobs are no longer read.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import dns from "node:dns";
import { downloadSafePublicImage, DownloadsDisabledError } from "../../src/utils/safe-download.js";
import {
  assertAllowedVideoHost,
  downloadSafePublicVideo,
  resolveAllowedVideoHostSuffixes,
} from "../../src/media/safe-video-download.js";
import { videoMaxBytes } from "../../src/media/video-delivery.js";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import { createMockMcpServer } from "../setup.js";

const PREFIX = "downloads are disabled in this fork:";

let lookupPromise: ReturnType<typeof vi.spyOn>;
let lookupCallback: ReturnType<typeof vi.spyOn>;
const request = vi.fn(() => {
  throw new Error("request used");
});
const resolve = vi.fn(() => Promise.reject(new Error("resolve used")));

beforeEach(() => {
  lookupPromise = vi.spyOn(dns.promises, "lookup");
  lookupCallback = vi.spyOn(dns, "lookup");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  request.mockClear();
  resolve.mockClear();
  delete process.env.VIDEO_ALLOWED_HOST_SUFFIXES;
  delete process.env.VIDEO_MAX_BYTES;
});

function expectNoNetwork() {
  expect(lookupPromise).not.toHaveBeenCalled();
  expect(lookupCallback).not.toHaveBeenCalled();
  expect(request).not.toHaveBeenCalled();
  expect(resolve).not.toHaveBeenCalled();
}

async function refusal(work: () => Promise<unknown>): Promise<Error> {
  try {
    await work();
  } catch (err) {
    return err as Error;
  }
  throw new Error("expected a refusal");
}

describe("M9/M10: no URL downloads", () => {
  it("image download refuses before DNS", async () => {
    const err = await refusal(() =>
      downloadSafePublicImage("https://cdn.example.test/a.jpg", { request: request as never, resolve: resolve as never }),
    );
    expect(err).toBeInstanceOf(DownloadsDisabledError);
    expect(err.message.startsWith(PREFIX)).toBe(true);
    expectNoNetwork();
  });

  it("video download refuses before DNS", async () => {
    const err = await refusal(() =>
      downloadSafePublicVideo("https://video.xx.fbcdn.net/v.mp4", {
        destDir: "/nonexistent",
        request: request as never,
        resolve: resolve as never,
        allowedHostSuffixes: [".fbcdn.net"],
      }),
    );
    expect(err).toBeInstanceOf(DownloadsDisabledError);
    expect(err.message.startsWith(PREFIX)).toBe(true);
    expectNoNetwork();
  });

  it("upload image takes no URL: its schema has no image_url (253: a local path)", () => {
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const tool = server._registeredTools.find((t) => t.name === "ads_upload_ad_image")!;
    expect(Object.keys(tool.schema as Record<string, unknown>)).not.toContain("image_url");
    expect(Object.keys(tool.schema as Record<string, unknown>)).toContain("path");
  });

  it("video host env is ignored", () => {
    process.env.VIDEO_ALLOWED_HOST_SUFFIXES = ".example.test";
    expect(resolveAllowedVideoHostSuffixes()).toEqual([]);
  });

  it("media env knobs are not read", () => {
    process.env.VIDEO_MAX_BYTES = "1";
    expect(videoMaxBytes()).toBe(150 * 1024 * 1024);
  });

  it("empty video allowlist refuses every host", () => {
    expect(() =>
      assertAllowedVideoHost(new URL("https://video.xx.fbcdn.net/v.mp4"), resolveAllowedVideoHostSuffixes()),
    ).toThrow();
  });
});
