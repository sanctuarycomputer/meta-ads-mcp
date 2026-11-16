/**
 * Helpers for the stdio egress test (done-when 2): network spies that never
 * reach the network, the canned Graph answer, and an argument builder that
 * reads a tool's input schema.
 */
import dns from "node:dns";
import http from "node:http";
import https from "node:https";
import { syncBuiltinESMExports } from "node:module";
import net from "node:net";
import tls from "node:tls";

/** Ends every poll at once: reports complete, videos ready. No access_token field. */
export const GRAPH_ANSWER = {
  id: "123",
  data: [],
  paging: {},
  success: true,
  async_status: "Job Completed",
  async_percent_completion: 100,
  report_run_id: "123",
  status: { video_status: "ready" },
};

/** The fixed public address the patched DNS answers with, without the network. */
export const FAKE_ADDRESS = "93.184.216.34";

export interface RecordedRequest {
  url: URL;
  headers: Headers;
  body: unknown;
}

export interface EgressSpies {
  connects: string[];
  dns: string[];
  requests: RecordedRequest[];
  restore(): void;
}

type AnyFn = (...args: unknown[]) => unknown;

function hostOfRequestArgs(args: unknown[]): string {
  const first = args[0];
  if (typeof first === "string") return safeHost(first);
  if (first instanceof URL) return first.hostname;
  if (first && typeof first === "object") {
    const o = first as { hostname?: string; host?: string };
    return o.hostname ?? o.host ?? "localhost";
  }
  return "localhost";
}

function safeHost(raw: string): string {
  try {
    return new URL(raw).hostname;
  } catch {
    return raw;
  }
}

function hostOfConnectArgs(args: unknown[]): string {
  const first = Array.isArray(args[0]) ? (args[0] as unknown[])[0] : args[0];
  if (first && typeof first === "object") {
    const o = first as { host?: string; path?: string; servername?: string };
    return o.host ?? o.servername ?? o.path ?? "localhost";
  }
  if (typeof args[1] === "string") return args[1];
  if (typeof first === "string") return first; // a unix socket path
  return "localhost";
}

/**
 * Patches every way out by hand (saved originals, not vi.spyOn, which the
 * config's restoreMocks would undo between tests). Nothing connects: a socket
 * or TLS connect records its host and then errors, http(s) requests record
 * and throw, fetch records and answers GRAPH_ANSWER, and DNS answers
 * FAKE_ADDRESS.
 */
