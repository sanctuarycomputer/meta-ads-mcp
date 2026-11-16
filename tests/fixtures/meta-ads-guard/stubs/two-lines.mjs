// Stub guard: exits 0 with two valid allow lines.
process.stdin.resume();
process.stdin.on("end", () => {
  const line = JSON.stringify({ v: "1.0", allow: true, reason: "x", basis: null, receipt: "r" });
  process.stdout.write(line + "\n" + line + "\n");
});
