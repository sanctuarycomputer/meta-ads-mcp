// Stub guard: allows, with the sorted names of its environment as the receipt.
process.stdin.resume();
process.stdin.on("end", () => {
  const receipt = JSON.stringify(Object.keys(process.env).sort());
  process.stdout.write(JSON.stringify({ v: "1.0", allow: true, reason: "env", basis: null, receipt }) + "\n");
});
