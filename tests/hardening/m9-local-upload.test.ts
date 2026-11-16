/**
 * M9: the local-file reader 253 wires into the upload tools. Every refusal
 * asserts its code, so each guard has a case only it decides.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { appendFileSync, chmodSync, mkdtempSync, mkdirSync, readdirSync, rmSync, symlinkSync, truncateSync, writeFileSync } from "node:fs";
import { createServer, type Server } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  __localUploadSeamsForTests as seams,
  LOCAL_UPLOAD_MAX_BYTES,
  LocalUploadError,
  readLocalUpload,
} from "../../src/utils/local-upload.js";

const original = { ...seams };
let base: string;
let root: string;
let outside: string;

beforeEach(() => {
  base = mkdtempSync(path.join(tmpdir(), "m9-upload-"));
  root = path.join(base, "root");
  outside = path.join(base, "outside");
  mkdirSync(root);
  mkdirSync(outside);
});
afterEach(() => {
  Object.assign(seams, original);
  rmSync(base, { recursive: true, force: true });
});

async function codeOf(work: () => Promise<unknown>): Promise<string> {
  try {
    await work();
  } catch (err) {
    expect(err).toBeInstanceOf(LocalUploadError);
    return (err as LocalUploadError).code;
  }
  throw new Error("expected a refusal");
}

describe.skipIf(process.platform !== "linux")("M9: readLocalUpload", () => {
  it("reads a file and reports sha256", async () => {
    const bytes = Buffer.from([1, 2, 3]);
    writeFileSync(path.join(root, "a.png"), bytes);
    const got = await readLocalUpload(root, "a.png");
    expect(got).toMatchObject({ size: 3, name: "a.png", sha256: createHash("sha256").update(bytes).digest("hex") });
    expect(got.bytes.equals(bytes)).toBe(true);
  });

  it("refuses absolute, empty, NUL, dot and dot-dot paths", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    for (const bad of ["/etc/passwd", "", "a\0b", "./a.png", "x/../a.png", ".."]) {
      expect(await codeOf(() => readLocalUpload(root, bad)), JSON.stringify(bad)).toBe("bad-path");
    }
  });

  it("refuses a symlinked middle component", async () => {
    writeFileSync(path.join(outside, "a.png"), "x");
    symlinkSync(outside, path.join(root, "d"));
    expect(await codeOf(() => readLocalUpload(root, "d/a.png"))).toBe("symlink");
  });

  it("O_NOFOLLOW refuses a final symlink the realpath check missed", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    symlinkSync(path.join(root, "a.png"), path.join(root, "l.png"));
    seams.realpath = (async (p: string) => p) as typeof seams.realpath;
    expect(await codeOf(() => readLocalUpload(root, "l.png"))).toBe("symlink");
  });

  it("refuses a directory", async () => {
    mkdirSync(path.join(root, "sub"));
    expect(await codeOf(() => readLocalUpload(root, "sub"))).toBe("not-regular");
  });

  it("refuses over maxBytes", async () => {
    writeFileSync(path.join(root, "big.png"), Buffer.alloc(11));
    expect(await codeOf(() => readLocalUpload(root, "big.png", { maxBytes: 10 }))).toBe("too-large");
    expect(await codeOf(() => readLocalUpload(root, "big.png", { maxBytes: LOCAL_UPLOAD_MAX_BYTES + 1 }))).toBe("bad-option");
    expect(await codeOf(() => readLocalUpload(root, "big.png", { maxBytes: 0 }))).toBe("bad-option");
  });

  it("accepts a file of exactly maxBytes", async () => {
    writeFileSync(path.join(root, "ten.png"), Buffer.alloc(10, 7));
    const got = await readLocalUpload(root, "ten.png", { maxBytes: 10 });
    expect(got.size).toBe(10);
  });

  it("reads a small file under the largest maxBytes without allocating it", async () => {
    writeFileSync(path.join(root, "a.png"), Buffer.from([1, 2, 3]));
    const got = await readLocalUpload(root, "a.png", { maxBytes: LOCAL_UPLOAD_MAX_BYTES });
    expect(got.size).toBe(3);
    expect(got.bytes.buffer.byteLength).toBeLessThan(1024 * 1024);
  });

  it("refuses a non-integer maxBytes", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    expect(await codeOf(() => readLocalUpload(root, "a.png", { maxBytes: 1.5 }))).toBe("bad-option");
  });

  it("refuses a FIFO without blocking", async () => {
    const fifo = path.join(root, "pipe.png");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(await codeOf(() => readLocalUpload(root, "pipe.png"))).toBe("not-regular");
  }, 3_000);

  it("names a nested file by its last segment", async () => {
    mkdirSync(path.join(root, "d", "e"), { recursive: true });
    writeFileSync(path.join(root, "d", "e", "a.png"), "x");
    expect((await readLocalUpload(root, "d/e/a.png")).name).toBe("a.png");
  });

  it("accepts a root that is itself a symlink", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    const link = path.join(base, "root-link");
    symlinkSync(root, link);
    expect((await readLocalUpload(link, "a.png")).size).toBe(1);
  });

  it("closes the descriptor on success and on refusal", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    mkdirSync(path.join(root, "sub"));
    const before = readdirSync("/proc/self/fd").length;
    await readLocalUpload(root, "a.png");
    await codeOf(() => readLocalUpload(root, "sub"));
    expect(readdirSync("/proc/self/fd").length).toBe(before);
  });

  it("refuses a missing file or root without naming the path", async () => {
    for (const work of [() => readLocalUpload(root, "missing.png"), () => readLocalUpload(path.join(base, "nope"), "a.png")]) {
      const err = await work().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(LocalUploadError);
      expect((err as LocalUploadError).code).toBe("not-found");
      expect((err as Error).message).not.toContain(base);
    }
  });

  it("reads a file larger than one read chunk, byte for byte", async () => {
    const bytes = Buffer.alloc(1024 * 1024 + 5);
    for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
    writeFileSync(path.join(root, "two.png"), bytes);
    const got = await readLocalUpload(root, "two.png");
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.sha256).toBe(createHash("sha256").update(bytes).digest("hex"));
  });

  it("returns the whole file when it grew after opening", async () => {
    const file = path.join(root, "grow.png");
    writeFileSync(file, Buffer.alloc(10, 1));
    seams.readFdPath = async (fd) => {
      appendFileSync(file, Buffer.alloc(90, 2));
      return original.readFdPath(fd);
    };
    const got = await readLocalUpload(root, "grow.png");
    expect(got.size).toBe(100);
    expect(got.sha256).toBe(createHash("sha256").update(got.bytes).digest("hex"));
  });

  it("refuses a file that grew past maxBytes after opening", async () => {
    const file = path.join(root, "grow.png");
    writeFileSync(file, Buffer.alloc(10, 1));
    seams.readFdPath = async (fd) => {
      appendFileSync(file, Buffer.alloc(90, 2));
      return original.readFdPath(fd);
    };
    expect(await codeOf(() => readLocalUpload(root, "grow.png", { maxBytes: 50 }))).toBe("too-large");
  });

  it("returns what is left of a file that shrank after opening", async () => {
    const file = path.join(root, "shrink.png");
    writeFileSync(file, Buffer.alloc(100, 1));
    seams.readFdPath = async (fd) => {
      truncateSync(file, 3);
      return original.readFdPath(fd);
    };
    expect((await readLocalUpload(root, "shrink.png")).size).toBe(3);
  });

  it("refuses a path through a file as not-found", async () => {
    writeFileSync(path.join(root, "afile"), "x");
    const err = await readLocalUpload(root, "afile/x.png").catch((e: unknown) => e);
    expect((err as LocalUploadError).code).toBe("not-found");
    expect((err as Error).message).not.toContain(base);
  });

  it("refuses a unix socket as not-regular", async () => {
    const sock = path.join(root, "s.png");
    const server: Server = createServer();
    await new Promise<void>((resolve) => server.listen(sock, resolve));
    try {
      expect(await codeOf(() => readLocalUpload(root, "s.png"))).toBe("not-regular");
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("refuses an over-long name as unreadable, without the path", async () => {
    const err = await readLocalUpload(root, "n".repeat(300)).catch((e: unknown) => e);
    expect((err as LocalUploadError).code).toBe("unreadable");
    expect((err as Error).message).not.toContain(base);
  });

  it.skipIf(process.getuid?.() === 0)("refuses an unreadable file as unreadable, without the path", async () => {
    const file = path.join(root, "locked.png");
    writeFileSync(file, "x");
    chmodSync(file, 0o000);
    const err = await readLocalUpload(root, "locked.png").catch((e: unknown) => e);
    expect((err as LocalUploadError).code).toBe("unreadable");
    expect((err as Error).message).not.toContain(base);
  });

  it("refuses when the descriptor's real path differs", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    seams.readFdPath = async () => "/elsewhere";
    expect(await codeOf(() => readLocalUpload(root, "a.png"))).toBe("fd-mismatch");
  });

  it("refuses without /proc", async () => {
    writeFileSync(path.join(root, "a.png"), "x");
    seams.readFdPath = async () => {
      throw Object.assign(new Error("no proc"), { code: "ENOENT" });
    };
    expect(await codeOf(() => readLocalUpload(root, "a.png"))).toBe("no-proc");
  });
});
