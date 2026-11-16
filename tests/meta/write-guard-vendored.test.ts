import { describe, expect, it } from "vitest";
import { execFile } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { hostAllowed as fakeHostAllowed, loadFixtures } from "../fixtures/meta-ads-guard/fake-guard.mjs";
import { hostAllowed } from "../../src/meta/write-descriptor.js";

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
  it("169 fixtures load", () => {
    expect(loadFixtures(FIXTURES)).toHaveLength(169);
  });

  it("hostAllowed is the fake's (contract 1.1 §2, C14), on every method, host and path below", () => {
    const endpoints = JSON.parse(readFileSync(join(DIR, "endpoints.json"), "utf8")) as unknown;
    const hosts = ["graph.facebook.com", "graph-video.facebook.com", "graph-video.facebook.com:443", "GRAPH-VIDEO.facebook.com", "evil.example"];
    const paths = ["/v23.0/act_1/advideos", "/act_1/advideos", "/act_1/adimages", "/v23.0/1", "/1/advideos", "/act_1/advideos/x"];
    let allowed = 0;
    for (const method of ["GET", "POST", "DELETE"]) {
      for (const host of hosts) {
        for (const path of paths) {
          const got = hostAllowed(method, host, path);
          expect(got, `${method} ${host} ${path}`).toBe(fakeHostAllowed(endpoints, method, host, path));
          if (got && host !== "graph.facebook.com") allowed++;
        }
      }
    }
    // Off graph.facebook.com, only the two video upload paths, by POST, on the video host itself.
    expect(allowed).toBe(2);
    expect(hostAllowed("POST", "graph-video.facebook.com", "/v23.0/act_1/advideos")).toBe(true);
    expect(hostAllowed("GET", "graph-video.facebook.com", "/v23.0/act_1/advideos")).toBe(false);
    expect(hostAllowed("POST", "graph-video.facebook.com", "/v23.0/act_1/adimages")).toBe(false);
    expect(hostAllowed("DELETE", "graph.facebook.com", "/v23.0/1")).toBe(true);
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
