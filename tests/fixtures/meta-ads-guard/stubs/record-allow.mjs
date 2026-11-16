// Stub guard (Task 6): appends each message it reads (a descriptor or an outcome record) as one line to the file
// argv[2], then allows the descriptor, or refuses it when its tool is the one named by an argument
// `REFUSE_TOOL=<tool>`. It acks every outcome record, or answers it with no ack when an argument is `NACK`.
// Options are arguments, not environment: the runner passes the guard only PATH, HOME and NODE_* (contract §2).
import { appendFileSync } from "node:fs";
const [log, ...opts] = process.argv.slice(2);
const refuseTool = opts.find((o) => o.startsWith("REFUSE_TOOL="))?.slice("REFUSE_TOOL=".length);
const nack = opts.includes("NACK");
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  appendFileSync(log, input.endsWith("\n") ? input : input + "\n");
  const msg = JSON.parse(input);
  let reply;
  if ("outcome_for" in msg) reply = nack ? { v: "1.0", ack: false } : { v: "1.0", ack: true, receipt: "record-allow-outcome" };
  else if (msg.tool === refuseTool) reply = { v: "1.0", allow: false, reason: `stub refuses ${msg.tool}`, basis: null, receipt: "record-allow-refusal" };
  else reply = { v: "1.0", allow: true, reason: "record-allow allows", basis: "non-spending", receipt: "record-allow-receipt" };
  process.stdout.write(JSON.stringify(reply) + "\n");
});
