// Stub guard: allows, with its working directory as the receipt.
process.stdin.resume();
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ v: "1.0", allow: true, reason: "cwd", basis: null, receipt: process.cwd() }) + "\n");
});
