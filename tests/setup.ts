/**
 * Shared test helpers and mocks.
 */
import { vi } from "vitest";
import { STALE_IN_PROGRESS_MS, type CloneBundleRecord, type CloneBundleStore } from "../src/store/clone-bundle-store.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";

/**
 * A clone-bundle store that claims to persist, kept in a map. The fork's own
 * store never persists (254 M6), so ads_duplicate_ad refuses a real run; tests
 * of that run install this double with configureCloneBundleStoreForTests.
 */
export function persistentCloneBundleStore(): CloneBundleStore {
  const map = new Map<string, CloneBundleRecord>();
  return {
    persistent: true,
    getDoc: async (key) => map.get(key),
    claim: async (key, signature, options = {}) => {
      const existing = map.get(key);
      const stale = existing !== undefined && options.reclaimStale !== false
        && existing.state === "in_progress" && Date.now() - existing.startedAt > STALE_IN_PROGRESS_MS;
      if (existing && !stale) return { status: "duplicate", existing };
      map.set(key, { cacheKey: key, signature, state: "in_progress", startedAt: Date.now(), createdResources: { creativeIds: [], adIds: [] } });
      return { status: "claimed" };
    },
    update: async (key, partial) => {
      const existing = map.get(key);
      if (existing) map.set(key, { ...existing, ...partial });
    },
  };
}

/** The app secret the tests sign with: every Graph request needs one. */
export const TEST_APP_SECRET = "test-app-secret";

/**
 * Set META_ACCESS_TOKEN so getAccessToken() doesn't throw, and
 * META_APP_SECRET so requests can be signed with appsecret_proof.
 */
export function setupTestToken(token = "test-access-token"): void {
  process.env.META_ACCESS_TOKEN = token;
  process.env.META_APP_SECRET = TEST_APP_SECRET;
}

/**
 * Remove test env vars.
 */
export function cleanupTestToken(): void {
  delete process.env.META_ACCESS_TOKEN;
  delete process.env.META_APP_SECRET;
}

/** The token a request sent, read from its `Authorization: Bearer` header. */
export function bearerTokenOf(init?: RequestInit): string | null {
  const headers = init?.headers;
  if (!headers) return null;
  const value = headers instanceof Headers
    ? headers.get("authorization")
    : Object.entries(headers as Record<string, string>).find(([name]) => name.toLowerCase() === "authorization")?.[1];
  const match = /^Bearer (.+)$/.exec(value ?? "");
  return match ? match[1] : null;
}

/**
 * Create a mock fetch Response.
 */
export function mockFetchResponse(
  body: unknown,
  options: { status?: number; headers?: Record<string, string> } = {},
): Response {
  const { status = 200, headers = {} } = options;
  const responseHeaders = new Headers(headers);
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: responseHeaders,
    json: async () => body,
    text: async () => JSON.stringify(body),
  } as unknown as Response;
}

/**
 * Stub fetch for a write followed by the account-currency lookup: every POST
 * gets `write`, GET /act_<id> gets `account`, any other GET gets `entity`.
 */
export function stubWriteAndCurrencyLookup(responses: {
  write: unknown;
  account?: unknown;
  entity?: unknown;
}): void {
  const refused = { error: { code: 100, type: "OAuthException", message: "Unsupported get request." } };
  vi.stubGlobal("fetch", vi.fn(async (url: string, init?: RequestInit) => {
    if (init?.method === "POST") return mockFetchResponse(responses.write);
    const body = /\/act_\d+$/.test(new URL(url).pathname) ? responses.account : responses.entity;
    return body === undefined ? mockFetchResponse(refused, { status: 400 }) : mockFetchResponse(body);
  }));
}

/** The fetch calls made so far, as "METHOD /path" without the API version. */
export function fetchCallSummary(): string[] {
  return vi.mocked(fetch).mock.calls.map(([url, init]) =>
    `${init?.method ?? "GET"} ${new URL(String(url)).pathname.replace(/^\/v[\d.]+/, "")}`);
}

interface RegisteredTool {
  name: string;
  description: string;
  schema: unknown;
  annotations?: ToolAnnotations;
  handler: (...args: unknown[]) => Promise<unknown>;
}

/**
 * Create a mock McpServer that records tool registrations.
 *
 * Supports both the legacy `server.tool(name, description, schema, handler)` API
 * and the modern `server.registerTool(name, config, handler)` API used in v3.
 */
export function createMockMcpServer() {
  const tools: RegisteredTool[] = [];

  const registerTool = vi.fn(
    (
      name: string,
      config: {
        description?: string;
        inputSchema?: unknown;
        annotations?: ToolAnnotations;
      },
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => {
      tools.push({
        name,
        description: config.description ?? "",
        schema: config.inputSchema,
        annotations: config.annotations,
        handler,
      });
    },
  );

  const tool = vi.fn(
    (
      name: string,
      description: string,
      schema: unknown,
      handler: (...args: unknown[]) => Promise<unknown>,
    ) => {
      tools.push({ name, description, schema, handler });
    },
  );

  const server = {
    tool,
    registerTool,
    _registeredTools: tools,
  };

  return server;
}
