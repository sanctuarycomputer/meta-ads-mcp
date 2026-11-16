// Stub wrapper: `tee-stderr.mjs <log> -- <argv…>` runs <argv…> (the vendored fake guard) with this process's stdin
// and stdout passed through and its stderr piped, then appends one JSON line per run to <log>:
// `{ stdin, stderr, exit }`, so a test sees which fixture the fake matched (its stderr names it) and every message
// the fork sent. Exits with the child's code. The child is killed when this process exits or is signalled.
import { spawn } from "node:child_process";
import { appendFileSync } from "node:fs";

const [log, sep, ...argv] = process.argv.slice(2);
if (!log || sep !== "--" || argv.length === 0) {
  process.stderr.write("usage: tee-stderr.mjs <log> -- <argv…>\n");
  process.exit(64);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const stdin = Buffer.concat(chunks).toString("utf8");

const child = spawn(argv[0], argv.slice(1), { stdio: ["pipe", "inherit", "pipe"] });
const kill = () => {
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
};
process.on("exit", kill);
for (const sig of ["SIGTERM", "SIGINT", "SIGHUP"]) {
  process.on(sig, () => {
    kill();
    process.exit(1);
  });
}

let stderr = "";
child.stderr.setEncoding("utf8");
child.stderr.on("data", (c) => (stderr += c));
child.stdin.on("error", () => {});
child.stdin.end(stdin);

child.on("error", (err) => {
  appendFileSync(log, JSON.stringify({ stdin, stderr: `tee-stderr: ${err.message}\n`, exit: 127, signal: null }) + "\n");
  process.exitCode = 127;
});
child.on("close", (code, signal) => {
  const exit = code ?? 1;
  appendFileSync(log, JSON.stringify({ stdin, stderr, exit, signal }) + "\n");
  process.exitCode = exit;
});
