/**
 * M9: the local-file reader 253 wires into the upload tools. Every refusal
 * asserts its code, so each guard has a case only it decides.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createHash } from "node:crypto";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
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
