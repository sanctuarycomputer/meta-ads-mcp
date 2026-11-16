import { createHash } from "node:crypto";
import { constants, promises as fs } from "node:fs";
import path from "node:path";

/**
 * 254 M9: reads a file the caller names by a path relative to an upload root,
 * in place of the URL downloads this fork removed (253 wires it into the
 * upload tools). The file must sit under the root with no symlink anywhere on
 * its path, must be a regular file, and is read through one descriptor whose
 * real path is checked again after opening, so a swap between the check and
 * the open is refused. Linux only: the descriptor check reads /proc/self/fd.
 */

export const LOCAL_UPLOAD_DEFAULT_MAX_BYTES = 100 * 1024 * 1024;
export const LOCAL_UPLOAD_MAX_BYTES = 4 * 1024 ** 3;

export type LocalUploadErrorCode =
  | "bad-path"
  | "bad-option"
  | "symlink"
  | "not-regular"
  | "too-large"
  | "fd-mismatch"
  | "no-proc"
  | "not-found";

export class LocalUploadError extends Error {
  constructor(
    readonly code: LocalUploadErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "LocalUploadError";
  }
}

export interface LocalUpload {
  bytes: Buffer;
  sha256: string;
  size: number;
  name: string;
}

/** Replaceable in tests only; production uses the defaults. */
export const __localUploadSeamsForTests: {
  realpath: typeof fs.realpath;
  readFdPath: (fd: number) => Promise<string>;
} = {
  realpath: fs.realpath,
  readFdPath: (fd: number) => fs.readlink(`/proc/self/fd/${fd}`),
};

function segmentsOf(relativePath: string): string[] {
  const refuse = () => new LocalUploadError("bad-path", "The upload path must be a relative path under the upload root.");
  if (typeof relativePath !== "string" || relativePath.length === 0) throw refuse();
  if (relativePath.includes("\0")) throw refuse();
  // An empty segment covers an absolute path ("/etc" starts with one) and "a//b".
  const segments = relativePath.split("/");
  if (segments.some((s) => s === "" || s === "." || s === "..")) throw refuse();
  return segments;
}

function maxBytesOf(opts: { maxBytes?: number } | undefined): number {
  const maxBytes = opts?.maxBytes ?? LOCAL_UPLOAD_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > LOCAL_UPLOAD_MAX_BYTES) {
    throw new LocalUploadError("bad-option", `maxBytes must be an integer from 1 to ${LOCAL_UPLOAD_MAX_BYTES}.`);
  }
  return maxBytes;
}

const errno = (err: unknown) => (err as { code?: unknown })?.code;

/** A missing root or file, refused without the path (it would reach the caller). */
async function orNotFound<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (errno(err) === "ENOENT" || errno(err) === "ENOTDIR") {
      throw new LocalUploadError("not-found", "No such file under the upload root.");
    }
    throw err;
  }
}

/** Each read asks for at most this much, well under fs.read's 2 GiB limit. */
const READ_CHUNK_BYTES = 1024 * 1024;

export async function readLocalUpload(
  root: string,
  relativePath: string,
  opts?: { maxBytes?: number },
): Promise<LocalUpload> {
  const segments = segmentsOf(relativePath);
  const maxBytes = maxBytesOf(opts);
  const seams = __localUploadSeamsForTests;

  const realRoot = await orNotFound(() => seams.realpath(root));
  const expected = path.join(realRoot, ...segments);
  // A symlink anywhere below the root (a middle directory included) makes the
  // resolved path differ from the joined one.
  if ((await orNotFound(() => seams.realpath(expected))) !== expected) {
    throw new LocalUploadError("symlink", "The upload path must not pass through a symlink.");
  }

  let handle: fs.FileHandle;
  try {
    // O_NONBLOCK: opening a FIFO or a device must not wait for a writer; the
    // regular-file check below then refuses it.
    handle = await fs.open(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (err) {
    if (errno(err) === "ELOOP") throw new LocalUploadError("symlink", "The upload path must not be a symlink.");
    if (errno(err) === "ENOENT") throw new LocalUploadError("not-found", "No such file under the upload root.");
    throw err;
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) {
      throw new LocalUploadError("not-regular", "The upload path must name a regular file.");
    }
    let fdPath: string;
    try {
      fdPath = await seams.readFdPath(handle.fd);
    } catch (err) {
      if (errno(err) === "ENOENT") throw new LocalUploadError("no-proc", "Local uploads need /proc to verify the opened file.");
      throw err;
    }
    if (fdPath !== expected) {
      throw new LocalUploadError("fd-mismatch", "The opened file is not the one that was checked.");
    }
    // Sized from fstat, with one byte more to see a file that grew since: the
    // read stops at the limit either way, in chunks fs.read accepts.
    const buffer = Buffer.alloc(Math.min(stat.size, maxBytes) + 1);
    let size = 0;
    while (size < buffer.length) {
      const want = Math.min(READ_CHUNK_BYTES, buffer.length - size);
      const { bytesRead } = await handle.read(buffer, size, want, null);
      if (bytesRead === 0) break;
      size += bytesRead;
    }
    if (size > maxBytes) throw new LocalUploadError("too-large", `The file is larger than ${maxBytes} bytes.`);
    const bytes = buffer.subarray(0, size);
    return {
      bytes,
      sha256: createHash("sha256").update(bytes).digest("hex"),
      size,
      name: segments[segments.length - 1],
    };
  } finally {
    await handle.close();
  }
}
