// Stub guard (ruling R3): refuses any descriptor with an unresolved creative_id identity entry, naming it; allows
// every other descriptor and acks outcome records. Appends each message to argv[2] when given.
import { appendFileSync } from "node:fs";
let input = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (c) => (input += c));
process.stdin.on("end", () => {
  if (process.argv[2]) appendFileSync(process.argv[2], input.endsWith("\n") ? input : input + "\n");
  const msg = JSON.parse(input);
  let reply;
  if ("outcome_for" in msg) reply = { v: "1.0", ack: true, receipt: "refuse-outcome-receipt" };
  else {
    const e = (msg.identity ?? []).find((x) => x.field === "creative_id" && x.owner_page === null && x.owner_ig === null);
    reply = e
      ? { v: "1.0", allow: false, reason: `rule 1: creative ${e.id} (${e.via}) is unresolved`, basis: null, receipt: "refuse-receipt" }
      : { v: "1.0", allow: true, reason: "no unresolved creative", basis: "non-spending", receipt: "refuse-receipt" };
  }
  process.stdout.write(JSON.stringify(reply) + "\n");
});
