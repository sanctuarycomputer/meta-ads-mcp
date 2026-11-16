// M9, the upload tools (spec check 2; plan task 8): ads_upload_ad_image and ads_upload_ad_video read one local file
// under META_ADS_UPLOAD_DIR through readLocalUpload, send it as multipart (the video to graph-video.facebook.com, the
// image and every descriptor GET to graph.facebook.com), and put its SHA-256 in the answer and the log line, never in
// the guard's descriptor. Served through createServer with the real gate (record-allow.mjs) and a recording fetch.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/server.js";
import { metaApiClient } from "../../src/meta/client.js";
import { hashToken } from "../../src/auth/token-store.js";
import { logger } from "../../src/utils/logger.js";
import { RealWriteGate, callContext, newCallContext } from "../../src/meta/write-guard.js";
import { registerCreativeTools } from "../../src/tools/creatives.js";
import { answerGet } from "../fixtures/meta-ads-guard/harness.js";
import { cleanupTestToken, createMockMcpServer, mockFetchResponse, setupTestToken } from "../setup.js";
import { ACT, connect, dropGuard, guardLog, smallWorld, textOf, useGuard, type ToolResult } from "../tools/validate-only-helpers.js";

// The singleton every tool uses, with the real gate, and retries on (no upload may be resent).
const guard = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }));
vi.unmock("../../src/meta/client.js");
vi.mock("../../src/meta/client.js", async (orig) => {
  const m = await orig<typeof import("../../src/meta/client.js")>();
  const { GuardRunner, RealWriteGate } = await import("../../src/meta/write-guard.js");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  return {
    ...m,
    metaApiClient: new m.MetaApiClient({
      maxRetries: 2,
      writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env: guard.env, cwd, timeoutMs: 15_000 })),
    }),
  };
});

// The reader as it is, with a lower byte limit when a case sets one.
const limit = vi.hoisted(() => ({ maxBytes: undefined as number | undefined }));
vi.mock("../../src/utils/local-upload.js", async (orig) => {
  const m = await orig<typeof import("../../src/utils/local-upload.js")>();
  return {
    ...m,
    readLocalUpload: (root: string, rel: string, opts?: { maxBytes?: number }) =>
      m.readLocalUpload(root, rel, limit.maxBytes === undefined ? opts : { maxBytes: limit.maxBytes }),
  };
});

const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";
const ENV_KEYS = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY", "META_ADS_UPLOAD_DIR"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
const GRAPH = "graph.facebook.com";
const VIDEO = "graph-video.facebook.com";
const OFF = "uploads are off: META_ADS_UPLOAD_DIR is not set to an absolute path";
const MAY_EXIST = "may exist";

// ---- the fake Graph: every request recorded with its host ----

interface Sent {
  method: string;
  host: string;
  path: string;
  init?: RequestInit;
}
let calls: Sent[];
let world: Map<string, unknown>;
let onWrite: (c: Sent) => Promise<Response> | Response;
const writes = () => calls.filter((c) => c.method !== "GET");
const formOf = (c: Sent) => c.init?.body as FormData;

function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const c: Sent = { method: init?.method ?? "GET", host: url.host, path: url.pathname.replace(/^\/v\d+\.\d+/, ""), init };
      calls.push(c);
      if (c.method !== "GET") return onWrite(c);
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== "appsecret_proof") params[k] = v;
      try {
        return mockFetchResponse(answerGet(world, c.path, params));
      } catch (e) {
        return mockFetchResponse({ error: { code: 100, type: "OAuthException", message: (e as Error).message } }, { status: 400 });
      }
    }),
  );
}

const records = (): string => (existsSync(guardLog()) ? readFileSync(guardLog(), "utf8") : "");

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connect(createServer());
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await close();
  }
}

// ---- the upload directory ----

let base: string;
let dir: string;
const put = (rel: string, bytes: Buffer | string) => {
  writeFileSync(path.join(dir, rel), bytes);
  return createHash("sha256").update(bytes).digest("hex");
};
// File bytes built at run time (no secret-shaped literal).
const pngBytes = () => Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47]), Buffer.alloc(60, 7)]);
const mp4Bytes = () => Buffer.alloc(200, 3);

