import { createHmac } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { McpError } from "@modelcontextprotocol/sdk/types.js";
import {
  envSecrets,
  formsCachedForTests,
  heldSecrets,
  scrubCredentials,
  scrubCredentialsDeep,
  scrubErrorCredentials,
  secretForms,
  withHeldSecret,
} from "../../src/utils/scrub-credentials.js";
import { scrubLogLine, logger } from "../../src/utils/logger.js";
import { metaApiClient } from "../../src/meta/client.js";
import { readList } from "../../src/meta/read-list.js";
import { withPageToken } from "../../src/meta/page-token.js";
import { mockFetchResponse } from "../setup.js";

// Every credential is built at run time (gitleaks scans this repo): a label,
// characters that make each encoding differ from the value ("|" and "/" are
// percent-encoded, "~~~???" gives base64 a "+" and a "/", mixed case gives the
// case forms), and a run of "x".
const built = (label: string) => `${label}|Mx/~~~???${"x".repeat(21)}`;
const ACCESS = built("Acc");
const APP_SECRET = built("Sec");
const PAGE = built("Pag");
// A Meta-shaped token this process never held: "EAA" and 40 alphanumerics.
const FOREIGN = `EAA${"b".repeat(20)}${"C9".repeat(10)}`;

const proofOf = (token: string) => createHmac("sha256", APP_SECRET).update(token).digest("hex");
const lowerHex = (text: string) => text.replace(/%[0-9A-F]{2}/g, (m) => m.toLowerCase());
const b64 = (text: string) => Buffer.from(text).toString("base64");
const b64url = (text: string) => Buffer.from(text).toString("base64url");

// Each form a caller might see of a value Meta was sent, by name.
function formsOf(value: string, token: boolean): Array<[string, string]> {
  const forms: Array<[string, string]> = [
    ["trimmed", value],
    ["percent-encoded, upper-case hex", encodeURIComponent(value)],
    ["percent-encoded, lower-case hex", lowerHex(encodeURIComponent(value))],
    ["double percent-encoded, upper-case hex", encodeURIComponent(encodeURIComponent(value))],
    ["double percent-encoded, lower-case hex", encodeURIComponent(lowerHex(encodeURIComponent(value)))],
    ["upper-cased", value.toUpperCase()],
    ["lower-cased", value.toLowerCase()],
    ["base64 with padding", b64(value)],
    ["base64 without padding", b64(value).replace(/=+$/, "")],
    ["base64url with padding", b64url(value).padEnd(Math.ceil(b64url(value).length / 4) * 4, "=")],
    ["base64url without padding", b64url(value)],
  ];
  if (token) {
    forms.push(["appsecret_proof, lower-case hex", proofOf(value)], ["appsecret_proof, upper-case hex", proofOf(value).toUpperCase()]);
  }
  return forms;
}

const saved = { token: process.env.META_ACCESS_TOKEN, secret: process.env.META_APP_SECRET };
function restoreEnv() {
  for (const [name, value] of [["META_ACCESS_TOKEN", saved.token], ["META_APP_SECRET", saved.secret]] as const) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
}

describe("the forms are distinct, so each case below is decided by its own form", () => {
  it("every built value gives each form once, base64 differs from base64url, and padding is there to drop", () => {
    for (const value of [ACCESS, APP_SECRET, PAGE]) {
      const forms = formsOf(value, true).map(([, form]) => form);
      expect(new Set(forms).size).toBe(forms.length);
      expect(b64(value)).toMatch(/[+/]/);
      expect(b64(value)).toMatch(/=$/);
    }
  });
});

