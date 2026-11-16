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
  | "not-found"
  | "unreadable";

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

/** The byte limit a read uses: the caller's maxBytes, or the default; refuses one out of range. */
export function resolveLocalUploadMaxBytes(opts: { maxBytes?: number } | undefined): number {
  const maxBytes = opts?.maxBytes ?? LOCAL_UPLOAD_DEFAULT_MAX_BYTES;
  if (!Number.isInteger(maxBytes) || maxBytes < 1 || maxBytes > LOCAL_UPLOAD_MAX_BYTES) {
    throw new LocalUploadError("bad-option", `maxBytes must be an integer from 1 to ${LOCAL_UPLOAD_MAX_BYTES}.`);
  }
  return maxBytes;
}

const errno = (err: unknown) => (err as { code?: unknown })?.code;

/**
 * Turns a filesystem error into a LocalUploadError whose message never holds
 * a path (the message reaches the caller): a missing root, directory or file
 * is not-found, a symlink the open met is symlink, a socket or device the
 * non-blocking open refused is not-regular, and anything else is unreadable.
 */
function mapFsError(err: unknown): LocalUploadError {
  if (err instanceof LocalUploadError) return err;
  const code = errno(err);
  if (code === "ENOENT" || code === "ENOTDIR") return new LocalUploadError("not-found", "No such file under the upload root.");
  if (code === "ELOOP") return new LocalUploadError("symlink", "The upload path must not be a symlink.");
  if (code === "ENXIO") return new LocalUploadError("not-regular", "The upload path must name a regular file.");
  const shown = typeof code === "string" && /^E[A-Z]+$/.test(code) ? ` (${code})` : "";
  return new LocalUploadError("unreadable", `The file could not be read${shown}.`);
}

/** Each read asks for at most this much, well under fs.read's 2 GiB limit. */
const READ_CHUNK_BYTES = 1024 * 1024;

export async function readLocalUpload(
  root: string,
  relativePath: string,
  opts?: { maxBytes?: number },
): Promise<LocalUpload> {
  const segments = segmentsOf(relativePath);
  const maxBytes = resolveLocalUploadMaxBytes(opts);
  try {
    return await readChecked(root, segments, maxBytes);
  } catch (err) {
    throw mapFsError(err);
  }
}

async function readChecked(root: string, segments: string[], maxBytes: number): Promise<LocalUpload> {
  const seams = __localUploadSeamsForTests;
  const realRoot = await seams.realpath(root);
  const expected = path.join(realRoot, ...segments);
  // A symlink anywhere below the root (a middle directory included) makes the
  // resolved path differ from the joined one.
  if ((await seams.realpath(expected)) !== expected) {
    throw new LocalUploadError("symlink", "The upload path must not pass through a symlink.");
  }

  // O_NOFOLLOW refuses a final symlink (ELOOP). O_NONBLOCK: opening a FIFO
  // must not wait for a writer; the regular-file check below then refuses it.
  const handle = await fs.open(expected, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  try {
    if (!(await handle.stat()).isFile()) {
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
    // Read to end of file in chunks, hashing each, so the result is the whole
    // file whatever fstat said (it may have grown or shrunk since), and stop
    // as soon as it passes the limit. One hash update per chunk keeps every
    // call far under the hash's 2 GiB input limit.
    const hash = createHash("sha256");
    const chunks: Buffer[] = [];
    let size = 0;
    for (;;) {
      const chunk = Buffer.alloc(Math.min(READ_CHUNK_BYTES, maxBytes + 1 - size));
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, null);
      if (bytesRead === 0) break;
      size += bytesRead;
      if (size > maxBytes) throw new LocalUploadError("too-large", `The file is larger than ${maxBytes} bytes.`);
      const filled = chunk.subarray(0, bytesRead);
      hash.update(filled);
      chunks.push(filled);
    }
    return { bytes: Buffer.concat(chunks, size), sha256: hash.digest("hex"), size, name: segments[segments.length - 1] };
  } finally {
    await handle.close();
  }
}
