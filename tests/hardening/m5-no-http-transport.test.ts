/**
 * M5: the fork has no HTTP transport. startHttpTransport is a shim that
 * refuses before opening a port, and the old auth/transport stack is gone.
 */
import { describe, it, expect, vi } from "vitest";
import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { startHttpTransport } from "../../src/transport/http.js";

const root = fileURLToPath(new URL("../../", import.meta.url));
const REMOVED = "HTTP transport removed in this fork: start with --transport stdio";

const DELETED = [
  "src/transport/auth-routes.ts",
  "src/transport/authorize-validation.ts",
  "src/transport/html-pages.ts",
  "src/transport/security-config.ts",
  "src/auth/oauth-provider.ts",
  "src/auth/session.ts",
  "src/auth/oauth-state.ts",
  "src/auth/api-key.ts",
  "src/auth/email-allowlist.ts",
  "src/auth/crypto.ts",
  "src/store/firestore.ts",
  "src/store/persistent-auth-codes.ts",
  "src/store/persistent-clients-store.ts",
  "src/store/persistent-jti-store.ts",
  "src/utils/html.ts",
  "src/utils/with-deadline.ts",
];

describe("M5: no HTTP transport", () => {
  it("startHttpTransport refuses without listening", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    try {
      await expect(startHttpTransport(() => ({}) as never, 0)).rejects.toThrow(REMOVED);
      expect(listen).not.toHaveBeenCalled();
    } finally {
      listen.mockRestore();
    }
  });

  it("http shim imports nothing of the old stack", () => {
    const src = readFileSync(`${root}src/transport/http.ts`, "utf8");
    for (const banned of [/express/, /cors/, /cookie-parser/, /oauth/i, /session/i, /store\//]) {
      expect(src).not.toMatch(banned);
    }
  });

  it("dead auth and transport files are gone", () => {
    for (const file of DELETED) expect(existsSync(`${root}${file}`), file).toBe(false);
  });

  it(
    "index with --transport http exits non-zero without listening",
    async () => {
      const child = spawn(process.execPath, ["--import", "tsx", "src/index.ts", "--transport", "http", "--port", "0"], {
        cwd: root,
        env: { PATH: process.env.PATH },
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      let stdout = "";
      child.stderr.on("data", (d: Buffer) => (stderr += d.toString()));
      child.stdout.on("data", (d: Buffer) => (stdout += d.toString()));
      const kill = setTimeout(() => child.kill("SIGKILL"), 20_000);
      const code = await new Promise<number | null>((resolve) => child.on("close", resolve));
      clearTimeout(kill);
      expect(code).toBe(1);
      expect(stderr).toContain("HTTP transport removed in this fork");
      expect(`${stdout}${stderr}`).not.toMatch(/listening/i);
    },
    30_000,
  );
});
