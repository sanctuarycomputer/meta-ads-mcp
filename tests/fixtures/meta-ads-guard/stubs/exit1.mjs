// Stub guard: prints an allow line, then exits 1 (a non-zero exit refuses whatever stdout says).
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ v: "1.0", allow: true, reason: "x", basis: null, receipt: "r" }) + "\n");
  process.exitCode = 1;
});