const IMAGE_ANSWER = { images: { "a.png": { hash: "abc123", url: "https://scontent.example/a.png", name: "a.png" } } };
const timeout = () => Promise.reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }));

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.META_ADS_TOOLSETS = WRITE_LIST;
  base = mkdtempSync(path.join(tmpdir(), "m9-tools-"));
  dir = path.join(base, "uploads");
  mkdirSync(dir);
  mkdirSync(path.join(base, "outside"));
  process.env.META_ADS_UPLOAD_DIR = dir;
  limit.maxBytes = undefined;
  setupTestToken();
  metaApiClient.resetForTests();
  calls = [];
  world = smallWorld();
  onWrite = (c) => mockFetchResponse(c.path.endsWith("/adimages") ? IMAGE_ANSWER : { id: "777000111" });
  installFetch();
  vi.spyOn(metaApiClient as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue(undefined);
  for (const k of Object.keys(guard.env)) delete guard.env[k];
  useGuard(guard.env);
});

afterEach(() => {
  cleanupTestToken();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  dropGuard();
  rmSync(base, { recursive: true, force: true });
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

// ---- the image ----

describe("ads_upload_ad_image", () => {
  it("sends one upload to graph.facebook.com/<v>/act_<n>/adimages; every descriptor GET goes there too", async () => {
    const sha = put("a.png", pngBytes());
    const r = await call("ads_upload_ad_image", { account_id: ACT, path: "a.png" });
    expect(r.isError).toBeFalsy();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", host: GRAPH, path: `/${ACT}/adimages` });
    const gets = calls.filter((c) => c.method === "GET");
    expect(gets.length).toBeGreaterThan(0);
    for (const g of gets) expect(g.host).toBe(GRAPH);
    const file = formOf(writes()[0]).get("filename") as File;
    expect(Buffer.from(await file.arrayBuffer()).equals(pngBytes())).toBe(true);
    expect(textOf(r)).toContain(`SHA-256: ${sha}`);
    expect(textOf(r)).toContain(`Size: ${pngBytes().length} bytes`);
    expect(textOf(r)).toContain("Hash: abc123");
  });

  it("logs the SHA-256, size and relative name, and keeps every 64-hex value out of the guard's descriptor", async () => {
    mkdirSync(path.join(dir, "d"));
    const sha = put("d/a.png", pngBytes());
    const info = vi.spyOn(logger, "info");
    const r = await call("ads_upload_ad_image", { account_id: ACT, path: "d/a.png" });
    expect(r.isError).toBeFalsy();
    expect(info).toHaveBeenCalledWith({ file: "d/a.png", size: pngBytes().length, sha256: sha }, "Local file uploaded");
    const recorded = records();
    expect(recorded).toContain('"params_keys":["filename"]');
    expect(recorded).not.toMatch(/[0-9a-f]{64}/i);
    expect(recorded).not.toContain(sha);
  });

  it("names the file part after the caller's name, or the file's own name", async () => {
    put("a.png", pngBytes());
    await call("ads_upload_ad_image", { account_id: ACT, path: "a.png", name: "promo-octubre" });
    expect((formOf(writes()[0]).get("filename") as File).name).toBe("promo-octubre.png");
    expect(formOf(writes()[0]).get("name")).toBe("promo-octubre");
    await call("ads_upload_ad_image", { account_id: ACT, path: "a.png" });
    expect((formOf(writes()[1]).get("filename") as File).name).toBe("a.png");
    expect(formOf(writes()[1]).has("name")).toBe(false);
  });

  it("a timeout: one request, and the outcome is unknown (the image may exist)", async () => {
    put("a.png", pngBytes());
    onWrite = timeout;
    const r = await call("ads_upload_ad_image", { account_id: ACT, path: "a.png" });
    expect(r.isError).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(textOf(r)).toContain("the upload's outcome is unknown: the image may exist; check ads_get_ad_images before uploading again");
  });

  it("is not a URL tool: the schema takes path, and no image_url", async () => {
    const { client, close } = await connect(createServer());
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "ads_upload_ad_image")!;
      expect(Object.keys(tool.inputSchema.properties ?? {})).not.toContain("image_url");
      expect(tool.inputSchema.required).toContain("path");
    } finally {
      await close();
    }
    const r = await call("ads_upload_ad_image", { account_id: ACT, image_url: "https://cdn.example.test/a.png" });
    expect(r.isError).toBe(true);
    expect(calls).toHaveLength(0);
  });
});

// ---- the video ----

