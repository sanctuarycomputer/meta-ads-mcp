/** R6 (248 final-1b): appsecret_proof is a credential name everywhere the scrub runs. */
import { describe, it, expect } from "vitest";
import { createLogger } from "../../src/utils/logger.js";
import { scrubCredentials, scrubCredentialsDeep } from "../../src/utils/scrub-credentials.js";
import { PROOF } from "./fake-secrets.js";

describe("R6: appsecret_proof scrub", () => {
  it("appsecret_proof pair is removed", () => {
    expect(scrubCredentials(`u?appsecret_proof=${PROOF}&x=1`)).toBe("u?appsecret_proof=[REDACTED]&x=1");
  });

  it("appsecret_proof key is removed deep", () => {
    expect(scrubCredentialsDeep({ appsecret_proof: PROOF }).appsecret_proof).toBe("[REDACTED]");
  });

  it("appsecret_proof at message start in a log line is removed", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (s: string) => void lines.push(s) });
    log.info(`appsecret_proof=${PROOF} next`);
    expect(lines.join("")).not.toContain(PROOF);
  });
});