export function installEgressSpies(): EgressSpies {
  const connects: string[] = [];
  const lookups: string[] = [];
  const requests: RecordedRequest[] = [];

  const saved = {
    fetch: globalThis.fetch,
    httpRequest: http.request,
    httpGet: http.get,
    httpsRequest: https.request,
    httpsGet: https.get,
    socketConnect: net.Socket.prototype.connect,
    tlsConnect: tls.connect,
    dnsLookup: dns.lookup,
    dnsPromisesLookup: dns.promises.lookup,
  };

  globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const headers = new Headers(input instanceof Request ? input.headers : undefined);
    new Headers(init?.headers).forEach((v, k) => headers.set(k, v));
    requests.push({ url, headers, body: init?.body });
    return new Response(JSON.stringify(GRAPH_ANSWER), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as typeof fetch;

  const blockedRequest = (scheme: string) =>
    ((...args: unknown[]) => {
      connects.push(hostOfRequestArgs(args));
      throw new Error(`egress blocked in test: ${scheme} request`);
    }) as AnyFn;
  (http as { request: unknown }).request = blockedRequest("http");
  (http as { get: unknown }).get = blockedRequest("http");
  (https as { request: unknown }).request = blockedRequest("https");
  (https as { get: unknown }).get = blockedRequest("https");

  net.Socket.prototype.connect = function (this: net.Socket, ...args: unknown[]) {
    connects.push(hostOfConnectArgs(args));
    process.nextTick(() => this.destroy(new Error("egress blocked in test: socket connect")));
    return this;
  } as typeof net.Socket.prototype.connect;

  (tls as { connect: unknown }).connect = ((...args: unknown[]) => {
    connects.push(hostOfConnectArgs(args));
    const socket = new tls.TLSSocket(new net.Socket());
    process.nextTick(() => socket.destroy(new Error("egress blocked in test: tls connect")));
    return socket;
  }) as AnyFn;

  (dns as { lookup: unknown }).lookup = ((hostname: string, ...rest: unknown[]) => {
    lookups.push(hostname);
    const cb = rest[rest.length - 1] as (err: Error | null, address: unknown, family?: number) => void;
    const opts = rest.length > 1 ? (rest[0] as { all?: boolean } | number) : undefined;
    const all = typeof opts === "object" && opts?.all === true;
    process.nextTick(() =>
      all ? cb(null, [{ address: FAKE_ADDRESS, family: 4 }]) : cb(null, FAKE_ADDRESS, 4),
    );
  }) as AnyFn;

  (dns.promises as { lookup: unknown }).lookup = (async (hostname: string, opts?: { all?: boolean } | number) => {
    lookups.push(hostname);
    const answer = { address: FAKE_ADDRESS, family: 4 };
    return typeof opts === "object" && opts?.all === true ? [answer] : answer;
  }) as AnyFn;

  syncBuiltinESMExports();

  return {
    connects,
    dns: lookups,
    requests,
    restore() {
      globalThis.fetch = saved.fetch;
      (http as { request: unknown }).request = saved.httpRequest;
      (http as { get: unknown }).get = saved.httpGet;
      (https as { request: unknown }).request = saved.httpsRequest;
      (https as { get: unknown }).get = saved.httpsGet;
      net.Socket.prototype.connect = saved.socketConnect;
      (tls as { connect: unknown }).connect = saved.tlsConnect;
      (dns as { lookup: unknown }).lookup = saved.dnsLookup;
      (dns.promises as { lookup: unknown }).lookup = saved.dnsPromisesLookup;
      syncBuiltinESMExports();
    },
  };
}

export interface JSONSchema {
  type?: string | string[];
  properties?: Record<string, JSONSchema>;
  required?: string[];
  items?: JSONSchema;
  minItems?: number;
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  minimum?: number;
  format?: string;
  anyOf?: JSONSchema[];
  oneOf?: JSONSchema[];
  allOf?: JSONSchema[];
  default?: unknown;
}

/** Tried in order for a string with a pattern; a caller URL is always on the test host. */
export const PATTERN_CANDIDATES = ["act_1", "123", "1_2", "https://cdn.example.test/a.jpg", "2026-01-01", "x"];

function sampleValue(schema: JSONSchema, name: string): unknown {
  if (schema.const !== undefined) return schema.const;
  if (schema.anyOf?.length) return sampleValue(schema.anyOf[0], name);
  if (schema.oneOf?.length) return sampleValue(schema.oneOf[0], name);
  if (schema.allOf?.length) return sampleValue(schema.allOf[0], name);
  if (schema.enum?.length) return schema.enum[0];
  const type = Array.isArray(schema.type) ? schema.type.find((t) => t !== "null") : schema.type;
  switch (type) {
    case "string": {
      if (schema.pattern) {
        const re = new RegExp(schema.pattern);
        const hit = PATTERN_CANDIDATES.find((c) => re.test(c));
        return hit ?? "x";
      }
      if (isUrlish(name, schema)) return "https://cdn.example.test/a.jpg";
      // The schemas carry no id patterns: an id is shaped by its name.
      if (/^(ad_)?account_ids?$/.test(name)) return "act_1";
      if (/(^|_)ids?$/.test(name)) return "123";
      if (schema.format === "date") return "2026-01-01";
      return "x";
    }
    case "number":
    case "integer":
      return schema.minimum ?? 1;
    case "boolean":
      return false;
    case "array": {
      const n = Math.max(1, schema.minItems ?? 1);
      return Array.from({ length: n }, () => sampleValue(schema.items ?? {}, name));
    }
    case "object":
      return sampleArgs(schema);
    default:
      return "x";
  }
}

/** A property that carries a caller URL: named `url`, `*_url(s)`, `*Url`, or of format uri. */
function isUrlish(name: string, schema: JSONSchema): boolean {
  return schema.format === "uri" || /(^|_)urls?$/i.test(name) || /Urls?$/.test(name);
}

/** Whether a URL-carrying property sits anywhere below this schema. */
function holdsUrl(schema: JSONSchema, depth = 0): boolean {
  if (depth > 6) return false;
  const branches = [...(schema.anyOf ?? []), ...(schema.oneOf ?? []), ...(schema.allOf ?? [])];
  if (schema.items) branches.push(schema.items);
  for (const [name, sub] of Object.entries(schema.properties ?? {})) {
    if (isUrlish(name, sub) || holdsUrl(sub, depth + 1)) return true;
  }
  return branches.some((b) => holdsUrl(b, depth + 1));
}

/**
 * Required properties, plus every property that is or holds a caller URL at
 * any depth (so the egress run sees every URL a tool could forward or look
 * up). Overrides replace whole top-level values.
 */
export type Override = Record<string, unknown> | ((sampled: Record<string, unknown>) => Record<string, unknown>);

/** An override key set to undefined drops that key; a function rewrites the sampled arguments. */
export function sampleArgs(schema: JSONSchema, override: Override = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const props = schema.properties ?? {};
  const required = new Set(schema.required ?? []);
  for (const [name, sub] of Object.entries(props)) {
    if (required.has(name) || isUrlish(name, sub) || holdsUrl(sub)) out[name] = sampleValue(sub, name);
  }
  const merged = typeof override === "function" ? override(out) : { ...out, ...override };
  return Object.fromEntries(Object.entries(merged).filter(([, v]) => v !== undefined));
}

/** Reads the access token a Graph request carries, wherever the client put it. */
export function tokenOf(req: RecordedRequest): string | undefined {
  const auth = req.headers.get("authorization");
  if (auth?.startsWith("Bearer ")) return auth.slice("Bearer ".length);
  const fromQuery = req.url.searchParams.get("access_token");
  if (fromQuery !== null) return fromQuery;
  const body = req.body;
  if (body instanceof URLSearchParams) return body.get("access_token") ?? undefined;
  if (body instanceof FormData) {
    const v = body.get("access_token");
    return typeof v === "string" ? v : undefined;
  }
  if (typeof body === "string") {
    try {
      const parsed = JSON.parse(body) as { access_token?: unknown };
      if (typeof parsed.access_token === "string") return parsed.access_token;
    } catch {
      return new URLSearchParams(body).get("access_token") ?? undefined;
    }
  }
  return undefined;
}
