/**
 * The static sweeps behind the egress test (done-whens 2 and 5) see every
 * ordinary way to load a module, call fetch or read the env, and are not
 * fooled by comments or strings (task-6 TN2-TN4).
 */
import { describe, it, expect } from "vitest";
import { envReads, fetchNames, moduleLoads, normaliseSpecifier } from "./static-sweep.js";

const loads = (text: string) => moduleLoads("f.ts", text);
const reads = (text: string) => envReads("f.ts", text);

describe("moduleLoads", () => {
  it.each([
    ['import http from "node:http";', "node:http"],
    ['import{request}from"node:https"', "node:https"],
    ['import x, { y } from "net";', "net"],
    ['import * as tls from "node:tls";', "node:tls"],
    ['import "node:dgram";', "node:dgram"],
    ['export * from "node:http2";', "node:http2"],
    ['export { lookup } from "node:dns/promises";', "node:dns/promises"],
    ['import type from "undici";', "undici"],
    ['import {\n  type A,\n  request,\n} from "node:http";', "node:http"],
    ['const m = await import("node:child_process");', "node:child_process"],
    ['const m = require("express");', "express"],
    ['const m = process.getBuiltinModule("node:net");', "node:net"],
    ['import fs = require("node:http");', "node:http"],
  ])("sees %j", (text, spec) => {
    expect(loads(text).specs).toContain(spec);
  });

  it.each([
    'import type { Agent } from "node:http";',
    'import { type Agent } from "node:http";',
    'export type { Agent } from "node:http";',
    '// import http from "node:http";',
    'const s = "image/*"; const t = "*/";',
    'const s = "import(\\"node:http\\")";',
  ])("does not count %j", (text) => {
    expect(loads(text).specs).not.toContain("node:http");
    expect(loads(text).dynamic).toEqual([]);
  });

  it("does not let a string holding a comment opener hide a later import", () => {
    expect(loads('const s = "image/*";\nimport http from "node:http";\nconst t = "*/";').specs).toContain("node:http");
  });

  it.each([
    "const m = await import(name);",
    "const m = require(`node:${x}`);",
    'import { createRequire } from "node:module"; const r = createRequire(import.meta.url);',
    "const m = process.getBuiltinModule(name);",
  ])("flags the non-literal load in %j", (text) => {
    expect(loads(text).dynamic.length).toBeGreaterThan(0);
  });

  it("normalises node: prefixes and subpaths", () => {
    expect(normaliseSpecifier("node:dns/promises")).toBe("dns");
    expect(normaliseSpecifier("@google-cloud/firestore/build/x")).toBe("@google-cloud/firestore");
    expect(normaliseSpecifier("express")).toBe("express");
  });
});

describe("fetchNames", () => {
  it.each([
    'await fetch("https://x");',
    "const f = globalThis.fetch; await f(u);",
    "await fetch.call(null, u);",
    "await fetch?.(u);",
    "const { fetch } = globalThis;",
    "await deps.fetch(u);",
    "await config.fetch(u);",
    "await doFetch(u);",
  ])("sees %j", (text) => {
    expect(fetchNames("f.ts", text).length).toBeGreaterThan(0);
  });

  it.each(["// fetch(u)", 'const s = "we never fetch( this";', "deps.fetchImages(u);", "/** the next fetch */ const a = 1;"])(
    "does not count %j",
    (text) => {
      expect(fetchNames("f.ts", text)).toEqual([]);
    },
  );
});

describe("envReads", () => {
  it.each([
    ["const a = process.env.LOG_LEVEL;", "LOG_LEVEL"],
    ['const a = process.env["LOG_LEVEL"];', "LOG_LEVEL"],
    ['const a = process["env"].LOG_LEVEL;', "LOG_LEVEL"],
    ["const a = globalThis.process.env.LOG_LEVEL;", "LOG_LEVEL"],
    ["const e = process.env; const a = e.LOG_LEVEL;", "LOG_LEVEL"],
    ['const e = process.env; const a = e["LOG_LEVEL"];', "LOG_LEVEL"],
    ["const { env } = process; const a = env.LOG_LEVEL;", "LOG_LEVEL"],
    ['const { env: v } = process; const a = v["LOG_LEVEL"];', "LOG_LEVEL"],
    ['import { env } from "node:process"; const a = env["LOG_LEVEL"];', "LOG_LEVEL"],
    ['import p from "node:process"; const a = p.env.LOG_LEVEL;', "LOG_LEVEL"],
    ["const p = process; const a = p.env.LOG_LEVEL;", "LOG_LEVEL"],
    ["const { LOG_LEVEL } = process.env;", "LOG_LEVEL"],
    ["const { env } = process; const { LOG_LEVEL } = env;", "LOG_LEVEL"],
    ["function f(env = process.env) { return env.LOG_LEVEL; }", "LOG_LEVEL"],
    ["function f(env: NodeJS.ProcessEnv) { return env.LOG_LEVEL; }", "LOG_LEVEL"],
    ["const a = process.env.log_level;", "log_level"],
  ])("reads %j", (text, name) => {
    expect(reads(text).names).toContain(name);
  });

  it.each([
    "const a = process.env[name];",
    "const all = { ...process.env };",
    "spawn(cmd, { env: process.env });",
    "const { ...rest } = process.env;",
    'import { env } from "node:process"; const a = env[k];',
  ])("calls %j opaque", (text) => {
    expect(reads(text).opaque.length).toBeGreaterThan(0);
  });

  it("ignores comments and strings", () => {
    expect(reads('// process.env.LOG_LEVEL\nconst s = "process.env.X";')).toEqual({ names: [], opaque: [] });
  });
});
