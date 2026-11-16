/**
 * Done-when 6 (ruling d-20261116-071958811): CI's secret scan runs the pinned
 * gitleaks binary, checked against its sha256 before it is unpacked, instead of
 * gitleaks-action, which needs an org licence. Read as text: no YAML parser.
 * Each step's run block is compared line for line, so an added `|| true`,
 * `set +e`, hardcoded version or `--exit-code 0` fails a case.
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

/** The step named `name` in the job: its text up to the next step or the end. */
function step(name: string): string {
  const job = secretScanJob();
  const at = job.indexOf(`      - name: ${name}\n`);
  expect(at, `step "${name}"`).toBeGreaterThanOrEqual(0);
  const rest = job.slice(at + 1);
  const next = rest.search(/^ {6}- name:/m);
  return next === -1 ? job.slice(at) : job.slice(at, at + 1 + next);
}

/** The step's `run: |` block as trimmed non-blank, non-comment lines, and its other keys. */
function runLines(name: string): { keys: string[]; lines: string[] } {
  const text = step(name);
  const runAt = text.search(/^ {8}run: \|\s*$/m);
  expect(runAt, `step "${name}" has a run block`).toBeGreaterThanOrEqual(0);
  const keys = text
    .slice(0, runAt)
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  const lines = text
    .slice(runAt)
    .split("\n")
    .slice(1)
    .map((l) => l.trim())
    .filter((l) => l !== "" && !l.startsWith("#"));
  return { keys, lines };
}

describe("CI secret scan (done-when 6)", () => {
  it("does not use gitleaks-action", () => {
    expect(ci).not.toContain("gitleaks/gitleaks-action");
    expect(ci).not.toContain("GITLEAKS_LICENSE");
  });

  it("installs the pinned binary and checks its sha256 before unpacking", () => {
    expect(secretScanJob()).toMatch(/^ {6}GITLEAKS_SHA256: ['"]?[0-9a-f]{64}['"]?\s*$/m);
    const { keys, lines } = runLines("Install pinned gitleaks");
    expect(keys).toEqual([]);
    expect(lines).toEqual([
      "set -euo pipefail",
      'curl -fsSL --retry 3 -o /tmp/gitleaks.tgz "https://github.com/gitleaks/gitleaks/releases/download/v${GITLEAKS_VERSION}/gitleaks_${GITLEAKS_VERSION}_linux_x64.tar.gz"',
      'echo "${GITLEAKS_SHA256}  /tmp/gitleaks.tgz" | sha256sum -c -',
      "sudo tar -xzf /tmp/gitleaks.tgz -C /usr/local/bin gitleaks",
      "gitleaks version",
    ]);
  });

  it("takes the version from .gitleaks-version and validates it as bare semver", () => {
    expect(readFileSync(`${root}.gitleaks-version`, "utf8").trim()).toMatch(/^[0-9]+\.[0-9]+\.[0-9]+$/);
    const { keys, lines } = runLines("Resolve pinned gitleaks version");
    expect(keys).toEqual([]);
    expect(lines).toEqual([
      "version=\"$(tr -d '[:space:]' < .gitleaks-version)\"",
      "if ! printf '%s' \"$version\" | grep -qE '^[0-9]+\\.[0-9]+\\.[0-9]+$'; then",
      'echo "::error::.gitleaks-version must contain a bare semver (got: $version)"',
      "exit 1",
      "fi",
      'echo "GITLEAKS_VERSION=$version" >> "$GITHUB_ENV"',
    ]);
  });

  it("fails on a leak, scanning the checked-out ref's whole history with the repo config", () => {
    expect(step("Checkout")).toMatch(/^ {10}fetch-depth: 0\s*$/m);
    const { keys, lines } = runLines("Run gitleaks");
    expect(keys).toEqual([]);
    expect(lines).toEqual([
      "set -euo pipefail",
      "gitleaks git --config .gitleaks.toml --redact --no-banner --exit-code 1 --log-opts=HEAD .",
    ]);
    expect(secretScanJob()).not.toContain("continue-on-error");
  });

  it("always runs: no if: in the job and no path filter on its triggers", () => {
    expect(secretScanJob()).not.toMatch(/^\s+(-\s+)?['"]?if['"]?\s*:/m);
    const on = ci.slice(ci.search(/^on:\s*$/m), ci.search(/^concurrency:\s*$/m));
    expect(on).toBe("on:\n  pull_request:\n  push:\n    branches: [main]\n\n");
  });
});
