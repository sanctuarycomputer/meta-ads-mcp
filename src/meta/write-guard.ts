/**
 * The spend guard runner (contract docs/contracts/meta-ads-guard.md §2, §8, §9, §10) and the per-call context
 * the client keeps while one tool call runs.
 *
 * Every failure to get a clear yes is a `WriteRefusal` whose message is `write refused: guard <class>: <detail>`.
 */
import { execFile } from "node:child_process";
import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";

import {
  CONTRACT_VERSION,
  WriteRefusal,
  buildDescriptor,
  keySetMiss,
  matchEndpoint,
  validateDescriptor,
  type Descriptor,
  type EndpointRow,
  type GraphGet,
  type OutcomeRecord,
  type WriteRequest,
} from "./write-descriptor.js";

export type GuardRefusalClass = "unset" | "spawn" | "exit" | "output" | "version" | "denied" | "receipt" | "timeout";

function refuse(cls: GuardRefusalClass, detail: string): WriteRefusal {
  return new WriteRefusal(`guard ${cls}: ${detail}`);
}

/** Contract §2: exactly `PATH`, `HOME`, every `NODE_*` and `NOTION_API_KEY`, each only if set. No `META_*` key, ever. */
export function guardEnv(env: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) continue;
    if (k === "PATH" || k === "HOME" || k === "NOTION_API_KEY" || k.startsWith("NODE_")) out[k] = v;
  }
  return out;
}

export interface GuardRunnerOptions {
  env?: NodeJS.ProcessEnv;
  cwd?: string;
  timeoutMs?: number;
  maxOutputBytes?: number;
}

export interface GuardDecision {
  reason: string;
  basis: string | null;
  receipt: string;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function oneLine(s: string): string {
  return s.replace(/\s+/g, " ").trim();
}

export class GuardRunner {
  private readonly env: NodeJS.ProcessEnv;
  /** Working directory the guard runs in (contract §2: `/app`). */
  readonly cwd: string;
  /** The guard is killed (SIGKILL) after this many ms (contract §2: 20 s). */
  readonly timeoutMs: number;
  /** stdout or stderr past this many bytes refuses as `output`. */
  readonly maxOutputBytes: number;

  constructor(opts: GuardRunnerOptions = {}) {
    this.env = opts.env ?? process.env;
    this.cwd = opts.cwd ?? "/app";
    this.timeoutMs = opts.timeoutMs ?? 20_000;
    this.maxOutputBytes = opts.maxOutputBytes ?? 65_536;
  }

  /** Contract §2 and §8. Resolves only on a clear allow; every other outcome throws `WriteRefusal`. */
  async decide(d: Descriptor): Promise<GuardDecision> {
    const reply = await this.run(d);
    if (reply.v !== CONTRACT_VERSION) throw refuse("version", `reply v is ${JSON.stringify(reply.v)}, not "${CONTRACT_VERSION}"`);
    if (reply.allow !== true) {
      throw refuse("denied", typeof reply.reason === "string" ? reply.reason : "the guard did not allow the write");
    }
    if (typeof reply.receipt !== "string" || reply.receipt === "") throw refuse("receipt", "the allow reply has no receipt");
    return {
      reason: typeof reply.reason === "string" ? reply.reason : "",
      basis: typeof reply.basis === "string" ? reply.basis : null,
      receipt: reply.receipt,
    };
  }

  /** Contract §9. `null` on an ack; otherwise a one-line warning. Never throws. */
  async sendOutcome(o: OutcomeRecord): Promise<string | null> {
    try {
      const reply = await this.run(o);
      if (reply.v === CONTRACT_VERSION && reply.ack === true && typeof reply.receipt === "string" && reply.receipt !== "") {
        return null;
      }
      return oneLine(`guard outcome record for ${o.outcome_for} was not acknowledged`);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      return oneLine(`guard outcome record for ${o.outcome_for} was not acknowledged: ${msg}`);
    }
  }

