// Stub guard: prints a valid allow line, then never exits (ignoring SIGTERM), so only the timeout's SIGKILL ends it.
process.on("SIGTERM", () => {});
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ v: "1.0", allow: true, reason: "x", basis: null, receipt: "r" }) + "\n");
});
setInterval(() => {}, 1000);