describe("scrub shapes (spec check 5)", () => {
  beforeEach(() => {
    // Padded, as an env file can leave them: the raw value is a form too.
    process.env.META_ACCESS_TOKEN = `  ${ACCESS}\n`;
    process.env.META_APP_SECRET = ` ${APP_SECRET}\t`;
  });
  afterEach(restoreEnv);

  const cases: Array<[string, string, boolean, boolean]> = [
    ["META_ACCESS_TOKEN", ACCESS, true, false],
    ["META_APP_SECRET", APP_SECRET, false, false],
    ["a held Page token", PAGE, true, true],
  ];

  for (const [who, value, token, held] of cases) {
    const run = <T>(work: () => T): Promise<T> => (held ? withHeldSecret(value, async () => work()) : Promise.resolve(work()));

    for (const [name, form] of formsOf(value, token)) {
      it(`redacts ${who}, ${name}, in free text`, async () => {
        expect(await run(() => scrubCredentials(`said ${form} then`))).toBe("said [REDACTED] then");
      });

      it(`redacts ${who}, ${name}, inside an error body quoted as JSON`, async () => {
        const body = JSON.stringify({ error: { message: `bad ${form} here`, code: 190 } });
        expect(await run(() => scrubCredentials(`HTTP 400: ${body}`))).toBe(
          `HTTP 400: ${JSON.stringify({ error: { message: "bad [REDACTED] here", code: 190 } })}`,
        );
        expect(await run(() => scrubCredentialsDeep({ error: { message: `bad ${form} here` } }))).toEqual({
          error: { message: "bad [REDACTED] here" },
        });
      });
    }
  }

  it("redacts the raw, padded env values as they were set", () => {
    expect(scrubCredentials(`a${process.env.META_ACCESS_TOKEN}b`)).toBe("a[REDACTED]b");
    expect(scrubCredentials(`a${process.env.META_APP_SECRET}b`)).toBe("a[REDACTED]b");
  });

  it("gives the app secret no proof: it signs, it is not signed", () => {
    expect(secretForms(APP_SECRET, { token: false })).not.toContain(proofOf(APP_SECRET));
    expect(secretForms(APP_SECRET, { token: true })).toContain(proofOf(APP_SECRET));
  });

  it("gives no proof when META_APP_SECRET is not set", () => {
    delete process.env.META_APP_SECRET;
    expect(secretForms(ACCESS, { token: true }).some((form) => /^[0-9a-fA-F]{64}$/.test(form))).toBe(false);
  });

  it("drops forms under 8 characters and lists the rest longest first", () => {
    const forms = secretForms(ACCESS, { token: true });
    expect(forms.every((form) => form.length >= 8)).toBe(true);
    expect([...forms].sort((a, b) => b.length - a.length)).toEqual(forms);
    expect(secretForms("Ab|1", { token: false }).every((form) => form.length >= 8)).toBe(true);
  });

  it("redacts a Page token only while it is held", async () => {
    await withHeldSecret(PAGE, async () => {
      expect(heldSecrets.getStore()?.has(PAGE)).toBe(true);
      await withHeldSecret(ACCESS, async () => {
        expect(scrubCredentials(`${PAGE} ${b64(PAGE)}`)).toBe("[REDACTED] [REDACTED]");
      });
    });
    expect(scrubCredentials(`left ${PAGE}`)).toBe(`left ${PAGE}`);
  });
});

describe("review T6: the env app secret, the held forms' cache", () => {
  beforeEach(() => {
    process.env.META_ACCESS_TOKEN = `  ${ACCESS}\n`;
    process.env.META_APP_SECRET = ` ${APP_SECRET}\t`;
  });
  afterEach(restoreEnv);

  it("gives the env app secret no proof through envSecrets and the scrub (T6-2)", () => {
    expect(envSecrets()).toContain(proofOf(ACCESS));
    expect(envSecrets()).not.toContain(proofOf(APP_SECRET));
    expect(scrubCredentials(`p ${proofOf(APP_SECRET)} q`)).toBe(`p ${proofOf(APP_SECRET)} q`);
  });

  it("keeps a held Page token's forms only while it is held, never in the module cache (T6-3)", async () => {
    await withHeldSecret(PAGE, async () => {
      expect(scrubCredentials(`a ${b64(PAGE)} b`)).toBe("a [REDACTED] b");
      expect(formsCachedForTests(PAGE)).toBe(false);
    });
    expect(formsCachedForTests(PAGE)).toBe(false);
    // The module cache is the env secrets': the hook sees what it keeps.
    expect(formsCachedForTests(process.env.META_ACCESS_TOKEN as string)).toBe(true);
  });

  it("keeps no Page token's forms in the module cache after withPageToken returns (T6-3)", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "6001", access_token: PAGE })));
    const result = await withPageToken("6001", async () => ({ note: `echo ${PAGE}` }));
    vi.unstubAllGlobals();
    expect(result.note).toBe("echo [REDACTED]");
    expect(formsCachedForTests(PAGE)).toBe(false);
  });
});

describe("scrubErrorCredentials's opt-in sites each remove a foreign token (T6-1)", () => {
  it("a thrown value that is not an Error or a string", () => {
    const thrown = { toString: () => `socket said ${FOREIGN}` };
    const error = scrubErrorCredentials(thrown as unknown) as Error;
    expect(error).toBeInstanceOf(Error);
    expect(error.message).toBe("socket said [REDACTED]");
  });

  it("an McpError's data", () => {
    const error = scrubErrorCredentials(new McpError(-32600, "refused", { detail: `Meta said ${FOREIGN}` }));
    expect(error).toBeInstanceOf(McpError);
    expect(error.data).toEqual({ detail: "Meta said [REDACTED]" });
  });
});