  /** Runs the guard once with `input` on stdin; resolves the parsed one-line object or throws `WriteRefusal`. */
  private run(input: unknown): Promise<Record<string, unknown>> {
    const cmd = this.env.META_WRITE_GUARD_CMD;
    if (cmd === undefined || cmd === "") return Promise.reject(refuse("unset", "META_WRITE_GUARD_CMD is not set"));
    const argv = cmd.split(" ");
    if (argv.some((a) => a === "")) {
      return Promise.reject(refuse("spawn", "META_WRITE_GUARD_CMD has an empty argument (a doubled, leading or trailing space)"));
    }

    return new Promise((resolve, reject) => {
      let settled = false;
      const fail = (e: WriteRefusal) => {
        if (!settled) {
          settled = true;
          reject(e);
        }
      };
      let child;
      try {
        child = execFile(
          argv[0],
          argv.slice(1),
          {
            env: guardEnv(this.env),
            cwd: this.cwd,
            killSignal: "SIGKILL",
            timeout: this.timeoutMs,
            maxBuffer: this.maxOutputBytes,
            encoding: "utf8",
            windowsHide: true,
          },
          (err, stdout) => {
            if (settled) return;
            if (err) {
              const code = (err as NodeJS.ErrnoException).code as unknown;
              const e = err as { killed?: boolean; signal?: NodeJS.Signals | null };
              if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
                return fail(refuse("output", `the guard wrote more than ${this.maxOutputBytes} bytes`));
              }
              if (typeof code === "string") return fail(refuse("spawn", oneLine(`could not run ${argv[0]}: ${code}`)));
              if (e.killed) return fail(refuse("timeout", `no reply in ${this.timeoutMs} ms (killed, ${e.signal ?? "SIGKILL"})`));
              if (typeof code === "number") return fail(refuse("exit", `the guard exited ${code}`));
              return fail(refuse("exit", `the guard was stopped by ${e.signal ?? "an unknown cause"}`));
            }
            const text = stdout.endsWith("\n") ? stdout.slice(0, -1) : stdout;
            if (text === "") return fail(refuse("output", "exit 0 with no reply line"));
            if (text.includes("\n")) return fail(refuse("output", "the reply is more than one line"));
            // Exactly `<json>` or `<json>\n`: no \r, no surrounding whitespace (JSON.stringify never prints any).
            if (text !== text.trim()) return fail(refuse("output", "the reply line has surrounding whitespace"));
            let parsed: unknown;
            try {
              parsed = JSON.parse(text);
            } catch {
              return fail(refuse("output", "the reply is not JSON"));
            }
            if (!isRecord(parsed)) return fail(refuse("output", "the reply is not a JSON object"));
            settled = true;
            resolve(parsed);
          },
        );
      } catch (e) {
        return fail(refuse("spawn", oneLine(`could not run ${argv[0]}: ${e instanceof Error ? e.message : String(e)}`)));
      }
      // A guard that exits before reading stdin makes the write fail (EPIPE); the exit and stdout decide, never a throw.
      child.stdin?.on("error", () => {});
      child.stdin?.end(JSON.stringify(input) + "\n");
    });
  }
}

/** One write the client sent during a tool call. */
export interface SentWrite {
  method: string;
  path: string;
  label: EndpointRow["validate_only"] | null;
  ok: boolean;
  answer: string;
}

/** What the client keeps while one tool call runs. */
export interface CallContext {
  readonly tool: string;
  readonly validateOnly: boolean;
  refusal: string | null;
  sent: SentWrite[];
  accounts: Set<string>;
  validateOnlyStop: boolean;
  warnings: string[];
}

export const callContext = new AsyncLocalStorage<CallContext>();

export function newCallContext(tool: string, validateOnly: boolean): CallContext {
  return { tool, validateOnly, refusal: null, sent: [], accounts: new Set(), validateOnlyStop: false, warnings: [] };
}

/** The client's one question before a write (contract §2) and its one report after it (§9). */
export interface WriteGate {
  /** Resolves only on a clear allow, with the write's `request_id` and its row's validate_only label; else throws. */
  check(req: WriteRequest, ctx: CallContext | undefined): Promise<{ requestId: string; label: EndpointRow["validate_only"] | null }>;
  /** The outcome record for an allowed write: `null` on an ack, otherwise a one-line warning. Never throws. */
  outcome(requestId: string, r: { ok: boolean; metaId: string | null; error: string | null }): Promise<string | null>;
}

/** The gate every real client uses: no tool context, no write; then the descriptor, its check, and the guard. */
export class RealWriteGate implements WriteGate {
  readonly runner: GuardRunner;

  constructor(
    private readonly get: GraphGet,
    runner?: GuardRunner,
  ) {
    this.runner = runner ?? new GuardRunner();
  }

  async check(req: WriteRequest, ctx: CallContext | undefined): Promise<{ requestId: string; label: EndpointRow["validate_only"] | null }> {
    if (!ctx) throw new WriteRefusal("no tool context");
    const requestId = randomUUID();
    let d: Descriptor;
    try {
      d = await buildDescriptor(req, { tool: ctx.tool, validateOnly: ctx.validateOnly, requestId, accounts: ctx.accounts }, this.get);
    } catch (e) {
      if (e instanceof WriteRefusal) throw e;
      throw new WriteRefusal(oneLine(`the descriptor could not be built: ${e instanceof Error ? e.message : String(e)}`));
    }
    const problems = validateDescriptor(d);
    if (problems.length > 0) throw new WriteRefusal(oneLine(`invalid descriptor: ${problems.join("; ")}`));
    await this.runner.decide(d);
    // M11 (spec check 3): a key outside the row's key set is refused after the allow, and the guard told so.
    const miss = keySetMiss(d);
    if (miss) {
      const reason = miss.row === "no row" ? `${miss.key} matches no endpoint row` : `${miss.key} is not a key of ${miss.row}`;
      const w = await this.runner.sendOutcome({ v: CONTRACT_VERSION, outcome_for: requestId, ok: false, meta_id: null, error: reason });
      if (w !== null) ctx.warnings.push(w);
      throw new WriteRefusal(reason);
    }
    const row = matchEndpoint(d.method, d.path, d.object.type);
    return { requestId, label: row ? row.validate_only : null };
  }

  outcome(requestId: string, r: { ok: boolean; metaId: string | null; error: string | null }): Promise<string | null> {
    return this.runner.sendOutcome({ v: CONTRACT_VERSION, outcome_for: requestId, ok: r.ok, meta_id: r.metaId, error: r.error });
  }
}
