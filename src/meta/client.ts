import { createHmac } from "node:crypto";
import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js";
import { getAccessToken, hashToken } from "../auth/token-store.js";
import { logger } from "../utils/logger.js";
import { RateLimiter, type RequestContext } from "./rate-limiter.js";
import { CircuitBreaker, type CircuitContext } from "./circuit-breaker.js";
import { WritePacer } from "./write-pacer.js";
import {
  classifyMetaError,
  isMetaApiError,
  type MetaErrorClassification,
} from "./errors.js";
import type { MetaApiError, MetaApiResponse } from "./types/common.js";
import { collectAllPages } from "./paginator.js";
import { assertMetaApiVersion, resolveMetaApiVersion } from "./api-version.js";
import { isCredentialName, scrubCredentialsDeep, scrubErrorCredentials } from "../utils/scrub-credentials.js";
import { ENDPOINTS, VIDEO_HOST, WriteRefusal, hostAllowed, matchEndpoint, type GraphGet } from "./write-descriptor.js";
import { RealWriteGate, callContext, type CallContext, type WriteGate } from "./write-guard.js";

// An error answer can quote the request, its token included (a Page token
// while a Page action runs). It is cleaned before anything classifies, logs
// or returns it.
const withoutToken = scrubCredentialsDeep;

const DEFAULT_BASE_URL = "https://graph.facebook.com";
const DEFAULT_TIMEOUT = 30000;
const MAX_RETRIES = 3;
const RETRY_BASE_DELAY = 1000;
const USAGE_LOG_INTERVAL_MS = 60_000;
const VERSION_WARNING_LOG_INTERVAL_MS = 60 * 60_000;

export interface MetaApiClientConfig {
  apiVersion?: string;
  baseUrl?: string;
  timeout?: number;
  maxRetries?: number;
  /**
   * TEST-ONLY. Builds the write gate in place of the real one (RealWriteGate around this client's own reads),
   * so a test can give it its own guard runner, or pass every write. Never passed under src/: a test asserts it.
   */
  writeGateForTests?: (get: GraphGet) => WriteGate;
}

// ─── Client refusals (contract docs/contracts/meta-ads-guard.md §2) ─────────

// The joined path, `/<version><path>`: letters, digits and _ between single slashes, nothing else.
const PLAIN_PATH = /^\/(v\d+\.\d+\/)?[A-Za-z0-9_]+(\/[A-Za-z0-9_]+)*$/;
const OVERRIDE_NAMES: ReadonlySet<string> = new Set(["method", "_method"]);
const BATCH_NAMES: ReadonlySet<string> = new Set(["batch", "async_batch"]);
const READ_POST = new RegExp(ENDPOINTS.read_post);

const isReadServer = (): boolean => process.env.META_ADS_READ_ONLY === "1";

/**
 * Refuses, with `WriteRefusal`, a request the client never sends on either server (contract §2): a method
 * override or a Graph batch parameter (any case), a repeated multipart name, an `async_batch_requests` segment, a
 * joined path (`/<version><path>`, checked raw, before `new URL` folds it) that is not plain, a base URL that is not
 * https on a listed host with no port or userinfo, or that is not exactly `https://<host>` (what is checked is
 * what the URL is built from), or whose host takes only other requests (`hostAllowed`, contract 1.1 §2: the video
 * host takes only `POST /act_{id}/advideos`); a field named `__proto__`, `constructor` or `prototype`; and on the read
 * server (`META_ADS_READ_ONLY=1`) any method but GET, except an insights report POST (`ENDPOINTS.read_post`).
 * Nothing it says quotes the path or a value.
 */
