// Stub guard: reads stdin to its end, then prints argv[2] (base64url) decoded, verbatim, and exits 0.
const out = Buffer.from(process.argv[2] ?? "", "base64url").toString("utf8");
process.stdin.resume();
process.stdin.on("end", () => process.stdout.write(out));
