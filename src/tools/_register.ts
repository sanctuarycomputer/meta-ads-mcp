import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { ToolAnnotations } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";

import { closeCall, notSentOf, validateOnlyHeld } from "../meta/client.js";
import { callContext, newCallContext, type CallContext, type SentWrite } from "../meta/write-guard.js";

/**
 * Standard ToolAnnotations by tool kind, applied across all v3 tools so that
 * MCP clients (Claude, ChatGPT, Perplexity) get consistent confirmation hints.
 *
 * Spread these into the `annotations` field of `server.registerTool(...)`.
 */

export const READ: ToolAnnotations = { readOnlyHint: true };

/** Creates a new entity. Re-running may produce duplicates. */
export const CREATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
};

/** Updates fields on an existing entity. Same input → same result. */
export const UPDATE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Deletes an entity. Cannot be undone; re-deleting is a no-op. */
export const DELETE: ToolAnnotations = {
  destructiveHint: true,
  idempotentHint: true,
};

/** Status toggle (activate/pause/archive) or comment moderation. */
export const TOGGLE: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Uploads media (image/video). New asset every call. */
export const UPLOAD: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: false,
};

/** Token / session management. */
export const TOKEN: ToolAnnotations = {
  destructiveHint: false,
  idempotentHint: true,
};

/** Prefix every write-tool description so clients that ignore annotations still see the warning. */
export const WRITE_WARNING = "⚠️ Modifies live ads/account data. ";

/** Same, for WhatsApp Business tools. */
export const WHATSAPP_WRITE_WARNING = "⚠️ Modifies live WhatsApp Business data. ";

/** Same, for Apify-backed tools: these spend the tenant's Apify credit or touch their stored credentials. */
export const APIFY_WRITE_WARNING = "⚠️ Uses your Apify account (paid credits / stored credentials). ";

/** Same, for Gemini-backed tools: these spend the tenant's Gemini quota or touch their stored key. */
export const GEMINI_WRITE_WARNING = "⚠️ Uses your Gemini API key (paid quota / stored credentials). ";

/** What a validated write may have done, by its endpoint row's `validate_only` label (contract §4). */
export const VALIDATE_ONLY_LABELS: Readonly<Record<NonNullable<SentWrite["label"]>, string>> = {
  documented: "Meta documents validate_only here; it checked the write and should have changed nothing",
  unconfirmed: "Meta does not document validate_only here; the write may have taken effect, check it",
  contradicted: "Meta ignores validate_only here; if the guard allowed it, the write took effect",
};

/** The line for writes the validate-only stop kept back (the client's stop refusal, without its prefix). */
export const VALIDATE_ONLY_NOT_SENT = "validate_only: later steps need the first write's result and were not sent";

/** The line for a validate_only call that sent nothing. */
export const VALIDATE_ONLY_NO_WRITE = "validate_only: no write was sent";

const validateOnlyArg = z.boolean().optional().describe("Ask Meta to check the write without making it");

interface TextResult {
  content: Array<{ type: string; text?: string; [k: string]: unknown }>;
  isError?: boolean;
  [k: string]: unknown;
}

type Handler = (...args: unknown[]) => unknown;

// A write without a row claims nothing more than an unconfirmed one.
const labelLine = (w: SentWrite): string => VALIDATE_ONLY_LABELS[w.label ?? "unconfirmed"];

const text = (t: string) => ({ type: "text", text: t });

// What the SDK makes of a thrown error (McpServer.createToolError).
const errorResult = (e: unknown): TextResult => ({ content: [text(e instanceof Error ? e.message : String(e))], isError: true });

/**
 * The tool result from what the call sent or was refused (spec §Design "Result order"; S3-2, S3-3), in order:
 * a refusal; a write sent under validate_only; validate_only with nothing sent; else the handler's own result.
 * Every write the guard allowed and the client never sent is listed as "allowed but not sent", after the writes
 * sent, never among them; every outcome warning the guard left unacknowledged is added as a line.
 */
