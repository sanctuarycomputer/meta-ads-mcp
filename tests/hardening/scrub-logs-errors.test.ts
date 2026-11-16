/**
 * Done-when 3: logger output and thrown errors never carry META_ACCESS_TOKEN
 * or META_APP_SECRET, whatever field they sit in.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import pino from "pino";
import { fileURLToPath } from "node:url";
import { createLogger, scrubLogLine, LOG_REDACT } from "../../src/utils/logger.js";
import {
  scrubCredentials,
  scrubCredentialsDeep,
  scrubErrorCredentials,
} from "../../src/utils/scrub-credentials.js";
import { TOKEN, SECRET, PAGE } from "./fake-secrets.js";

const forkRoot = fileURLToPath(new URL("../../", import.meta.url));

function capture() {
  const lines: string[] = [];
  const log = createLogger({ write: (s: string) => void lines.push(s) });
  return { log, out: () => lines.join("") };
}

beforeEach(() => {
  process.env.META_ACCESS_TOKEN = TOKEN;
  process.env.META_APP_SECRET = SECRET;
});
afterEach(() => {
  delete process.env.META_ACCESS_TOKEN;
  delete process.env.META_APP_SECRET;
});

describe("scrub covers logs and errors (done-when 3)", () => {
  it("logs an error containing both secrets and neither appears", () => {
    const { log, out } = capture();
    const err = Object.assign(new Error(`boom ${TOKEN} and ${SECRET}`), {
      cause: new Error(SECRET),
      extra: TOKEN,
    });
    log.error({ err, url: `https://graph.facebook.com/x?access_token=${TOKEN}` }, `failed with ${SECRET}`);
    expect(out()).not.toContain(TOKEN);
    expect(out()).not.toContain(SECRET);
    expect(out()).toContain("[REDACTED]");
  });

  it("scrubs every field of a structured log line", () => {
    const { log, out } = capture();
    log.info({ a: { b: [TOKEN] } }, `access_token=${PAGE} failed`);
    expect(out()).not.toContain(TOKEN);
    expect(out()).not.toContain(PAGE);
  });

  it("thrown errors lose both secrets", () => {
    const e = scrubErrorCredentials(new Error(`x ${TOKEN} y ${SECRET}`));
    expect(e.message).not.toContain(TOKEN);
    expect(e.message).not.toContain(SECRET);
  });

  it("deep scrub of a JSON value", () => {
    const v = scrubCredentialsDeep({ m: `${TOKEN}`, n: [`k ${SECRET}`] });
    expect(JSON.stringify(v)).not.toContain(TOKEN);
    expect(JSON.stringify(v)).not.toContain(SECRET);
  });

  it("ignores secrets shorter than 8 characters", () => {
    process.env.META_APP_SECRET = "abc";
    expect(scrubCredentials("abc abcdef")).toBe("abc abcdef");
  });

  it("an env secret set with surrounding whitespace is still removed", () => {
    process.env.META_ACCESS_TOKEN = `  ${TOKEN}\n`;
    expect(scrubCredentials(`x ${TOKEN} y`)).toBe("x [REDACTED] y");
  });

  it("a secret that contains the other is removed whole", () => {
    process.env.META_APP_SECRET = `${TOKEN}-tail`;
    expect(scrubCredentials(`x ${TOKEN}-tail y`)).toBe("x [REDACTED] y");
  });

  it("default logger writes to stderr, never stdout", () => {
    const child = spawnSync(
      process.execPath,
      [
        "--import",
        "tsx",
        "-e",
        "import('./src/utils/logger.ts').then(m => { m.logger.info('probe-254'); m.logger.flush(); })",
      ],
      { cwd: forkRoot, env: { PATH: process.env.PATH }, encoding: "utf8", timeout: 30_000 },
    );
    expect(child.stdout).toBe("");
    expect(child.stderr).toContain("probe-254");
  }, 30_000);

  it("an error under the error key keeps its message", () => {
    const { log, out } = capture();
    log.fatal({ error: new Error("removed in this fork: X") });
    expect(out()).toContain("removed in this fork: X");
  });

  it("unparseable line still loses secrets", () => {
    const line = scrubLogLine(`not json "access_token=${PAGE} ${SECRET}`);
    expect(line).not.toContain(PAGE);
    expect(line).not.toContain(SECRET);
  });

  it("an env secret used as an object key is removed", () => {
    const { log, out } = capture();
    log.info({ [TOKEN]: 1, m: { [SECRET]: "v" } });
    expect(out()).not.toContain(TOKEN);
    expect(out()).not.toContain(SECRET);
  });

  it("a credential pair after a newline in the message is removed (JSON path)", () => {
    const { log, out } = capture();
    log.info(`line one\naccess_token=${PAGE}`);
    expect(out()).not.toContain(PAGE);
  });

  it("a percent-encoded env secret is removed", () => {
    const appToken = `${TOKEN}|tail`;
    process.env.META_ACCESS_TOKEN = appToken;
    const text = `x ${encodeURIComponent(appToken)} y`;
    expect(scrubCredentials(text)).toBe("x [REDACTED] y");
  });

  it("the redact paths alone censor the added credential fields", () => {
    const lines: string[] = [];
    // The redact config without the line scrub, so only the paths decide it.
    const log = pino({ redact: LOG_REDACT }, { write: (s: string) => void lines.push(s) });
    const [p, s, c] = ["p", "s", "c"].map((ch) => ch.repeat(20));
    log.info({ appsecret_proof: p, app_secret: s, client_secret: c, n: { appsecret_proof: p, app_secret: s, client_secret: c } });
    expect(lines.join("")).not.toMatch(/p{20}|s{20}|c{20}/);
  });

  it("added redact paths", () => {
    const { log, out } = capture();
    const [p, s, c] = ["p", "s", "c"].map((ch) => ch.repeat(20));
    log.info({ appsecret_proof: p, app_secret: s, client_secret: c });
    expect(out()).not.toContain(p);
    expect(out()).not.toContain(s);
    expect(out()).not.toContain(c);
  });
});
