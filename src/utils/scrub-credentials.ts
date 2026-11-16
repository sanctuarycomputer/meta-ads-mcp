import { AsyncLocalStorage } from "node:async_hooks";
import { createHmac } from "node:crypto";
import { McpError } from "@modelcontextprotocol/sdk/types.js";

/**
 * Best-effort removal of credential-shaped values from text this server is
 * about to return. It is defence in depth, not a security boundary: the text
 * it cleans is the advertiser's own content and this server's own error
 * messages, both going back to the tenant they belong to. It is not a
 * sanitizer for hostile input, and exotic encodings (overlong UTF-8, deeply
 * nested percent-encoding, a name broken up by arbitrary characters) are out
 * of its scope by design — chasing those turns into an unwinnable game with
 * no attacker on the other side of it.
 *
 * Credential-shaped parameter names. Compared after normalization, so the
 * spelling in the input does not matter: `access_token`, `access%5Ftoken`,
 * `access%255Ftoken`, `ACCESS-TOKEN` and `%61ccess_token` all reduce to the
 * same key.
 */
const CREDENTIAL_NAMES = [
  "access_token",
  "client_secret",
  "app_secret",
  "client_token",
  "signed_request",
  // The HMAC of the token under the app secret (251): it authorizes calls too.
  "appsecret_proof",
  "oauth_token",
  "refresh_token",
  "id_token",
  "api_key",
  // Not a bare "auth": it is a substring of ordinary words like "author".
  "authorization",
  "token",
  "password",
  "passwd",
  "secret",
  // Deliberately not a bare "key": too broad, and api_key is already covered.
];

/**
 * Reduces a parameter name to what it means: percent-decoded as many times as
 * it takes (bounded), stripped of anything that is not a letter or a digit,
 * lowercased. A legitimate name never needs this, and a name that does is
 * exactly the one trying to hide.
 */
function decodeRepeatedly(raw: string): string {
  let value = raw;
  // Eight rounds: each one shrinks the text, and a name nested more deeply
  // than this is out of the documented scope.
  for (let i = 0; i < 8 && value.includes("%"); i++) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(value);
    } catch {
      // A stray % is not decodable; the strip below still normalizes it.
      break;
    }
    if (decoded === value) break;
    value = decoded;
  }
  return value;
}

