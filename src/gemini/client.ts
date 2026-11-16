import { resolveTenantId } from "../auth/tenant.js";

/**
 * 254 M7: Gemini is removed from this fork. The module keeps the names and
 * types other files import, and every path that would send a request (or
 * resolve a key to send one) throws GeminiRemovedError before any I/O.
 * GEMINI_API_KEY, GEMINI_MODEL and registered keys are never read.
 */
export class GeminiRemovedError extends Error {
  constructor() {
    super("removed in this fork: Gemini");
    this.name = "GeminiRemovedError";
  }
}

export const GEMINI_HOST = "generativelanguage.googleapis.com";

export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
const DEFAULT_MAX_OUTPUT_TOKENS = 16_384;

export type GeminiMediaResolution = "MEDIA_RESOLUTION_LOW" | "MEDIA_RESOLUTION_MEDIUM" | "MEDIA_RESOLUTION_HIGH";
export type GeminiKeySource = "encrypted_user_storage" | "env";

/** 254 M7: no env read; the model name is only ever reported, never used. */
export function resolveGeminiModel(_env?: NodeJS.ProcessEnv): string {
  return DEFAULT_GEMINI_MODEL;
}

const KEY_SHAPES = /AQ\.[A-Za-z0-9_.-]{10,}|AIza[0-9A-Za-z_-]{10,}/g;

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Google does not echo keys in error bodies today, but these strings travel
 * back to the MCP client and into logs. The exact key is matched as well as
 * the known shapes because the format has already changed once (AIza → AQ.).
 */
export function scrubGeminiKey(text: string, exactKey?: string): string {
  if (!exactKey || exactKey.length < 8) return text.replace(KEY_SHAPES, "[REDACTED]");
  // One left-to-right pass: trailing key characters are folded into the exact
  // alternative so a longer credential sharing this prefix is removed whole.
  const combined = new RegExp(`${escapeRegExp(exactKey)}[A-Za-z0-9_.-]*|${KEY_SHAPES.source}`, "g");
  return text.replace(combined, "[REDACTED]");
}

/** Shows only the public prefix; no character of the secret body, not even a suffix. */
export function maskGeminiKey(key: string): string {
  if (key.startsWith("AQ.")) return "AQ.***";
  if (key.startsWith("AIza")) return "AIza***";
  return "***";
}

export type GeminiKeyInputResult =
  | { ok: true; key: string }
  | { ok: false; reason: "empty" | "too-short" | "too-long" | "illegal-chars" };

/**
 * The key is sent as an HTTP header value, so anything outside printable
 * ASCII — CR/LF above all — is refused here rather than left to the HTTP
 * client. No prefix is required: Google moved from AIza… to AQ.… keys once
 * already, and the live check against the API is the real authority.
 */
export function validateGeminiKeyInput(input: unknown): GeminiKeyInputResult {
  if (typeof input !== "string") return { ok: false, reason: "empty" };
  const key = input.trim();
  if (key.length === 0) return { ok: false, reason: "empty" };
  if (key.length < 20) return { ok: false, reason: "too-short" };
  if (key.length > 512) return { ok: false, reason: "too-long" };
  if (!/^[\x21-\x7e]+$/.test(key)) return { ok: false, reason: "illegal-chars" };
  return { ok: true, key };
}

/**
 * Which encrypted-key bucket this request may read. Fails closed in
 * multi-tenant mode without an OAuth identity (see src/auth/tenant.ts).
 */
export function resolveGeminiTenantId(): string {
  return resolveTenantId({ feature: "Gemini video analysis" });
}

/** 254 M7: no Gemini key, the server-wide one included, is ever used. */
export function isGeminiEnvFallbackUsable(): boolean {
  return false;
}

export interface ResolvedGeminiKey {
  key: string;
  source: GeminiKeySource;
  tenantId: string;
}

