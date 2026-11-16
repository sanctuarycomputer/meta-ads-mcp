// Stub guard: allows once stdin closes, with everything it read as the receipt.
// If the runner never closed stdin, this would hang until the timeout.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ v: "1.0", allow: true, reason: "stdin", basis: null, receipt: input }) + "\n");
});