function normalizeName(raw: string): string {
  return decodeRepeatedly(raw).replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

const CREDENTIAL_KEYS = new Set(CREDENTIAL_NAMES.map(normalizeName));

/** Whether a parameter name means a credential, whatever its spelling. */
export function isCredentialName(raw: string): boolean {
  return CREDENTIAL_KEYS.has(normalizeName(raw));
}

const REDACTED = "[REDACTED]";

/**
 * Whether a credential name appears anywhere in the text, however it is
 * spelled. Used where the whole value can be dropped, so the shape around the
 * name does not matter.
 */
export function mentionsCredential(text: string): boolean {
  // Whole segments, and pairs of adjacent ones, rather than a substring scan:
  // "author-kit" must not read as "auth", while "access_token" must read as
  // "token" even though the name is split across two segments.
  const segments = decodeRepeatedly(text)
    .split(/[^a-zA-Z0-9]+/)
    .filter(Boolean)
    .map((segment) => segment.toLowerCase());
  for (let i = 0; i < segments.length; i++) {
    if (CREDENTIAL_KEYS.has(segments[i])) return true;
    if (i + 1 < segments.length && CREDENTIAL_KEYS.has(segments[i] + segments[i + 1])) return true;
  }
  return false;
}

/**
 * Every separator a name=value pair can sit behind, plus the start of the
 * text. `/` and `:` are in the set because a fragment is often path-shaped
 * (`#/access_token=…`), which is where a credential hides most easily.
 */
const PAIR = /(^|[?&#;,/:\s])([A-Za-z0-9%_.\-[\]]{1,64})=([^&#;,\s"'<>]*)/g;

/**
 * The secrets a scrub removes by value: META_ACCESS_TOKEN and META_APP_SECRET,
 * read on every call so a value set or changed after start-up is covered, and
 * every Page token the call holds (heldSecrets). Each is removed in every form
 * secretForms lists, so a copy Meta or a library transformed (encoded,
 * re-cased, signed) goes too. Forms under 8 characters are dropped, so a short
 * or empty value cannot blank ordinary text.
 */
const MIN_SECRET_LENGTH = 8;

/**
 * The Page tokens the current call holds. withPageToken sets it for the work
 * it runs, so whatever that work's errors and answers carry of the token is
 * removed wherever it is scrubbed, without the token being passed down.
 */
export const heldSecrets = new AsyncLocalStorage<Set<string>>();

/** Runs `work` with `secret` held, on top of whatever the call already holds. */
export function withHeldSecret<T>(secret: string, work: () => Promise<T>): Promise<T> {
  const held = new Set(heldSecrets.getStore());
  held.add(secret);
  return heldSecrets.run(held, work);
}

const lowerHex = (text: string) => text.replace(/%[0-9A-F]{2}/g, (escape) => escape.toLowerCase());
const padded = (base64: string) => base64.padEnd(Math.ceil(base64.length / 4) * 4, "=");

/**
 * Every form of one secret a scrub removes: as set and trimmed (the client
 * trims what it sends, 251), percent-encoded once and twice with either case
 * of hex, upper- and lower-cased, base64 and base64url with and without
 * padding, and, for a token while META_APP_SECRET is set, its appsecret_proof
 * in either case of hex. Each form is of the trimmed value, the one Meta saw.
 * Longest first, so a form that contains another is removed whole.
 */
export function secretForms(secret: string, opts: { token: boolean }): string[] {
  // A deep scrub asks once per string: the forms (a proof is an HMAC) are
  // kept per secret, app secret and kind, a few at a time.
  const appSecret = opts.token ? process.env.META_APP_SECRET?.trim() : undefined;
  const key = JSON.stringify([secret, appSecret ?? null]);
  const known = formsCache.get(key);
  if (known) return [...known];
  const forms = computeForms(secret, appSecret);
  if (formsCache.size >= MAX_CACHED_SECRETS) formsCache.clear();
  formsCache.set(key, forms);
  return [...forms];
}

const formsCache = new Map<string, string[]>();
const MAX_CACHED_SECRETS = 32;

function computeForms(secret: string, appSecret: string | undefined): string[] {
  const value = secret.trim();
  const once = encodeURIComponent(value);
  const twice = encodeURIComponent(once);
  const base64 = Buffer.from(value).toString("base64");
  const base64url = Buffer.from(value).toString("base64url");
  const forms = [
    secret,
    value,
    once,
    lowerHex(once),
    twice,
    // The inner escapes in lower-case hex: "%7c" encodes to "%257c".
    encodeURIComponent(lowerHex(once)),
    value.toUpperCase(),
    value.toLowerCase(),
    base64,
    base64.replace(/=+$/, ""),
    padded(base64url),
    base64url,
  ];
  if (appSecret) {
    const proof = createHmac("sha256", appSecret).update(value).digest("hex");
    forms.push(proof, proof.toUpperCase());
  }
  return [...new Set(forms)].filter((form) => form.length >= MIN_SECRET_LENGTH).sort((a, b) => b.length - a.length);
}

/** Every form of the process's own secrets, longest first. */
export function envSecrets(): string[] {
  const found: string[] = [];
  // Each name is read literally, so a static sweep sees every env name read.
  const token = process.env.META_ACCESS_TOKEN;
  if (token !== undefined) found.push(...secretForms(token, { token: true }));
  const appSecret = process.env.META_APP_SECRET;
  if (appSecret !== undefined) found.push(...secretForms(appSecret, { token: false }));
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

/** Every form of every secret a scrub removes by value: the env's and the held Page tokens'. */
function allSecretForms(): string[] {
  const found = envSecrets();
  for (const held of heldSecrets.getStore() ?? []) found.push(...secretForms(held, { token: true }));
  return [...new Set(found)].sort((a, b) => b.length - a.length);
}

function removeSecrets(text: string): string {
  let out = text;
  for (const secret of allSecretForms()) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * A Meta-shaped token this process does not hold: "EAA" and 30 or more
 * letters and digits, standing alone (not inside a longer base64url word).
 * Removed from errors and logs only, when asked: a successful answer carries
 * advertiser text that can hold such a run, and it goes back as it was.
 */
const FOREIGN_TOKEN = /(?<![A-Za-z0-9_-])EAA[A-Za-z0-9]{30,}(?![A-Za-z0-9_-])/g;

export interface ScrubOptions {
  /** Also remove a Meta-shaped token the call does not hold (errors and logs). */
  foreignTokens?: boolean;
}

/**
 * Removes the value of any credential-shaped parameter from free text: a url
 * inside a sentence, an error message that quoted one, a fragment, or a value
 * that does not parse as a url at all. The name survives, so a reader can see
 * that something was stripped, and every other character is left alone.
 *
 * Names are matched through normalizeName, so an encoded spelling does not
 * get through, and the value ends at the first separator so a legitimate
 * parameter after it is not swallowed.
 */
export function scrubCredentials(text: string, opts: ScrubOptions = {}): string {
  text = removeSecrets(text);
  if (opts.foreignTokens) text = text.replace(FOREIGN_TOKEN, REDACTED);
  if (!text.includes("=")) return text;
  return text.replace(PAIR, (match, prefix: string, name: string, value: string) => {
    if (value.length === 0 || !isCredentialName(name)) return match;
    return `${prefix}${name}=${REDACTED}`;
  });
}

/**
 * A name=value pair where the name is any bounded run of non-separator
 * characters, so a name spelled with characters the redaction pattern does
 * not allow (access+token, access!token) is still recognized. Used where the
 * whole value can be dropped, which is why it can afford to be this loose:
 * it still requires an actual assignment, and / and ? end a name, so an
 * ordinary route keeps its path even when it carries a query:
 * #/products/password-manager?color=blue reads as color=blue.
 */
const LOOSE_PAIR = /([^=&#;,?/\s]{1,80})=([^&#;,\s]+)/g;

export function carriesCredentialPair(text: string): boolean {
  const decoded = decodeRepeatedly(text);
  for (const candidate of [text, decoded]) {
    LOOSE_PAIR.lastIndex = 0;
    let match: RegExpExecArray | null;
    while ((match = LOOSE_PAIR.exec(candidate)) !== null) {
      if (mentionsCredential(match[1])) return true;
    }
  }
  return false;
}

/** True when the text carries a credential-shaped parameter with a value. */
export function hasCredential(text: string): boolean {
  return scrubCredentials(text) !== text;
}

/**
 * The same cleaning for a parsed JSON value, at any depth: a credential-named
 * field keeps its name and loses its value, every string is scrubbed, and a
 * known secret (the token a call used) is removed wherever it appears, even
 * outside a name=value pair. Values other than plain objects, arrays and
 * strings are returned as they are. It walks with its own stack and keeps
 * each copy, so a cycle stays a cycle and no depth overflows the call stack.
 */
export function scrubCredentialsDeep<T>(value: T, secret?: string, opts: ScrubOptions = {}): T {
  const cleanString = (text: string) =>
    scrubCredentials(secret && secret.length >= 8 ? text.split(secret).join(REDACTED) : text, opts);
  const isPlain = (item: unknown): item is Record<string, unknown> | unknown[] => {
    if (Array.isArray(item)) return true;
    if (item === null || typeof item !== "object") return false;
    const proto = Object.getPrototypeOf(item);
    return proto === Object.prototype || proto === null;
  };
  if (typeof value === "string") return cleanString(value) as T;
  if (!isPlain(value)) return value;

  const copies = new Map<object, Record<string, unknown> | unknown[]>();
  const pending: Array<[Record<string, unknown> | unknown[], Record<string, unknown> | unknown[]]> = [];
  const copyOf = (source: Record<string, unknown> | unknown[]) => {
    const copy = Array.isArray(source) ? [] : {};
    copies.set(source, copy);
    pending.push([source, copy]);
    return copy;
  };
  const root = copyOf(value);
  while (pending.length > 0) {
    const [source, target] = pending.pop()!;
    for (const [key, item] of Object.entries(source)) {
      let cleaned: unknown;
      if (!Array.isArray(source) && isCredentialName(key) && item !== undefined && item !== null && item !== "") cleaned = REDACTED;
      else if (typeof item === "string") cleaned = cleanString(item);
      else if (isPlain(item)) cleaned = copies.get(item) ?? copyOf(item);
      else cleaned = item;
      // Defined, not assigned: an own "__proto__" field stays a field.
      Object.defineProperty(target, key, { value: cleaned, enumerable: true, writable: true, configurable: true });
    }
  }
  return root as T;
}

// An error is cleaned of Meta-shaped tokens the call does not hold, too.
const FOREIGN: ScrubOptions = { foreignTokens: true };

const WITHHELD = "The error's details were withheld: they could not be cleaned of credentials.";
const MAX_CAUSES = 8;

// The JSON a value would serialize to; an Error inside it serializes to {}.
// A value that cannot be serialized (a cycle) counts as unknown.
function jsonOf(value: unknown): unknown {
  return value === undefined ? undefined : JSON.parse(JSON.stringify(value) ?? "null");
}

/**
 * Every error is replaced by a new one that holds nothing of the original but
 * an allowlist, each part cleaned: its message with its causes' messages
 * after it, its name and its code; an McpError keeps its code and its data,
 * cleaned as JSON, so callers that classify errors (wasRefused) see the same
 * thing. There is no check for whether the original carries a credential:
 * whatever is not on the list (a stack, another field, a nested error, a
 * reference back to the original) is never passed on, so nothing can be
 * missed. It never throws: if the error cannot be read, a fixed one that
 * withholds its details takes its place. A thrown string is cleaned, and
 * any other thrown value becomes an Error with its cleaned text.
 */
export function scrubErrorCredentials<E>(error: E, secret?: string): E {
  try {
    if (typeof error === "string") return scrubCredentialsDeep(error, secret, FOREIGN);
    if (!(error instanceof Error)) return new Error(scrubCredentialsDeep(String(error), secret, FOREIGN)) as E;
    return rebuilt(error, secret) as E;
  } catch {
    return new Error(WITHHELD) as E;
  }
}

function causesOf(error: Error): Error[] {
  const causes: Error[] = [];
  const seen = new Set<unknown>([error]);
  let cause = error.cause;
  while (causes.length < MAX_CAUSES && cause instanceof Error && !seen.has(cause)) {
    seen.add(cause);
    causes.push(cause);
    cause = cause.cause;
  }
  return causes;
}

function rebuilt(error: Error, secret: string | undefined): Error {
  const clean = (text: unknown) => scrubCredentialsDeep(String(text), secret, FOREIGN);
  const message = [clean(error.message), ...causesOf(error).map((cause) => `(cause: ${clean(cause.message)})`)].join(" ");
  if (error instanceof McpError) {
    const prefix = `MCP error ${error.code}: `;
    let data: unknown;
    try {
      data = scrubCredentialsDeep(jsonOf(error.data), secret, FOREIGN);
    } catch {
      data = undefined;
    }
    return new McpError(error.code, message.startsWith(prefix) ? message.slice(prefix.length) : message, data);
  }
  const replacement = new Error(message);
  replacement.name = clean(error.name);
  const code = (error as { code?: unknown }).code;
  if (typeof code === "string" || typeof code === "number") {
    Object.assign(replacement, { code: typeof code === "string" ? clean(code) : code });
  }
  return replacement;
}

/**
 * Same job for a string that is a whole url, using the platform parser so
 * percent-encoded names are decoded the way a server would decode them.
 * Returns undefined when the url does not parse.
 */
export function scrubUrlCredentials(raw: string): string | undefined {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return undefined;
  }
  let changed = false;

  if (url.username !== "" || url.password !== "") {
    url.username = "";
    url.password = "";
    changed = true;
  }

  const kept: Array<[string, string]> = [];
  let droppedParam = false;
  for (const [name, value] of url.searchParams) {
    if (isCredentialName(name)) droppedParam = true;
    else kept.push([name, value]);
  }
  if (droppedParam) {
    // Rebuilt in one pass: deleting inside the iteration is quadratic in the
    // number of parameters.
    url.search = new URLSearchParams(kept).toString();
    changed = true;
  }

  // A fragment goes only when it actually carries a credential as a
  // name=value pair, decoded first so an encoded name is caught. Dropping it
  // whenever a credential word appeared anywhere cost ordinary shop urls
  // their route (#/products/password-manager), which is data the reader needs;
  // a credential spelled as a path segment is inside the documented scope.
  if (url.hash.length > 1 && carriesCredentialPair(url.hash)) {
    url.hash = "";
    changed = true;
  }

  return changed ? url.toString() : raw;
}
