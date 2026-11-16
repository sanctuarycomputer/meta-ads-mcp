// Stub guard: prints a valid allow line, then kills itself with SIGKILL (a signal the runner did not send).
process.stdin.resume();
process.stdin.on("end", () => {
  const line = JSON.stringify({ v: "1.0", allow: true, reason: "x", basis: null, receipt: "r" }) + "\n";
  process.stdout.write(line, () => process.kill(process.pid, "SIGKILL"));
});
