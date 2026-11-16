import pino from "pino";
import {
  envSecrets,
  isCredentialName,
  scrubCredentials,
  scrubCredentialsDeep,
} from "./scrub-credentials.js";

/**
 * Field-name redaction, before serialization. The line-level scrub in
 * scrubLogLine is what keeps a secret out of the output wherever it sits; these
 * paths also catch a short credential that is not the process's own secret.
 */
export const LOG_REDACT = {
  paths: [
    "apify_token",
    "*.apify_token",
    "apifyToken",
    "*.apifyToken",
    "gemini_api_key",
    "*.gemini_api_key",
    "geminiApiKey",
    "*.geminiApiKey",
    "gemini_key",
    "*.gemini_key",
    // Bracket syntax: pino paths cannot carry a hyphen unquoted.
    'headers["x-goog-api-key"]',
    '*["x-goog-api-key"]',
    "access_token",
    "*.access_token",
    "accessToken",
    "*.accessToken",
    "authorization",
    "*.authorization",
    "headers.Authorization",
    "appsecret_proof",
    "*.appsecret_proof",
    "app_secret",
    "*.app_secret",
    "client_secret",
    "*.client_secret",
  ],
  censor: "[REDACTED]",
};

/**
 * A name=value pair right after a double quote, which the scrub's own pair
 * pattern does not treat as a separator: `"access_token=…` in raw text.
 */
const QUOTED_PAIR = /"([A-Za-z0-9_%.-]{1,64})=([^&#;,\s"'<>]*)/g;

/**
 * Cleans one serialized log line before it is written: every string at any
 * depth loses META_ACCESS_TOKEN, META_APP_SECRET and credential-named values.
 * A line that is not JSON is scrubbed as text.
 */
export function scrubLogLine(line: string): string {
  try {
    let out = JSON.stringify(scrubCredentialsDeep(JSON.parse(line) as unknown, undefined, { foreignTokens: true }));
    // The deep scrub cleans values and credential-named keys, not a key's
    // own text: remove each env secret, as JSON spells it, from the line.
    for (const secret of envSecrets()) {
      out = out.split(JSON.stringify(secret).slice(1, -1)).join("[REDACTED]");
    }
    return `${out}\n`;
  } catch {
    return scrubCredentials(line, { foreignTokens: true }).replace(QUOTED_PAIR, (match, name: string, value: string) =>
      value.length > 0 && isCredentialName(name) ? `"${name}=[REDACTED]` : match,
    );
  }
}

/**
 * The server's logger. Always JSON on stderr (fd 2): stdout carries the MCP
 * stdio protocol, and this fork runs only over stdio. Level is fixed at info.
 */
export function createLogger(
  destination: pino.DestinationStream = pino.destination({ fd: 2, sync: false }),
): pino.Logger {
  return pino(
    {
      level: "info",
      serializers: { err: pino.stdSerializers.err, error: pino.stdSerializers.err },
      redact: LOG_REDACT,
      hooks: { streamWrite: scrubLogLine },
    },
    destination,
  );
}

export const logger = createLogger();