describe("ads_upload_ad_video", () => {
  it("sends one upload to graph-video.facebook.com/<v>/act_<n>/advideos, with the source part; GETs stay on graph.facebook.com", async () => {
    const sha = put("clip.mp4", mp4Bytes());
    const info = vi.spyOn(logger, "info");
    const r = await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4", name: "n", title: "t", description: "d" });
    expect(r.isError).toBeFalsy();
    expect(writes()).toHaveLength(1);
    expect(writes()[0]).toMatchObject({ method: "POST", host: VIDEO, path: `/${ACT}/advideos` });
    for (const g of calls.filter((c) => c.method === "GET")) expect(g.host).toBe(GRAPH);
    const form = formOf(writes()[0]);
    expect([...form.keys()].sort()).toEqual(["description", "name", "source", "title"]);
    expect(Buffer.from(await (form.get("source") as File).arrayBuffer()).equals(mp4Bytes())).toBe(true);
    expect(textOf(r)).toContain(`SHA-256: ${sha}`);
    expect(textOf(r)).toContain(`Size: ${mp4Bytes().length} bytes`);
    expect(textOf(r)).toContain("777000111");
    expect(info).toHaveBeenCalledWith({ file: "clip.mp4", size: mp4Bytes().length, sha256: sha }, "Local file uploaded");
    expect(records()).not.toMatch(/[0-9a-f]{64}/i);
  });

  it("is sent with the 300 s scope, and the image with none", async () => {
    put("clip.mp4", mp4Bytes());
    put("a.png", pngBytes());
    const spy = vi.spyOn(metaApiClient, "postMultipart");
    await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4" });
    await call("ads_upload_ad_image", { account_id: ACT, path: "a.png" });
    expect(spy.mock.calls[0][0]).toBe(`/${ACT}/advideos`);
    expect(spy.mock.calls[0][2]).toEqual({ timeoutMs: 300_000 });
    expect(spy.mock.calls[1][0]).toBe(`/${ACT}/adimages`);
    expect(spy.mock.calls[1][2]).toBeUndefined();
  });

  it.each([
    ["a timeout", timeout],
    ["a transport error", () => Promise.reject(new TypeError("fetch failed"))],
  ])("%s: one request (no resend), and the outcome is unknown", async (_name, fail) => {
    put("clip.mp4", mp4Bytes());
    onWrite = fail;
    const r = await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4" });
    expect(r.isError).toBe(true);
    expect(writes()).toHaveLength(1);
    expect(textOf(r)).toContain("the upload's outcome is unknown: the video may exist; check ads_get_ad_videos before uploading again");
    expect(textOf(r)).not.toMatch(/write refused/);
  });

  it("a Meta 400: Meta's error, not an unknown outcome", async () => {
    put("clip.mp4", mp4Bytes());
    onWrite = () => mockFetchResponse({ error: { code: 100, type: "OAuthException", message: "Invalid video file" } }, { status: 400 });
    const r = await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("Invalid video file");
    expect(textOf(r)).not.toContain(MAY_EXIST);
    expect(writes()).toHaveLength(1);
  });

  it("the circuit open after the guard's allow: not sent, never \"may exist\"", async () => {
    put("clip.mp4", mp4Bytes());
    const breaker = (metaApiClient as unknown as { circuitBreaker: { trip: (x: unknown, k: unknown) => void } }).circuitBreaker;
    const check = RealWriteGate.prototype.check;
    vi.spyOn(RealWriteGate.prototype, "check").mockImplementation(async function (this: RealWriteGate, ...args) {
      const allowed = await check.apply(this, args);
      breaker.trip({ tokenHash: hashToken("test-access-token"), accountId: ACT, type: "ads_management" }, { category: "abuse_signal", mcpError: new Error("abuse") });
      return allowed;
    });
    const r = await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4" });
    expect(r.isError).toBe(true);
    expect(writes()).toHaveLength(0);
    expect(textOf(r)).toMatch(/^not sent: .*Circuit open/);
    expect(textOf(r)).not.toContain(MAY_EXIST);
  });

  it("the guard's refusal: the wrapper's refusal, nothing sent, never \"may exist\"", async () => {
    put("clip.mp4", mp4Bytes());
    useGuard(guard.env, "REFUSE_TOOL=ads_upload_ad_video");
    const r = await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4" });
    expect(r.isError).toBe(true);
    expect(writes()).toHaveLength(0);
    expect(textOf(r)).toContain("write refused: guard denied: stub refuses ads_upload_ad_video");
    expect(textOf(r)).not.toContain(MAY_EXIST);
    expect(textOf(r)).not.toContain("not sent:");
  });

  it("the handler itself rethrows the guard's refusal unchanged (no write got past the gate)", async () => {
    put("clip.mp4", mp4Bytes());
    useGuard(guard.env, "REFUSE_TOOL=ads_upload_ad_video");
    const server = createMockMcpServer();
    registerCreativeTools(server as never);
    const handler = server._registeredTools.find((t) => t.name === "ads_upload_ad_video")!.handler;
    const ctx = newCallContext("ads_upload_ad_video", false);
    const err = (await callContext.run(ctx, () => handler({ account_id: ACT, path: "clip.mp4" })).catch((e: unknown) => e)) as Error;
    expect(err.message).toContain("write refused: guard denied: stub refuses ads_upload_ad_video");
    expect(err.message).not.toContain(MAY_EXIST);
    expect(err.message).not.toMatch(/^not sent/);
    expect(writes()).toHaveLength(0);
  });

  it("is not a URL tool: no file_url, no source_instagram_media_id", async () => {
    const { client, close } = await connect(createServer());
    try {
      const tool = (await client.listTools()).tools.find((t) => t.name === "ads_upload_ad_video")!;
      const props = Object.keys(tool.inputSchema.properties ?? {});
      expect(props).not.toContain("file_url");
      expect(props).not.toContain("source_instagram_media_id");
      expect(tool.inputSchema.required).toContain("path");
    } finally {
      await close();
    }
    for (const args of [{ file_url: "https://cdn.example.test/v.mp4" }, { source_instagram_media_id: "17900000000000001" }]) {
      const r = await call("ads_upload_ad_video", { account_id: ACT, ...args });
      expect(r.isError).toBe(true);
    }
    expect(calls).toHaveLength(0);
  });

  it("validate_only adds execution_options to the sent form", async () => {
    put("clip.mp4", mp4Bytes());
    await call("ads_upload_ad_video", { account_id: ACT, path: "clip.mp4", validate_only: true });
    expect(writes()).toHaveLength(1);
    expect(formOf(writes()[0]).get("execution_options")).toBe('["validate_only"]');
    expect(formOf(writes()[0]).has("source")).toBe(true);
  });
});