export type GeminiVideoPart =
  | { kind: "file"; fileUri: string; mimeType: string }
  | { kind: "inline"; data: Buffer; mimeType: string };

export interface GenerateBodyInput {
  video: GeminiVideoPart;
  prompt: string;
  systemInstruction: string;
  schema: unknown;
  mediaResolution: GeminiMediaResolution;
  maxOutputTokens?: number;
}

/**
 * The whole generateContent request shape lives here, under a unit test, so a
 * change in the API touches one function. The text part goes after the video,
 * as Google recommends for single-media prompts.
 */
export function buildGenerateBody(input: GenerateBodyInput, options: { withSchema?: boolean } = {}): Record<string, unknown> {
  const videoPart =
    input.video.kind === "file"
      ? { fileData: { fileUri: input.video.fileUri, mimeType: input.video.mimeType } }
      : { inlineData: { mimeType: input.video.mimeType, data: input.video.data.toString("base64") } };
  return {
    systemInstruction: { parts: [{ text: input.systemInstruction }] },
    contents: [{ role: "user", parts: [videoPart, { text: input.prompt }] }],
    generationConfig: {
      responseMimeType: "application/json",
      ...(options.withSchema === false ? {} : { responseJsonSchema: input.schema }),
      mediaResolution: input.mediaResolution,
      maxOutputTokens: input.maxOutputTokens ?? DEFAULT_MAX_OUTPUT_TOKENS,
      temperature: 0.2,
    },
  };
}

export interface GeminiFile {
  name: string;
  uri: string;
  state: string;
}

export interface GeminiUsage {
  prompt_tokens?: number;
  output_tokens?: number;
  thoughts_tokens?: number;
  total_tokens?: number;
}

export interface GenerateJsonInput extends GenerateBodyInput {
  key: string;
  model: string;
  signal?: AbortSignal;
}

export interface GenerateJsonResult {
  json: unknown;
  usage: GeminiUsage;
  model: string;
  finish_reason?: string;
  /** False when the API refused the schema field and the answer came from the prompt-only retry. */
  schema_enforced: boolean;
}

export interface GeminiClient {
  validateKey(key: string, signal?: AbortSignal): Promise<void>;
  uploadFile(input: { key: string; data: Buffer; mimeType: string; displayName: string; signal?: AbortSignal }): Promise<GeminiFile>;
  waitForFileActive(input: { key: string; name: string; budgetMs: number; signal?: AbortSignal }): Promise<GeminiFile>;
  generateJson(input: GenerateJsonInput): Promise<GenerateJsonResult>;
  /** Best effort: resolves false instead of throwing, and never uses the caller's (possibly aborted) signal. */
  deleteFile(input: { key: string; name: string }): Promise<boolean>;
}

export interface GeminiClientConfig {
  fetch?: typeof fetch;
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  now?: () => number;
}

/** 254 M7: refuses; no key is looked up. */
export async function resolveGeminiKey(): Promise<ResolvedGeminiKey> {
  throw new GeminiRemovedError();
}

/** The client every caller gets: each method refuses, deleteFile reports nothing deleted. */
const removedClient: GeminiClient = {
  validateKey: () => Promise.reject(new GeminiRemovedError()),
  uploadFile: () => Promise.reject(new GeminiRemovedError()),
  waitForFileActive: () => Promise.reject(new GeminiRemovedError()),
  generateJson: () => Promise.reject(new GeminiRemovedError()),
  deleteFile: () => Promise.resolve(false),
};

/** 254 M7: the config (an injected fetch included) is ignored. */
export function createGeminiClient(_config: GeminiClientConfig = {}): GeminiClient {
  return removedClient;
}

let defaultClient: GeminiClient | undefined;

export function getGeminiClient(): GeminiClient {
  return defaultClient ?? removedClient;
}

/** Test seam only: production code never calls it. */
export function configureGeminiClientForTests(client: GeminiClient | undefined): void {
  defaultClient = client;
}