function shapeResult(ctx: CallContext, settled: { ok: true; value: unknown } | { ok: false; error: unknown }): unknown {
  const warnings = ctx.warnings.length > 0 ? [text(ctx.warnings.join("\n"))] : [];
  const notSent = notSentOf(ctx).map((w) => `allowed but not sent: ${w.method} ${w.path}: ${w.error}`);

  if (ctx.refusal !== null) {
    const sent = ctx.sent.map((w) => (ctx.validateOnly ? `${w.method} ${w.path}: ${labelLine(w)}` : `${w.method} ${w.path}`));
    const before = sent.length > 0 ? `writes sent before it:\n${sent.join("\n")}` : "writes sent before it: none";
    return { content: [text([ctx.refusal, before, ...notSent].join("\n")), ...warnings], isError: true };
  }

  if (ctx.validateOnly && ctx.sent.length > 0) {
    const lines = ctx.sent.flatMap((w) => [
      `${w.method} ${w.path} sent with validate_only`,
      w.ok ? `Meta's answer: ${w.answer}` : `Meta's error: ${w.answer}`,
      labelLine(w),
    ]);
    lines.push(...notSent);
    if (validateOnlyHeld(ctx)) lines.push(VALIDATE_ONLY_NOT_SENT);
    return { content: [text(lines.join("\n")), ...warnings], ...(ctx.sent.some((w) => !w.ok) ? { isError: true } : {}) };
  }

  const extra = [
    ...(ctx.validateOnly ? [text(VALIDATE_ONLY_NO_WRITE)] : []),
    ...(notSent.length > 0 ? [text(notSent.join("\n"))] : []),
    ...warnings,
  ];
  if (!settled.ok) {
    if (extra.length === 0) throw settled.error;
    const r = errorResult(settled.error);
    return { ...r, content: [...r.content, ...extra] };
  }
  if (extra.length === 0) return settled.value;
  const r = (settled.value ?? {}) as TextResult;
  return { ...r, content: [...(r.content ?? []), ...extra] };
}

/**
 * Runs a write tool's handler inside its own call context (the client reads it: the tool, validate_only, what was
 * sent or refused), with `validate_only` taken out of its arguments, and shapes the result from that context.
 */
function guardedHandler(name: string, handler: Handler, hadSchema: boolean): Handler {
  return async (args: unknown, extra: unknown) => {
    const { validate_only, ...rest } = (args ?? {}) as Record<string, unknown>;
    const ctx = newCallContext(name, validate_only === true);
    let settled: { ok: true; value: unknown } | { ok: false; error: unknown };
    try {
      settled = { ok: true, value: await callContext.run(ctx, () => (hadSchema ? handler(rest, extra) : handler(extra))) };
    } catch (error) {
      settled = { ok: false, error };
    }
    // The result is shaped from the context as it is now: a write the handler left running must not go out later.
    closeCall(ctx);
    return shapeResult(ctx, settled);
  };
}

const STRICT_INPUT = new Set(["ads_upload_ad_image", "ads_upload_ad_video"]);

/**
 * The only face of the server a tool group sees when toolsets are in force
 * (ticket 252): one method, `registerTool`, which hands a tool to the real
 * server only when `admit` says so and drops it otherwise. It is a plain
 * object, not a Proxy and not linked to McpServer's prototype, so a group
 * calling `tool`, `registerPrompt` or anything else throws instead of
 * registering past the filter.
 *
 * Every admitted tool not annotated `readOnlyHint: true` also takes an optional `validate_only` and runs in its own
 * call context (ticket 253; see `guardedHandler`).
 */
export function toolFilter(
  server: McpServer,
  admit: (name: string, annotations: ToolAnnotations | undefined) => boolean,
): Pick<McpServer, "registerTool"> {
  const register = server.registerTool.bind(server) as (...args: unknown[]) => unknown;
  const registerTool = (
    name: string,
    config: { annotations?: ToolAnnotations; inputSchema?: Record<string, unknown> },
    handler: Handler,
  ): unknown => {
    if (!admit(name, config.annotations)) return undefined;
    if (config.annotations?.readOnlyHint === true) return register(name, config, handler);
    const shape = { ...(config.inputSchema ?? {}), validate_only: validateOnlyArg };
    // The SDK strips unknown keys from a plain shape; a tool that must refuse them gets a strict object.
    const inputSchema = STRICT_INPUT.has(name) ? z.object(shape as z.ZodRawShape).strict() : shape;
    return register(name, { ...config, inputSchema }, guardedHandler(name, handler, config.inputSchema !== undefined));
  };
  return { registerTool: registerTool as unknown as McpServer["registerTool"] };
}