export function checkRequestShape(
  method: string,
  baseUrl: string,
  joined: string,
  params: Readonly<Record<string, unknown>>,
  multipartNames?: readonly string[],
): void {
  for (const key of [...Object.keys(params), ...(multipartNames ?? [])]) {
    assertFieldName(key);
    const k = key.toLowerCase();
    if (OVERRIDE_NAMES.has(k)) throw new WriteRefusal(`a parameter named ${key} would override the HTTP method`);
    if (BATCH_NAMES.has(k)) throw new WriteRefusal(`a parameter named ${key} is a Graph batch`);
  }
  if (multipartNames) {
    const seen = new Set<string>();
    for (const name of multipartNames) {
      if (seen.has(name)) throw new WriteRefusal(`the multipart field ${JSON.stringify(name.slice(0, 60))} is repeated`);
      seen.add(name);
    }
  }
  if (joined.split(/[/?#]/).some((seg) => seg.toLowerCase() === "async_batch_requests")) {
    throw new WriteRefusal("the path has an async_batch_requests segment (a Graph batch)");
  }
  if (!PLAIN_PATH.test(joined)) {
    throw new WriteRefusal("the path is not a plain Graph path (letters, digits and _ between single slashes)");
  }
  let base: URL;
  try {
    base = new URL(baseUrl);
  } catch {
    throw new WriteRefusal("the base URL is not a URL");
  }
  if (base.protocol !== "https:") throw new WriteRefusal("the base URL is not https");
  if (!ENDPOINTS.host_list.includes(base.hostname)) throw new WriteRefusal(`the host ${base.hostname} is not on the host list`);
  if (base.port !== "") throw new WriteRefusal("the base URL has a port");
  if (base.username !== "" || base.password !== "") throw new WriteRefusal("the base URL has userinfo");
  // The URL is built by joining this string: it must be the origin itself, with no path, query, fragment or slash.
  if (baseUrl !== `https://${base.hostname}`) throw new WriteRefusal("the base URL is not exactly https:// and its host");
  // Contract 1.1 §2 (C14), after the checks above (their order and messages stand): a host with rows takes only them.
  if (!hostAllowed(method, base.host, joined)) {
    throw new WriteRefusal(`the host ${base.host} takes only ${(ENDPOINTS.host_rows[base.host] ?? []).join(", ")}`);
  }
  if (isReadServer() && method !== "GET" && !(method === "POST" && READ_POST.test(joined))) {
    const path = joined.replace(/^\/v\d+\.\d+/, "");
    throw new WriteRefusal(`this server is read-only: ${method} ${path} is neither a GET nor an insights report`);
  }
}

// ─── Decoded params: one source for the descriptor and the wire (P8) ────────

// Form strings that hold JSON objects the descriptor reads: decoded when they start with { or [.
const JSON_FORM_KEYS: ReadonlySet<string> = new Set(["creative", "cells", "objectives", ...Object.keys(ENDPOINTS.sub_keys)]);
/** The placeholder a multipart file stands as in decoded params. */
export const MULTIPART_FILE = "<file>";

// Field names that reach an object's prototype slot: assigned, they vanish from the params or change them.
const PROTOTYPE_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype"]);

function assertFieldName(name: string): void {
  if (PROTOTYPE_NAMES.has(name)) throw new WriteRefusal(`a field named ${name} is not allowed`);
}

// Every field name at any depth, and every number finite: what is described is what is sent.
function assertSendable(key: string, v: unknown): void {
  if (typeof v === "number" && !Number.isFinite(v)) throw new WriteRefusal(`${key} holds a number that cannot be sent (${String(v)})`);
  if (Array.isArray(v)) for (const item of v) assertSendable(key, item);
  else if (v !== null && typeof v === "object") {
    for (const [k, item] of Object.entries(v)) {
      assertFieldName(k);
      assertSendable(key, item);
    }
  }
}

// The written text of a JSON number is sent again as JSON.stringify writes the parsed value: refused unless the
// two are one number (an integer past 2^53 or a long decimal has already lost digits, 1e999 is Infinity).
function exactNumber(source: string | undefined, v: number): boolean {
  if (!Number.isFinite(v)) return false;
  if (source === undefined) return Number.isSafeInteger(v) || !Number.isInteger(v);
  if (String(v) === source) return true;
  return /^-?\d+$/.test(source) && Number.isInteger(v) && BigInt(source) === BigInt(v);
}

function decodeFormValue(key: string, value: unknown): unknown {
  if (typeof value !== "string" || !JSON_FORM_KEYS.has(key)) return value;
  const text = value.trimStart();
  if (!text.startsWith("{") && !text.startsWith("[")) return value;
  let parsed: unknown;
  let inexact = false;
  try {
    // The reviver's third argument holds the number's source text (Node 21+).
    const reviver = (_k: string, v: unknown, context?: { source?: string }): unknown => {
      if (typeof v === "number" && !exactNumber(context?.source, v)) inexact = true;
      return v;
    };
    parsed = JSON.parse(value, reviver as (this: unknown, k: string, v: unknown) => unknown);
  } catch {
    throw new WriteRefusal(`${key} is not valid JSON`);
  }
  if (inexact) throw new WriteRefusal(`${key} holds a number that cannot be sent exactly as written (send ids as strings)`);
  assertSendable(key, parsed);
  return parsed;
}

/** A form's params, decoded (contract §3 reads objects, not form strings); `access_token` and unset values dropped. */
export function decodeForm(params: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || isAccessTokenName(key)) continue;
    assertFieldName(key);
    const decoded = decodeFormValue(key, value);
    assertSendable(key, decoded);
    out[key] = decoded;
  }
  return out;
}

/** One form value as sent: a string as it is, an object or array as JSON, anything else as its string. */
function encodeValue(value: unknown): string {
  return typeof value === "string" ? value : value !== null && typeof value === "object" ? JSON.stringify(value) : String(value);
}

/** Decoded params as an `application/x-www-form-urlencoded` body. */
export function encodeForm(params: Readonly<Record<string, unknown>>): URLSearchParams {
  const form = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && !isAccessTokenName(key)) form.set(key, encodeValue(value));
  }
  return form;
}

// The first refusal of each call, rethrown as it was to every later write of the call.
const firstRefusal = new WeakMap<CallContext, WriteRefusal>();

// A refusal is the call's refusal: the first one is kept on the context (contract §10: the tool returns the reason).
function noted<E>(ctx: CallContext | undefined, e: E): E {
  if (ctx && e instanceof WriteRefusal && ctx.refusal === null) {
    ctx.refusal = scrubbedText(e.message);
    firstRefusal.set(ctx, e);
  }
  return e;
}

// Calls whose validate-only stop refused a later write (rule 2's not-sent line), and calls whose result is shaped.
const heldCalls = new WeakSet<CallContext>();
const closedCalls = new WeakSet<CallContext>();

/** Whether the validate-only stop refused a write of this call (the write was held back, not sent). */
export function validateOnlyHeld(ctx: CallContext): boolean {
  return heldCalls.has(ctx);
}

/** Marks a call finished: its result is shaped, so any write it still makes is refused (nothing could report it). */
export function closeCall(ctx: CallContext): void {
  closedCalls.add(ctx);
}

