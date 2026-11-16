// M-tokens (spec check 4; plan task 9): the four token tools stay registered but refuse before any request, no tool
// takes a credential parameter, and tokens.ts reaches none of the OAuth, token-manager or token-repo modules.
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { CATALOGUE, createServer } from "../../src/server.js";
import * as repo from "../../src/store/meta-token-repo.js";
import { tokenManager } from "../../src/auth/token-manager.js";
import { isCredentialName } from "../../src/utils/scrub-credentials.js";
import { connect, type ToolResult } from "../tools/validate-only-helpers.js";
import { textOf } from "../tools/validate-only-helpers.js";

const NAMES = ["ads_list_tokens", "ads_set_active_token", "ads_register_token", "ads_delete_token"];
const REPO_FUNCTIONS = ["saveToken", "setDefaultToken", "deleteToken", "listTokens", "getDecryptedToken", "getDefaultTokenName"] as const;
const saved = process.env.META_ADS_TOOLSETS;

let fetchSpy: ReturnType<typeof vi.fn>;
beforeEach(() => {
  delete process.env.META_ADS_TOOLSETS;
  fetchSpy = vi.fn(async () => {
    throw new Error("no request may be sent");
  });
  vi.stubGlobal("fetch", fetchSpy);
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  if (saved === undefined) delete process.env.META_ADS_TOOLSETS;
  else process.env.META_ADS_TOOLSETS = saved;
});

describe("the token tools refuse", () => {
  it.each(NAMES)("%s: the error result, no request, no token store or manager call", async (name) => {
    // Built at run time: no secret-shaped literal.
    const token = ["EA", "x".repeat(30)].join("");
    const repoSpies = REPO_FUNCTIONS.map((f) => vi.spyOn(repo, f));
    const managerSpies = (["registerToken", "setActiveToken", "listTokens"] as const).map((f) => vi.spyOn(tokenManager, f));
    const { client, close } = await connect(createServer(CATALOGUE));
    try {
      const r = (await client.callTool({ name, arguments: { bm_name: "a", access_token: token } })) as ToolResult;
      expect(r.isError).toBe(true);
      expect(r.content).toEqual([{ type: "text", text: "removed in this fork" }]);
      expect(textOf(r)).not.toContain(token);
    } finally {
      await close();
    }
    expect(fetchSpy).not.toHaveBeenCalled();
    for (const spy of [...repoSpies, ...managerSpies]) expect(spy).not.toHaveBeenCalled();
  });

  it("the four names stay registered, each with an empty input schema and the one-line description", async () => {
    const { client, close } = await connect(createServer(CATALOGUE));
    try {
      const tools = (await client.listTools()).tools;
      for (const name of NAMES) {
        const tool = tools.find((t) => t.name === name)!;
        expect(tool, name).toBeDefined();
        expect(tool.description).toMatch(/^(⚠️[^\n]*?)?Removed in this fork\.$/);
        expect(Object.keys(tool.inputSchema.properties ?? {}).filter((k) => k !== "validate_only")).toEqual([]);
      }
    } finally {
      await close();
    }
  });
});

describe("no tool takes a caller's token", () => {
  it("no input schema property of any catalogue tool is a credential name", async () => {
    const { client, close } = await connect(createServer(CATALOGUE));
    try {
      const tools = (await client.listTools()).tools;
      expect(tools.length).toBeGreaterThan(NAMES.length);
      const bad: string[] = [];
      const walk = (tool: string, node: unknown): void => {
        if (Array.isArray(node)) return node.forEach((n) => walk(tool, n));
        if (node === null || typeof node !== "object") return;
        const o = node as Record<string, unknown>;
        for (const [k, v] of Object.entries((o.properties as Record<string, unknown>) ?? {})) {
          if (isCredentialName(k)) bad.push(`${tool}.${k}`);
          walk(tool, v);
        }
        for (const [k, v] of Object.entries(o)) if (k !== "properties") walk(tool, v);
      };
      for (const t of tools) walk(t.name, t.inputSchema);
      expect(bad).toEqual([]);
    } finally {
      await close();
    }
  });

  it("the check sees a credential name (the name list decides the case above)", () => {
    expect(isCredentialName("access_token")).toBe(true);
    expect(isCredentialName("account_id")).toBe(false);
  });

  it("tokens.ts imports none of auth/meta-oauth, auth/token-manager, store/meta-token-repo", () => {
    const src = readFileSync(new URL("../../src/tools/tokens.ts", import.meta.url), "utf8");
    const imports = [...src.matchAll(/(?:from|import)\s*\(?\s*["']([^"']+)["']/g)].map((m) => m[1]);
    expect(imports.length).toBeGreaterThan(0);
    for (const spec of imports) expect(spec).not.toMatch(/meta-oauth|token-manager|meta-token-repo/);
  });
});
