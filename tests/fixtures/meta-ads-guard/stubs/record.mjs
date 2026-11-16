// Stub guard: appends each message it reads (a descriptor or an outcome record) as one line to the file argv[2],
// then allows the descriptor or acks the record. The file existing at all shows the guard ran.
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  appendFileSync(process.argv[2], input.endsWith("\n") ? input : input + "\n");
  const msg = JSON.parse(input);
  const reply = "outcome_for" in msg
    ? { v: "1.0", ack: true, receipt: "record-outcome-receipt" }
    : { v: "1.0", allow: true, reason: "record allows", basis: "non-spending", receipt: "record-receipt" };
  process.stdout.write(JSON.stringify(reply) + "\n");
});