// Decoding a write's params can refuse it (unreadable JSON): that refusal is the call's too.
function decodedIn(decode: () => Record<string, unknown>): Record<string, unknown> {
  try {
    return decode();
  } catch (e) {
    throw noted(callContext.getStore(), e);
  }
}

const VALIDATE_ONLY = ["validate_only"];
const VALIDATE_ONLY_FORM = JSON.stringify(VALIDATE_ONLY);

type Encoded = { url: string; init?: RequestInit };

interface RequestScope {
  accountId?: string;
  // A call with a hard end, for work that has to fit a deadline: it is never
  // retried, it is not sent at all if pacing would hold it past this many
  // milliseconds, and it gives up on an answer that takes longer.
  timeoutMs?: number;
  // Sent once. A retried write whose first answer was lost can come back
  // refused, which would read as "nothing was written" when it may have been.
  noRetry?: boolean;
  // The request carries personal data, which Meta's error text can quote:
  // only Meta's code and subcode are logged and returned.
  withholdMessage?: boolean;
}

// The app secret, trimmed as every reader of it trims. Without it no Graph
// request is sent: Meta can only tell a stolen token from ours by the proof.
function requireAppSecret(): string {
  const secret = process.env.META_APP_SECRET?.trim();
  if (!secret) {
    throw new Error("META_APP_SECRET is not set: every Graph request must carry appsecret_proof.");
  }
  return secret;
}

// Visible ASCII only: what Meta issues, and what a header value can carry.
const HEADER_SAFE_TOKEN = /^[\x21-\x7e]+$/;

// The token travels only in the header: a field of this name, in any letter
// case, is dropped from every query and body.
function isAccessTokenName(name: string): boolean {
  return name.toLowerCase() === "access_token";
}

// The caller's headers, whatever their form, with the client's Authorization
// as the only one: a caller's own, in any letter case, is dropped.
function withAuthorization(headers: HeadersInit | undefined, auth: { Authorization: string }): Record<string, string> {
  const entries = headers instanceof Headers
    ? [...headers.entries()]
    : Array.isArray(headers) ? headers : Object.entries(headers ?? {});
  const merged: Record<string, string> = {};
  for (const [name, value] of entries) {
    if (name.toLowerCase() !== "authorization") merged[name] = value;
  }
  return { ...merged, ...auth };
}

/**
 * Signs one Graph request (fork review M1, M2): sets `appsecret_proof`, the
 * HMAC-SHA256 of the token keyed by the app secret, on `url`, removes any
 * `access_token` from it, and returns the header that carries the token.
 * The token is never put in a query or a body. Throws, before anything is
 * sent, when META_APP_SECRET is missing.
 */
export function signGraphRequest(url: URL, token: string): { Authorization: string } {
  const secret = requireAppSecret();
  // Sent and signed as one value: surrounding whitespace is trimmed, and a
  // token a header can't carry is refused here. fetch would otherwise throw
  // an error that quotes the whole "Bearer <token>" value.
  const sent = token.trim();
  if (!HEADER_SAFE_TOKEN.test(sent)) {
    throw new Error("The Meta access token can't be sent: it is empty or holds whitespace, a control character or a non-ASCII character.");
  }
  for (const name of [...url.searchParams.keys()]) {
    if (isAccessTokenName(name)) url.searchParams.delete(name);
  }
  url.searchParams.set("appsecret_proof", createHmac("sha256", secret).update(sent).digest("hex"));
  return { Authorization: `Bearer ${sent}` };
}

// An error whose text was written here, with nothing of the request or the
// answer in it.
class WithheldError extends Error {}

// Keeps only what cannot quote the request: Meta's code and subcode.
function withheld(error: MetaApiError): MetaApiError {
  const code = Number.isInteger(error.code) ? error.code : 0;
  const subcode = Number.isInteger(error.error_subcode) ? error.error_subcode : undefined;
  return {
    code,
    error_subcode: subcode,
    type: "",
    message: `code ${code}${subcode !== undefined ? `, subcode ${subcode}` : ""}; Meta's text is withheld because the request carried personal data`,
  };
}

