// Stub guard: reads stdin to its end, then allows a descriptor or acks an outcome record.
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  const msg = JSON.parse(input);
  const reply = "outcome_for" in msg
    ? { v: "1.0", ack: true, receipt: "stub-outcome-receipt" }
    : { v: "1.0", allow: true, reason: "stub allows", basis: "non-spending", receipt: "stub-receipt" };
  process.stdout.write(JSON.stringify(reply) + "\n");
});
