// Stub guard: allows with one valid reply line exactly argv[2] bytes long (newline included), padded in `reason`.
const size = Number(process.argv[2]);
const base = { v: "1.0", allow: true, reason: "", basis: null, receipt: "pad-receipt" };
const pad = size - (JSON.stringify(base).length + 1);
const line = JSON.stringify({ ...base, reason: "x".repeat(Math.max(0, pad)) }) + "\n";
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(line));