describe("a Meta-shaped token the call does not hold (errors and logs only)", () => {
  afterEach(() => {
    restoreEnv();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
    metaApiClient.resetForTests();
  });

  it("is redacted when asked, in text and at depth, and kept by default", () => {
    expect(scrubCredentials(`see ${FOREIGN}.`, { foreignTokens: true })).toBe("see [REDACTED].");
    expect(scrubCredentialsDeep({ m: [`(${FOREIGN})`] }, undefined, { foreignTokens: true })).toEqual({ m: ["([REDACTED])"] });
    expect(scrubCredentials(`see ${FOREIGN}.`)).toBe(`see ${FOREIGN}.`);
    expect(scrubCredentialsDeep({ m: FOREIGN })).toEqual({ m: FOREIGN });
  });

  it("is redacted in an error", () => {
    const error = scrubErrorCredentials(new Error(`Meta said ${FOREIGN} is invalid`));
    expect(error.message).toBe("Meta said [REDACTED] is invalid");
    expect(scrubErrorCredentials(`thrown ${FOREIGN}`)).toBe("thrown [REDACTED]");
  });

  it("is kept inside a longer base64url word, on either side, and when too short", () => {
    for (const word of [`a${FOREIGN}`, `-${FOREIGN}`, `_${FOREIGN}`, `${FOREIGN}_`, `${FOREIGN}-z`, `EAA${"b".repeat(29)}`]) {
      expect(scrubCredentials(`x ${word} y`, { foreignTokens: true })).toBe(`x ${word} y`);
    }
    expect(scrubCredentials(`EAA${"b".repeat(30)}`, { foreignTokens: true })).toBe("[REDACTED]");
  });

  it("is redacted in a log line written as JSON", () => {
    const line = scrubLogLine(JSON.stringify({ level: 30, msg: `token ${FOREIGN} expired` }));
    expect(line).not.toContain(FOREIGN);
    expect(JSON.parse(line).msg).toBe("token [REDACTED] expired");
  });

  it("is redacted in a log line that is not JSON", () => {
    expect(scrubLogLine(`plain token ${FOREIGN} expired`)).toBe("plain token [REDACTED] expired");
  });

  it("is redacted from Meta's error body before the client logs it", async () => {
    process.env.META_ACCESS_TOKEN = ACCESS;
    process.env.META_APP_SECRET = APP_SECRET;
    const seen: unknown[] = [];
    for (const level of ["fatal", "error", "warn", "info", "debug"] as const) {
      vi.spyOn(logger, level).mockImplementation(((...args: unknown[]) => { seen.push(args); }) as never);
    }
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse(
      { error: { message: `Invalid parameter ${FOREIGN}`, code: 100, type: "OAuthException" } },
      { status: 400 },
    )));

    const error = await metaApiClient.get("/act_1", { fields: "name" }).catch((e: Error) => e);

    expect(String((error as Error).message)).not.toContain(FOREIGN);
    expect(JSON.stringify(seen)).toContain("[REDACTED]");
    expect(JSON.stringify(seen)).not.toContain(FOREIGN);
  });

  it("is redacted from a thrown value that is not an Error", async () => {
    process.env.META_ACCESS_TOKEN = ACCESS;
    process.env.META_APP_SECRET = APP_SECRET;
    vi.spyOn(metaApiClient as unknown as { backoff: () => Promise<void> }, "backoff").mockResolvedValue();
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(`socket said ${FOREIGN}`));

    const error = await metaApiClient.get("/act_1", { fields: "name" }).catch((e: Error) => e);

    expect((error as Error).message).toBe("socket said [REDACTED]");
  });

  it("is kept in a readList answer: answers never meet the pattern", async () => {
    process.env.META_ACCESS_TOKEN = ACCESS;
    process.env.META_APP_SECRET = APP_SECRET;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ data: [{ id: "1", name: `promo ${FOREIGN}` }] })));

    const list = await readList<{ id: string; name: string }>("/act_1/ads", { fields: "id,name" }, 10);

    expect(list.items[0].name).toBe(`promo ${FOREIGN}`);
  });

  it("is kept in a withPageToken result: answers never meet the pattern", async () => {
    process.env.META_ACCESS_TOKEN = ACCESS;
    process.env.META_APP_SECRET = APP_SECRET;
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(mockFetchResponse({ id: "6001", access_token: PAGE })));

    const result = await withPageToken("6001", async () => ({ note: `promo ${FOREIGN}` }));

    expect(result.note).toBe(`promo ${FOREIGN}`);
  });
});
