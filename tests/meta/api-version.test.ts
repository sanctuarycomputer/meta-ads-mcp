import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import {
  DEFAULT_META_API_VERSION,
  assertMetaApiVersion,
  isMetaApiVersionAtLeast,
  resolveMetaApiVersion,
} from "../../src/meta/api-version.js";
import { MetaApiClient } from "../../src/meta/client.js";

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

describe("resolveMetaApiVersion", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("targets Graph API v27.0 when META_API_VERSION is unset", () => {
    vi.stubEnv("META_API_VERSION", undefined);
    expect(DEFAULT_META_API_VERSION).toBe("v27.0");
    expect(resolveMetaApiVersion()).toBe("v27.0");
  });

  it("accepts v27.0 from META_API_VERSION, ignoring surrounding whitespace", () => {
    vi.stubEnv("META_API_VERSION", " v27.0 ");
    expect(resolveMetaApiVersion()).toBe("v27.0");
  });

  it("falls back to the default when META_API_VERSION is blank", () => {
    vi.stubEnv("META_API_VERSION", "  ");
    expect(resolveMetaApiVersion()).toBe("v27.0");
  });

  // Graph v27.0 only (design §2; fork review M8): an older version answers
  // with error #2635, and a newer one is a deliberate bump of the default.
  const REFUSED = ["v26.0", "v26.9", "v9.0", "v27.1", "v28.0"];

  it.each(REFUSED)("refuses META_API_VERSION=%s, a version other than v27.0", (value) => {
    vi.stubEnv("META_API_VERSION", value);
    expect(() => resolveMetaApiVersion()).toThrow(/v27\.0/);
    expect(() => resolveMetaApiVersion()).toThrow(/META_API_VERSION/);
  });

  // Not of the form vN.N: refused by the pattern, naming the variable (final-1b R4).
  it.each(["v27", "27.0", "v100.0", "garbage", "V27.0", "v27.0.1"])("refuses META_API_VERSION=%s", (value) => {
    vi.stubEnv("META_API_VERSION", value);
    expect(() => resolveMetaApiVersion()).toThrow(/META_API_VERSION/);
  });

  it.each(REFUSED)("refuses %s as a client version", (value) => {
    expect(() => assertMetaApiVersion(value)).toThrow(/v27\.0/);
    expect(() => new MetaApiClient({ apiVersion: value })).toThrow(/v27\.0/);
  });

  it("accepts v27.0 as a client version", () => {
    expect(assertMetaApiVersion("v27.0")).toBe("v27.0");
    expect(new MetaApiClient({ apiVersion: "v27.0" }).apiVersion).toBe("v27.0");
  });

  // The version is interpolated into every request path, including the OAuth
  // helpers that build URLs with `new URL(path, base)`.
  it.each([
    "v26.0/../v22.0",
    "v26.0?debug=all",
    "/evil.example/x",
    "26.0",
    "latest",
  ])("refuses META_API_VERSION=%s instead of building requests with it", (value) => {
    vi.stubEnv("META_API_VERSION", value);
    expect(() => resolveMetaApiVersion()).toThrow(/META_API_VERSION/);
  });
});

describe("isMetaApiVersionAtLeast", () => {
  it.each([
    ["v26.0", "v26.0", true],
    ["v25.0", "v26.0", false],
    ["v26.1", "v26.0", true],
    ["v100.0", "v26.0", true],
    ["v9.0", "v26.0", false],
  ])("%s is at least %s: %s", (version, minimum, expected) => {
    expect(isMetaApiVersionAtLeast(version, minimum)).toBe(expected);
  });
});

// Every value assigned to META_API_VERSION in a file, in the forms these files
// use: dotenv, docker-compose defaults, and YAML mappings.
function versionPins(content: string): string[] {
  return [
    ...content.matchAll(
      /META_API_VERSION\s*(?:=|:(?!-))\s*["']?(?:\$\{META_API_VERSION:-)?([^\s"'}]+)/g,
    ),
  ].map((match) => match[1]);
}

// Production ran every call on v22.0 while the code defaulted to v25.0: the
// deploy workflow pinned the env var and nobody bumped it. The deploy action
// merges env vars, so removing the pin would not reset it either — every pin
// has to move together with the code default.
describe("META_API_VERSION pins", () => {
  it.each([
    ["META_API_VERSION=v22.0", ["v22.0"]],
    ['META_API_VERSION="v22.0"', ["v22.0"]],
    ["META_API_VERSION = v22.0", ["v22.0"]],
    ["  META_API_VERSION: 'v22.0'", ["v22.0"]],
    ["- META_API_VERSION=${META_API_VERSION:-v22.0}", ["v22.0"]],
    ["META_API_VERSION=v26.0\nMETA_API_VERSION=v22.0", ["v26.0", "v22.0"]],
  ])("finds the pinned value in %j", (content, expected) => {
    expect(versionPins(content)).toEqual(expected);
  });

  it.each([
    ".github/workflows/deploy.yml",
    "docker-compose.yml",
    ".env.example",
    "README.md",
  ])("%s pins the version the code defaults to", (file) => {
    const pins = versionPins(readFileSync(join(ROOT, file), "utf8"));

    expect(pins.length).toBeGreaterThan(0);
    expect(new Set(pins)).toEqual(new Set([DEFAULT_META_API_VERSION]));
  });
});
