// Shared by tests/tools/validate-only*.test.ts (ticket 253, Task 6): served tools through createServer and an
// in-memory MCP client, a fake Graph (GETs from a world, writes from `onWrite`), and the guard's record. Each test
// file mocks the client singleton itself (vi.mock is per file) with a real gate whose runner reads `guardEnv`.
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import type { Descriptor } from "../../src/meta/write-descriptor.js";
import { answerGet } from "../fixtures/meta-ads-guard/harness.js";
import { mockFetchResponse } from "../setup.js";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const STUB = join(ROOT, "tests/fixtures/meta-ads-guard/stubs/record-allow.mjs");

export const ACT = "act_9990000000000001";
const ACT_DIGITS = "9990000000000001";
export const CAMP = "9994000000000001";
export const ADSET = "9995000000000001";
export const BUSINESS = "9993000000000001";

export const LABEL = {
  documented: "Meta documents validate_only here; it checked the write and should have changed nothing",
  unconfirmed: "Meta does not document validate_only here; the write may have taken effect, check it",
  contradicted: "Meta ignores validate_only here; if the guard allowed it, the write took effect",
} as const;
export const NOT_SENT = "validate_only: later steps need the first write's result and were not sent";
export const NO_WRITE = "validate_only: no write was sent";

export interface Sent {
  method: string;
  path: string;
  init?: RequestInit;
}

export const fake = {
  calls: [] as Sent[],
  world: new Map<string, unknown>(),
  onWrite: (_c: Sent): Promise<Response> | Response => mockFetchResponse({ success: true }),
};

export const graphError = (message: string) =>
  mockFetchResponse({ error: { code: 100, type: "OAuthException", message } }, { status: 400 });

export function smallWorld(): Map<string, unknown> {
  return new Map<string, unknown>([
    [`/${ACT}`, { id: ACT, metadata: { type: "adaccount" }, spend_cap: "500000", amount_spent: "0", currency: "USD", business: { id: BUSINESS } }],
    [`/${CAMP}`, { id: CAMP, metadata: { type: "campaign" }, account_id: ACT_DIGITS, name: "c", status: "PAUSED", effective_status: "PAUSED", buying_type: "AUCTION", spend_cap: "100000" }],
    [`/${ADSET}`, { id: ADSET, metadata: { type: "adset" }, account_id: ACT_DIGITS, status: "PAUSED", campaign_id: CAMP, daily_budget: "1000" }],
  ]);
}

export function installFetch(): void {
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string, init?: RequestInit) => {
      const url = new URL(input);
      const c: Sent = { method: init?.method ?? "GET", path: url.pathname.replace(/^\/v\d+\.\d+/, ""), init };
      fake.calls.push(c);
      if (c.method !== "GET") return fake.onWrite(c);
      const params: Record<string, string> = {};
      for (const [k, v] of url.searchParams) if (k !== "appsecret_proof") params[k] = v;
      try {
        return mockFetchResponse(answerGet(fake.world, c.path, params));
      } catch (e) {
        return graphError((e as Error).message);
      }
    }),
  );
}

export const writes = (): Sent[] => fake.calls.filter((c) => c.method !== "GET");
export const formOf = (c: Sent): URLSearchParams => new URLSearchParams(String(c.init?.body ?? ""));

// ---- the guard and its record ----

let dir = "";
export const guardLog = (): string => join(dir, "guard.log");

/** A fresh record file and the stub as the guard command; `opts` are the stub's arguments (REFUSE_TOOL=, NACK). */
export function useGuard(env: NodeJS.ProcessEnv, ...opts: string[]): void {
  dropGuard();
  dir = mkdtempSync(join(tmpdir(), "vo-"));
  env.PATH = process.env.PATH;
  env.HOME = process.env.HOME ?? "/tmp";
  env.META_WRITE_GUARD_CMD = ["node", STUB, guardLog(), ...opts].join(" ");
}

export function dropGuard(): void {
  if (dir) rmSync(dir, { recursive: true, force: true });
  dir = "";
}

const records = (): Array<Record<string, unknown>> =>
  existsSync(guardLog()) ? readFileSync(guardLog(), "utf8").trim().split("\n").map((l) => JSON.parse(l) as Record<string, unknown>) : [];
export const descriptors = (): Descriptor[] => records().filter((r) => !("outcome_for" in r)) as unknown as Descriptor[];

// ---- the served tools ----

export async function connect(server: McpServer) {
  const client = new Client({ name: "test", version: "0" });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(b), client.connect(a)]);
  return {
    client,
    close: async () => {
      await client.close();
      await server.close();
    },
  };
}

export interface ToolResult {
  isError?: boolean;
  content: Array<{ type: string; text?: string }>;
}

export const textOf = (r: ToolResult): string => r.content.map((c) => c.text ?? "").join("\n");