// ---- refused paths and directory: an error result naming the reason, zero requests ----

describe.skipIf(process.platform !== "linux")("a refused file: an error naming the reason, zero requests", () => {
  const CASES: Array<[string, () => string, RegExp]> = [
    ["../x", () => "../x", /bad-path/],
    ["an absolute path", () => path.join(dir, "a.bin"), /bad-path/],
    ["a symlink", () => {
      writeFileSync(path.join(base, "outside", "s.bin"), "x");
      symlinkSync(path.join(base, "outside", "s.bin"), path.join(dir, "l.bin"));
      return "l.bin";
    }, /symlink/],
    ["a hard link to a file outside the dir", () => {
      writeFileSync(path.join(base, "outside", "h.bin"), "x");
      linkSync(path.join(base, "outside", "h.bin"), path.join(dir, "h.bin"));
      return "h.bin";
    }, /hard-link/],
    ["a directory", () => {
      mkdirSync(path.join(dir, "sub"));
      return "sub";
    }, /not-regular/],
    ["a FIFO", () => {
      expect(spawnSync("mkfifo", [path.join(dir, "p.bin")]).status).toBe(0);
      return "p.bin";
    }, /not-regular/],
    ["a 0-byte file", () => {
      writeFileSync(path.join(dir, "z.bin"), "");
      return "z.bin";
    }, /empty/],
    ["a file over the limit", () => {
      limit.maxBytes = 10;
      writeFileSync(path.join(dir, "big.bin"), Buffer.alloc(11));
      return "big.bin";
    }, /too-large/],
  ];
  for (const tool of ["ads_upload_ad_image", "ads_upload_ad_video"]) {
    it.each(CASES)(`${tool}: %s`, async (_name, arrange, reason) => {
      writeFileSync(path.join(dir, "a.bin"), "x");
      const rel = arrange();
      const r = await call(tool, { account_id: ACT, path: rel });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(reason);
      expect(textOf(r)).not.toContain(base);
      expect(calls).toHaveLength(0);
    });
  }

  for (const tool of ["ads_upload_ad_image", "ads_upload_ad_video"]) {
    it.each([
      ["unset", undefined],
      ["empty", ""],
      ["relative", "uploads"],
    ])(`${tool}: META_ADS_UPLOAD_DIR %s refuses with zero requests`, async (_name, value) => {
      put("a.bin", "x");
      if (value === undefined) delete process.env.META_ADS_UPLOAD_DIR;
      else process.env.META_ADS_UPLOAD_DIR = value;
      const r = await call(tool, { account_id: ACT, path: "a.bin" });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain(OFF);
      expect(calls).toHaveLength(0);
    });
  }

  it("reads the directory per call", async () => {
    put("a.png", pngBytes());
    delete process.env.META_ADS_UPLOAD_DIR;
    expect((await call("ads_upload_ad_image", { account_id: ACT, path: "a.png" })).isError).toBe(true);
    process.env.META_ADS_UPLOAD_DIR = dir;
    expect((await call("ads_upload_ad_image", { account_id: ACT, path: "a.png" })).isError).toBeFalsy();
  });
});