// Rejects with `late()` once `until` passes, unless `work` settles first.
async function settleBy<T>(work: Promise<T>, until: number, late: () => Error): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const deadline = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(late()), Math.max(0, until - Date.now()));
  });
  work.catch(() => {});
  try {
    return await Promise.race([work, deadline]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Typed client for the Meta Graph API.
 *
 * Compliance guarantees (see src/meta/errors.ts and rate-limiter.ts for
 * references to Meta's docs):
 *  - Bucketed rate-limiting per (token, ad-account, use-case type) — one hot
 *    account does not slow down the rest of the agency.
 *  - Circuit breaker halts requests to a bucket on abuse signals
 *    (subcode 1996), temporary user/business blocks, or repeated throttle.
 *  - Platform/BUC rate-limit errors (4, 17, 32, 613, 80000-80014) are NEVER
 *    retried inside the same request — Meta's docs explicitly warn that
 *    continuing to call after a throttle extends `estimated_time_to_regain_access`.
 *  - Write operations (POST/DELETE) are paced by a preventive token bucket
 *    sized to the Ads Management hourly quota.
 *  - Every response's rate-limit headers update per-bucket state for future
 *    self-throttling decisions.
 */
export class MetaApiClient {
  readonly apiVersion: string;
  private readonly baseUrl: string;
  private readonly timeout: number;
  private readonly maxRetries: number;
  private readonly rateLimiter = new RateLimiter();
  private readonly circuitBreaker = new CircuitBreaker();
  private readonly writePacer = new WritePacer();
  private lastUsageLogAt = 0;
  private lastVersionWarningAt = 0;
  private readonly writeGate: WriteGate;

  constructor(config?: MetaApiClientConfig) {
    this.apiVersion = assertMetaApiVersion(config?.apiVersion ?? resolveMetaApiVersion());
    this.baseUrl = config?.baseUrl ?? DEFAULT_BASE_URL;
    this.timeout = config?.timeout ?? DEFAULT_TIMEOUT;
    this.maxRetries = config?.maxRetries ?? MAX_RETRIES;
    // The descriptor's reads go through this client's own GET: signed, limited and shape-checked like any other.
    const get: GraphGet = <T>(path: string, params: Record<string, string | number>) => this.get<T>(path, params);
    this.writeGate = config?.writeGateForTests ? config.writeGateForTests(get) : new RealWriteGate(get);
    // A server given its token must also be given the secret to sign with,
    // or it doesn't start. Only the env is read here: asking the token store
    // would load the token registry as a side effect of construction.
    if (process.env.META_ACCESS_TOKEN?.trim()) requireAppSecret();
  }

  async get<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    scope?: RequestScope,
  ): Promise<T> {
    const url = this.buildUrl("GET", path, params);
    return this.execute<T>("GET", url, path, params ?? {}, undefined, scope);
  }

  async post<T>(
    path: string,
    body?: Record<string, unknown>,
  ): Promise<T> {
    const decoded = decodedIn(() => {
      const out = body === undefined
        ? {}
        : Object.fromEntries(Object.entries(body).filter(([key]) => !isAccessTokenName(key)));
      for (const [key, value] of Object.entries(out)) {
        assertFieldName(key);
        assertSendable(key, value);
      }
      return out;
    });
    return this.sendWrite<T>("POST", path, decoded, VALIDATE_ONLY, (p) => ({
      url: this.buildUrl("POST", path),
      init: {
        headers: { "Content-Type": "application/json" },
        // No body and nothing added: sent as before, with no body at all.
        body: body === undefined && Object.keys(p).length === 0 ? undefined : JSON.stringify(p),
      },
    }));
  }

  async postForm<T>(
    path: string,
    params: Record<string, string | number | boolean>,
    scope?: RequestScope,
  ): Promise<T> {
    return this.sendWrite<T>("POST", path, decodedIn(() => decodeForm(params)), VALIDATE_ONLY_FORM, (p) => ({
      url: this.buildUrl("POST", path),
      init: {
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: encodeForm(p).toString(),
      },
    }), scope);
  }

  async postMultipart<T>(
    path: string,
    formData: FormData,
  ): Promise<T> {
    // The token travels only in the header.
    for (const name of [...new Set(formData.keys())]) {
      if (isAccessTokenName(name)) formData.delete(name);
    }
    const names = [...formData.keys()];
    const decoded = decodedIn(() => {
      const out: Record<string, unknown> = {};
      for (const [name, value] of formData.entries()) {
        assertFieldName(name);
        out[name] = typeof value === "string" ? decodeFormValue(name, value) : MULTIPART_FILE;
      }
      return out;
    });
    return this.sendWrite<T>("POST", path, decoded, VALIDATE_ONLY_FORM, (p) => {
      // The caller's form goes as it is; only execution_options is added to it.
      if (p.execution_options !== undefined && !formData.has("execution_options")) {
        formData.append("execution_options", encodeValue(p.execution_options));
      }
      return { url: this.buildUrl("POST", path), init: { body: formData } };
    }, undefined, names);
  }

  /**
   * A DELETE. Its params go in the query, or with `formBody` in an `application/x-www-form-urlencoded` body (for
   * values that must never be in a URL).
   */
  async delete<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    scope?: RequestScope,
    opts?: { formBody?: boolean },
  ): Promise<T> {
    return this.sendWrite<T>("DELETE", path, decodedIn(() => decodeForm(params ?? {})), VALIDATE_ONLY_FORM, (p) =>
      opts?.formBody
        ? {
          url: this.buildUrl("DELETE", path),
          init: { headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: encodeForm(p).toString() },
        }
        : { url: this.buildUrl("DELETE", path, Object.fromEntries(Object.entries(p).map(([k, v]) => [k, encodeValue(v)]))) },
    scope);
  }

  async getPaginated<T>(
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
    maxItems = 1000,
  ): Promise<T[]> {
    const firstPage = await this.get<MetaApiResponse<T>>(path, params);
    if (!firstPage.data) return [];
    return collectAllPages<T>(
      firstPage,
      async (after) =>
        this.get<MetaApiResponse<T>>(path, { ...params, after }),
      maxItems,
    );
  }

  /**
   * One GET kept apart from everything this client shares between requests,
   * for a read that only words a result. Nothing it receives reaches the rate
   * limiter, the write pacer or the circuit breaker, and it is never retried,
   * so it cannot change what a later request does. It reads that state only
   * to abstain: with the circuit open, or while the limiter would wait, it
   * resolves to undefined without calling Meta. Any failure to read is
   * undefined too; a request the client never sends (checkRequestShape: its
   * callers pass digit and act_ paths with a fields param) throws the
   * WriteRefusal instead.
   * The caller owns the deadline: aborting `signal` cancels the body as well.
   * The caller also names the token. This method never asks for the current
   * one: where the active token is process-wide it can change between two
   * awaits, and a caller that keys what it learns by token must be the one
   * to fix it.
   */
  async getDetached<T>(
    path: string,
    params: Record<string, string | number | boolean | undefined>,
    signal: AbortSignal,
    token: string,
  ): Promise<T | undefined> {
    // A request it must never send is refused, not quietly dropped.
    checkRequestShape("GET", this.baseFor("GET", this.joined(path)), this.joined(path), params);
    const tokenHash = hashToken(token);
    const accountId = extractAccountId(path);
    if (this.circuitBreaker.isOpen({ tokenHash, accountId, type: guessBucType("GET", path) })) return undefined;
    if (this.rateLimiter.getThrottleDelay({ tokenHash, accountId }) > 0) return undefined;

    const url = new URL(this.buildUrl("GET", path, params));
    let auth: { Authorization: string };
    try {
      auth = signGraphRequest(url, token);
    } catch (err) {
      // Either refusal of signGraphRequest: no app secret, or a token that
      // can't be sent. Neither message quotes the token.
      logger.debug({ event: "meta_detached_unsigned", path }, `Detached read not sent: ${(err as Error).message}`);
      return undefined;
    }
    const response = await fetch(url.toString(), { method: "GET", signal, redirect: "error", headers: auth });
    const body = (await response.json()) as unknown;
    if (!response.ok || isMetaApiError(body)) return undefined;
    return body as T;
  }

  /** The whole process's state, every tenant's: for tests and the logs. */
  getUsageSnapshot() {
    return {
      usage: this.rateLimiter.snapshot(),
      circuits: this.circuitBreaker.snapshot(),
      writePacer: this.writePacer.snapshot(),
    };
  }

  /**
   * One token's state, for the `ads_rate_status` tool. Every key carries the
   * token hash in a fixed position: `kind:token:…` for usage buckets,
   * `token:…` for circuits and write-pacer buckets.
   */
  getUsageSnapshotFor(tokenHash: string) {
    const { usage, circuits, writePacer } = this.getUsageSnapshot();
    return {
      usage: usage.filter((b) => b.key.split(":")[1] === tokenHash),
      circuits: circuits.filter((c) => c.key.split(":")[0] === tokenHash),
      writePacer: writePacer.filter((w) => w.key.split(":")[0] === tokenHash),
    };
  }

  resetForTests(): void {
    this.rateLimiter.reset();
    this.circuitBreaker.reset();
    this.writePacer.reset();
    this.lastUsageLogAt = 0;
    this.lastVersionWarningAt = 0;
  }

  // ─── Internal ────────────────────────────────────────────────

  /** The raw `/<version><path>` the URL is built from, before `new URL` normalises it. */
  private joined(path: string): string {
    return `/${this.apiVersion}${path.startsWith("/") ? path : `/${path}`}`;
  }

  /**
   * The one way a write reaches Meta (contract §2, §9). `decoded` is the write's params as the descriptor reads
   * them and `encode` turns them into the request, so what the guard is asked about is what is sent. In order: the
   * shape check; on the read server an insights report goes straight out (its only allowed write); a refused or
   * stopped call refuses; `execution_options` is the server's to add (under validate_only); the gate decides;
   * the request is sent; the outcome is recorded once. Every refusal but the validate-only stop is the call's.
   */
  private async sendWrite<T>(
    method: "POST" | "DELETE",
    path: string,
    decoded: Record<string, unknown>,
    validateOnlyValue: unknown,
    encode: (params: Record<string, unknown>) => Encoded,
    scope?: RequestScope,
    multipartNames?: readonly string[],
  ): Promise<T> {
    const ctx = callContext.getStore();
    if (ctx && closedCalls.has(ctx)) throw new WriteRefusal("the tool call already returned");
    try {
      checkRequestShape(method, this.baseFor(method, this.joined(path)), this.joined(path), decoded, multipartNames);
    } catch (e) {
      throw noted(ctx, e);
    }
    if (isReadServer()) {
      // Only an insights report POST passes the shape check here, and the read server never runs the guard.
      const { url, init } = encode(decoded);
      return this.execute<T>(method, url, path, decoded, init, scope);
    }

    if (ctx && ctx.refusal !== null) throw firstRefusal.get(ctx) ?? new WriteRefusal("an earlier write in this call was refused");
    if (ctx?.validateOnlyStop) {
      heldCalls.add(ctx);
      throw new WriteRefusal("validate_only: later steps need the first write's result and were not sent");
    }

    const reqPath = path.startsWith("/") ? path : `/${path}`;
    let params: Record<string, unknown>;
    let gate: { requestId: string; label: SentWriteLabel };
    let encoded: Encoded;
    try {
      // Any letter case, and any bracket form (execution_options[0]) Graph would read as the same field.
      if (Object.keys(decoded).some((k) => /^execution_options($|\[)/i.test(k))) {
        throw new WriteRefusal("execution_options is set by the server for validate_only, never by the caller");
      }
      params = ctx?.validateOnly ? { ...decoded, execution_options: validateOnlyValue } : decoded;
      gate = await this.writeGate.check({ method, path: reqPath, params }, ctx);
      encoded = encode(params);
    } catch (e) {
      throw noted(ctx, e);
    }

    let result: T;
    try {
      result = await this.execute<T>(method, encoded.url, path, params, encoded.init, scope);
    } catch (e) {
      const error = scrubbedMessage(e);
      if (!(e instanceof WriteRefusal)) ctx?.sent.push({ method, path: reqPath, label: gate.label, ok: false, answer: error });
      await this.recordOutcome(ctx, gate.requestId, { ok: false, metaId: null, error });
      throw noted(ctx, e);
    } finally {
      if (ctx?.validateOnly) ctx.validateOnlyStop = true;
    }
    const answer = result as unknown;
    const metaId = answer !== null && typeof answer === "object" && typeof (answer as { id?: unknown }).id === "string"
      ? (answer as { id: string }).id
      : null;
    ctx?.sent.push({ method, path: reqPath, label: gate.label, ok: true, answer: scrubbedAnswer(answer) });
    await this.recordOutcome(ctx, gate.requestId, { ok: true, metaId, error: null });
    return result;
  }

  private async recordOutcome(
    ctx: CallContext | undefined,
    requestId: string,
    r: { ok: boolean; metaId: string | null; error: string | null },
  ): Promise<void> {
    const warning = await this.writeGate.outcome(requestId, r);
    if (warning !== null) ctx?.warnings.push(warning);
  }

  /**
   * The base URL a request goes to (contract 1.1 §2, `host_rows`): a `POST` matching the row
   * `POST /act_{id}/advideos` goes to the video host; every other request to this client's base URL. The row is a
   * POST row, so matching it with the request's own method is the method test too.
   */
  private baseFor(method: string, joinedPath: string): string {
    if (matchEndpoint(method, joinedPath, "video")?.id === "POST /act_{id}/advideos") {
      return `https://${VIDEO_HOST}`;
    }
    return this.baseUrl;
  }

  private buildUrl(
    method: string,
    path: string,
    params?: Record<string, string | number | boolean | undefined>,
  ): string {
    const joined = this.joined(path);
    const url = new URL(`${this.baseFor(method, joined)}${joined}`);

    if (params) {
      for (const [key, value] of Object.entries(params)) {
        if (value !== undefined) {
          url.searchParams.set(key, String(value));
        }
      }
    }

    return url.toString();
  }

  private async execute<T>(
    method: string,
    url: string,
    path: string,
    params: Readonly<Record<string, unknown>>,
    options?: RequestInit,
    scope?: RequestScope,
  ): Promise<T> {
    const ctx = callContext.getStore();
    const multipartNames = options?.body instanceof FormData ? [...options.body.keys()] : undefined;
    try {
      checkRequestShape(method, this.baseFor(method, this.joined(path)), this.joined(path), params, multipartNames);
    } catch (e) {
      throw noted(ctx, e);
    }
    const token = getAccessToken();
    // Signed before anything else: without the secret nothing is sent, and
    // no pacing or limiter state changes.
    const signedUrl = new URL(url);
    const auth = signGraphRequest(signedUrl, token);
    // The URL carries only what the request named, and the proof.
    const named = new Set([...Object.keys(params), "appsecret_proof"]);
    if ([...signedUrl.searchParams.keys()].some((k) => !named.has(k))) {
      throw noted(ctx, new WriteRefusal("the URL carries a query parameter the request did not name"));
    }
    const pathAccount = extractAccountId(path);
    if (ctx && pathAccount?.startsWith("act_")) ctx.accounts.add(pathAccount);
    const reqUrl = signedUrl.toString();
    const tokenHash = hashToken(token);
    const accountId = scope?.accountId ?? extractAccountId(path);
    const context: RequestContext = { tokenHash, accountId };
    const circuitContext: CircuitContext = {
      tokenHash,
      accountId,
      type: guessBucType(method, path),
    };

    // Circuit breaker is the hard stop: if open, never call Meta.
    this.circuitBreaker.assertClosed(circuitContext);

    const endBy = scope?.timeoutMs !== undefined ? Date.now() + scope.timeoutMs : undefined;
    // A bounded call that pacing would hold too long is not sent: Meta never
    // sees it, so it is reported as refused, not as an unknown outcome.
    const beforeSending = (wait: Promise<void>) => endBy === undefined
      ? wait
      : settleBy(wait, endBy, () => new McpError(ErrorCode.InvalidRequest, `Not sent: ${method} ${path} would have waited on rate limits past its ${scope?.timeoutMs} ms limit.`));

    // Preventive write pacing for POST / DELETE on account-scoped paths.
    const isWrite =
      (method === "POST" || method === "DELETE") &&
      accountId !== undefined;
    if (isWrite) {
      await beforeSending(this.writePacer.acquire(tokenHash, accountId));
    }

    // Reactive self-throttle based on last-known usage headers.
    await beforeSending(this.rateLimiter.waitIfNeeded(context));

    // POST to /act_<id>/<collection> creates new resources without native
    // idempotency on Meta's side — retrying a timeout/5xx/network error can
    // mint duplicates (e.g. two ad sets for one user intent). The /<id>/copies
    // edge (ad/ad set/campaign duplication) creates a resource on a non-act_
    // path, so it must be classed as creating too — otherwise a retried copy
    // mints a duplicate ad. The WhatsApp creating edges live on plain-numeric
    // WABA/phone paths: /message_templates, /flows, /message_qrdls create
    // resources, and /request_code sends a real SMS/voice call — all mint
    // duplicates on retry. A Page's /leadgen_forms creates a lead form the
    // same way, /photos a Page photo, and a form's /test_leads a test lead
    // (one per form: a retry after a lost answer is refused as a second one).
    // Other POSTs (updates on /<id>) and DELETEs are idempotent at the API
    // level.
    const isCreatingRequest =
      method === "POST" &&
      (/^\/?act_[A-Za-z0-9]+\//.test(path) ||
        /\/copies$/.test(path) ||
        /\/(message_templates|flows|message_qrdls|request_code|leadgen_forms|photos|test_leads|ad_studies)$/.test(path));
    const canRetryTransport = !isCreatingRequest;
    const maxRetries = endBy === undefined && !scope?.noRetry ? this.maxRetries : 0;
    const timeout = endBy === undefined ? this.timeout : Math.max(1, endBy - Date.now());

    let lastError: Error | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(
          () => controller.abort(),
          timeout,
        );

        const response = await fetch(reqUrl, {
          method,
          ...options,
          headers: withAuthorization(options?.headers, auth),
          redirect: "error",
          signal: controller.signal,
        });

        // A bounded call keeps its abort armed until the answer is read.
        if (endBy === undefined) clearTimeout(timeoutId);

        // Update rate-limiter + pacer from response headers — regardless of
        // whether the response was OK. Throttle signals travel on error
        // responses too.
        this.rateLimiter.updateFromHeaders(response.headers, context);
        this.maybeUpdatePacerTierFromHeaders(response.headers, tokenHash, accountId);
        this.maybeLogUsage();
        // Header text is not logged for a call that carries personal data.
        if (!scope?.withholdMessage) this.maybeLogVersionWarning(response.headers, token);

        // A bounded call's limit covers reading the answer too, and running
        // out of it cancels the transfer.
        let body: unknown;
        try {
          body = endBy === undefined
            ? await response.json()
            : await settleBy(response.json() as Promise<unknown>, endBy, () => {
              controller.abort();
              return new Error(`Request timeout after ${scope?.timeoutMs}ms`);
            });
        } finally {
          clearTimeout(timeoutId);
        }

        if (isMetaApiError(body)) {
          const metaError = scope?.withholdMessage ? withheld(body.error) : withoutToken(body.error, token);
          const classification = classifyMetaError(metaError);
          this.logMetaError(metaError, classification, context, path);

          if (classification.throttled) {
            // Seed the rate-limiter with the retry-after hint so sibling
            // requests back off even before the next header arrives.
            if (classification.retryAfterMs) {
              this.rateLimiter.markRetryAfter(
                context,
                circuitContext.type ?? "unknown",
                classification.retryAfterMs,
              );
            }
            this.circuitBreaker.trip(circuitContext, classification);
            // Meta's doc: "If you reach the limit, stop making API calls."
            throw classification.mcpError;
          }

          if (classification.retryable && canRetryTransport && attempt < maxRetries) {
            lastError = classification.mcpError;
            await this.backoff(attempt);
            continue;
          }

          throw classification.mcpError;
        }

        if (!response.ok) {
          lastError = scope?.withholdMessage
            ? new WithheldError(`HTTP ${response.status} (the answer is withheld: the request carried personal data)`)
            : new Error(`HTTP ${response.status}: ${JSON.stringify(withoutToken(body, token))}`);
          if (response.status >= 500 && canRetryTransport && attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        return body as T;
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          lastError = new Error(`Request timeout after ${timeout}ms`);
          if (canRetryTransport && attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Anything not written here may quote the request or the answer: the
        // JSON parser's message quotes the body it could not read.
        if (scope?.withholdMessage && !(error instanceof McpError) && !(error instanceof WithheldError)) {
          const kind = error instanceof Error && /^[A-Za-z]{1,40}$/.test(error.name) ? error.name : "Error";
          lastError = new WithheldError(`${kind} on ${method} ${path}; its text is withheld because the request carried personal data`);
          if (canRetryTransport && attempt < maxRetries) {
            await this.backoff(attempt);
            continue;
          }
          throw lastError;
        }

        // Already-classified errors bubble up unchanged, but a transport
        // error with a code is not one of them, and may quote the request.
        if (error instanceof Error && "code" in error) {
          throw scrubErrorCredentials(error, token);
        }

        lastError = error instanceof Error ? scrubErrorCredentials(error, token) : new Error(withoutToken(String(error), token));
        if (canRetryTransport && attempt < maxRetries) {
          await this.backoff(attempt);
          continue;
        }
        throw lastError;
      }
    }

    logger.error({ error: lastError, path }, "All retries exhausted");
    throw lastError ?? new Error("Request failed after retries");
  }

  private async backoff(attempt: number): Promise<void> {
    const delay = RETRY_BASE_DELAY * Math.pow(2, attempt);
    const jitter = delay * (Math.random() * 0.4 - 0.2); // ±20%
    await new Promise((resolve) => setTimeout(resolve, delay + jitter));
  }

  private maybeUpdatePacerTierFromHeaders(
    headers: Headers,
    tokenHash: string,
    accountId: string | undefined,
  ): void {
    if (!accountId) return;
    const throttle = headers.get("x-fb-ads-insights-throttle");
    if (throttle) {
      try {
        const parsed = JSON.parse(throttle) as { ads_api_access_tier?: string };
        if (parsed.ads_api_access_tier) {
          this.writePacer.updateTier(tokenHash, accountId, parsed.ads_api_access_tier);
        }
      } catch {
        /* ignore */
      }
    }
    const acc = headers.get("x-ad-account-usage");
    if (acc) {
      try {
        const parsed = JSON.parse(acc) as { ads_api_access_tier?: string };
        if (parsed.ads_api_access_tier) {
          this.writePacer.updateTier(tokenHash, accountId, parsed.ads_api_access_tier);
        }
      } catch {
        /* ignore */
      }
    }
  }

  private logMetaError(
    error: { code: number; error_subcode?: number; message: string; fbtrace_id?: string },
    classification: MetaErrorClassification,
    context: RequestContext,
    path: string,
  ): void {
    const payload = {
      event: "meta_error",
      path,
      meta_error_code: error.code,
      meta_subcode: error.error_subcode,
      fbtrace_id: error.fbtrace_id,
      category: classification.category,
      throttled: classification.throttled,
      retryAfterMs: classification.retryAfterMs,
      tokenHash: context.tokenHash,
      accountId: context.accountId,
    };
    if (classification.critical) {
      logger.fatal(payload, error.message);
    } else if (
      classification.category === "invalid_params" ||
      classification.category === "duplicate"
    ) {
      // 4xx user-side — count as user_errors signal (Insights formula subtracts
      // 0.001 × user_errors from hourly quota).
      logger.warn({ ...payload, event: "meta_user_error" }, error.message);
    } else {
      logger.error(payload, error.message);
    }
  }

  // Meta answers calls on a retired Marketing API version by upgrading the
  // endpoints that did not change and rejecting the ones that did. The header
  // only arrives once the version is gone, so it means the pin is already
  // overdue rather than about to be.
  private maybeLogVersionWarning(headers: Headers, token: string): void {
    const raw = headers.get("x-ad-api-version-warning");
    if (!raw) return;
    const warning = withoutToken(raw, token);
    const now = Date.now();
    if (now - this.lastVersionWarningAt < VERSION_WARNING_LOG_INTERVAL_MS) return;
    this.lastVersionWarningAt = now;
    logger.warn(
      { event: "meta_api_version_auto_upgraded", apiVersion: this.apiVersion },
      `Meta auto-upgraded a call because ${this.apiVersion} is deprecated: bump DEFAULT_META_API_VERSION in src/meta/api-version.ts. Meta said: ${warning}`,
    );
  }

  private maybeLogUsage(): void {
    const now = Date.now();
    if (now - this.lastUsageLogAt < USAGE_LOG_INTERVAL_MS) return;
    this.lastUsageLogAt = now;
    const snapshot = this.rateLimiter.snapshot();
    if (snapshot.length === 0) return;
    const tier = snapshot.find((b) => b.adsApiAccessTier)?.adsApiAccessTier;
    logger.info(
      {
        event: "meta_rate_usage",
        buckets: snapshot.length,
        maxCallPct: snapshot.reduce((m, b) => Math.max(m, b.callCount), 0),
        adsApiAccessTier: tier,
      },
      "Meta API usage snapshot",
    );
    if (tier === "development_access") {
      logger.warn(
        { event: "meta_access_tier" },
        "Running on development_access tier — apply for Advanced Access to raise the Ads Management / Insights quota",
      );
    }
  }
}

type SentWriteLabel = CallContext["sent"][number]["label"];

// A message for the outcome record and the call's list of writes: one line, no credential, no token.
const QUOTED_FIELD = /"([^"\\]{1,64})"\s*:\s*"(?:[^"\\]|\\.)*"/g;

function scrubbedText(text: string): string {
  let token: string | undefined;
  try {
    token = getAccessToken();
  } catch {
    token = undefined;
  }
  // A credential-named field quoted as JSON inside the text ("access_token":"…"), which the name=value scrub misses.
  let out = scrubCredentialsDeep(text, token).replace(QUOTED_FIELD, (m, name: string) =>
    isCredentialName(name) ? `"${name}":"[REDACTED]"` : m);
  // The proof too, where it stands bare (not as appsecret_proof=…, which the scrub already removes).
  const secret = process.env.META_APP_SECRET?.trim();
  if (token && secret) {
    const proof = createHmac("sha256", secret).update(token.trim()).digest("hex");
    out = out.split(proof).join("[REDACTED]");
  }
  return out.replace(/\s+/g, " ").trim();
}

/** Meta's answer to a write as one line of text: scrubbed as JSON (credential-named fields by key) and then as text. */
function scrubbedAnswer(answer: unknown): string {
  let token: string | undefined;
  try {
    token = getAccessToken();
  } catch {
    token = undefined;
  }
  return scrubbedText(JSON.stringify(withoutToken(answer, token)) ?? "");
}

function scrubbedMessage(e: unknown): string {
  return scrubbedText(e instanceof Error ? e.message : String(e));
}

/**
 * Extract the first id-like segment after the API version. For account-scoped
 * paths like `/act_123/insights` or `/act_123/campaigns`, returns `act_123`.
 * For `/<object_id>/insights` etc., returns `<object_id>`.
 */
function extractAccountId(path: string): string | undefined {
  const stripped = path.startsWith("/") ? path.slice(1) : path;
  const [first] = stripped.split("/");
  if (!first) return undefined;
  if (/^act_\d+$/i.test(first)) return first;
  if (/^\d+$/.test(first)) return first;
  return undefined;
}

/**
 * Best-effort hint for which BUC pool a request counts against. Used to scope
 * circuit-breaker state — a throttle on Insights should not freeze Audience
 * writes for the same account.
 */
function guessBucType(method: string, path: string): string {
  if (/\/insights(\?|$|\/)/.test(path) || /\/insights$/.test(path)) {
    return "ads_insights";
  }
  if (/\/customaudiences(\?|$|\/)/.test(path) || path.includes("/customaudiences")) {
    return "custom_audience";
  }
  if (method === "POST" || method === "DELETE") {
    return "ads_management";
  }
  return "ads_management";
}

/**
 * Singleton client instance used by all tools.
 */
export const metaApiClient = new MetaApiClient();
