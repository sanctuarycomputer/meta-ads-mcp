// Stub guard: ignores SIGTERM and never exits, so only SIGKILL stops it.
// argv[2]: a file to write its pid to, so a test can check it was killed.
import { writeFileSync } from "node:fs";
if (process.argv[2]) writeFileSync(process.argv[2], String(process.pid));
process.on("SIGTERM", () => {});
process.stdin.resume();
setInterval(() => {}, 1000);
