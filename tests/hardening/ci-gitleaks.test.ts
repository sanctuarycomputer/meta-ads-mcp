/**
 * Done-when 6 (ruling d-20261116-071958811): CI's secret scan runs the pinned
 * gitleaks binary, checked against its sha256 before it is unpacked, instead of
 * gitleaks-action, which needs an org licence. Read as text: no YAML parser.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const ci = readFileSync(`${root}.github/workflows/ci.yml`, "utf8");

/** The `secret-scan` job: from its key to the next top-level job key, or the end. */
function secretScanJob(): string {
  const start = ci.search(/^ {2}secret-scan:\s*$/m);
  expect(start, "ci.yml has a secret-scan job").toBeGreaterThanOrEqual(0);
  const rest = ci.slice(start + 1);
  const next = rest.search(/^ {2}[A-Za-z0-9_-]+:\s*$/m);
  return next === -1 ? ci.slice(start) : ci.slice(start, start + 1 + next);
}

describe("CI secret scan (done-when 6)", () => {
  it("does not use gitleaks-action", () => {
    expect(ci).not.toContain("gitleaks/gitleaks-action");
    expect(ci).not.toContain("GITLEAKS_LICENSE");
  });

  it("installs the pinned binary and checks its sha256 before unpacking", () => {
    const job = secretScanJob();
    expect(job).toContain(
      "releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz",
    );
    expect(job).toMatch(/^\s+GITLEAKS_SHA256:\s*['"]?[0-9a-f]{64}['"]?\s*$/m);
    const checkLine = /^\s+echo "\$\{GITLEAKS_SHA256\}  \/tmp\/gitleaks\.tgz" \| sha256sum -c -\s*$/m;
    expect(job).toMatch(checkLine);
    const checkAt = job.search(checkLine);
    const untarAt = job.search(/tar -xzf \/tmp\/gitleaks\.tgz/);
    expect(untarAt).toBeGreaterThan(checkAt);
    // The install step stops on the first failure, the checksum's included.
    const installStep = job.slice(job.lastIndexOf("- name:", checkAt), untarAt);
    expect(installStep).toContain("set -euo pipefail");
  });

  it("takes the version from .gitleaks-version and validates it as bare semver", () => {
    const job = secretScanJob();
    expect(job).toContain(".gitleaks-version");
    expect(job).toContain("^[0-9]+\\.[0-9]+\\.[0-9]+$");
  });

  it("scans the checked-out ref's whole history with the repo config", () => {
    const job = secretScanJob();
    expect(job).toMatch(/fetch-depth:\s*0/);
    const run = job.match(/^\s+gitleaks git .*$/m)?.[0] ?? "";
    expect(run, "a gitleaks git command").not.toBe("");
    expect(run).toContain("--config .gitleaks.toml");
    expect(run).toContain("--redact");
    const logOpts = [...run.matchAll(/--log-opts(?:=|\s+)(\S+)/g)].map((m) => m[1]);
    expect(logOpts).toEqual(["HEAD"]);
    expect(job).not.toContain("continue-on-error");
  });

  it("always runs: no if: anywhere in the job", () => {
    expect(secretScanJob()).not.toMatch(/^\s+(-\s+)?if:/m);
  });
});
