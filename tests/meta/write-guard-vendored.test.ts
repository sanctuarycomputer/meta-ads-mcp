import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadFixtures } from "../fixtures/meta-ads-guard/fake-guard.mjs";

const DIR = join(fileURLToPath(new URL("../fixtures/meta-ads-guard", import.meta.url)));
const FAKE = join(DIR, "fake-guard.mjs");
const FIXTURES = join(DIR, "fixtures");

function runFake(input: string): Promise<{ code: number; stdout: string }> {
  return new Promise((resolve, reject) => {
    const child = execFile("node", [FAKE, "--fixtures", FIXTURES], (err, stdout) => {
      const code = err ? (typeof err.code === "number" ? err.code : -1) : 0;
      if (err && typeof err.code !== "number") reject(err);
      else resolve({ code, stdout });
    });
    child.stdin?.end(input);
  });
}

describe("vendored meta-ads-guard contract", () => {
  it("145 fixtures load", () => {
    expect(loadFixtures(FIXTURES)).toHaveLength(145);
  });

  it("the fake answers design-example with its reply", async () => {
    const fixture = loadFixtures(FIXTURES).find((f) => f.name === "design-example");
    expect(fixture?.descriptor).toBeDefined();
    const { code, stdout } = await runFake(JSON.stringify(fixture?.descriptor));
    expect(code).toBe(0);
    expect((JSON.parse(stdout) as { reason: string }).reason).toBe(fixture?.reply?.reason);
  });

  it("the fake exits 3 on no match", async () => {
    const fixture = loadFixtures(FIXTURES).find((f) => f.name === "a-paused-create");
    const descriptor = { ...fixture?.descriptor, request_id: "f0000000-0000-4000-8000-00000000ffff", path: "/act_9990000000000001/nomatchpath" };
    const { code, stdout } = await runFake(JSON.stringify(descriptor));
    expect(code).toBe(3);
    expect((JSON.parse(stdout) as { allow: boolean }).allow).toBe(false);
  });
});
