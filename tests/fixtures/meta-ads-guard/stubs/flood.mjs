// Stub guard: writes far more than any output cap, then exits 0.
process.stdin.resume();
const chunk = "x".repeat(64 * 1024);
let n = 0;
function more() {
  while (n < 64) {
    n++;
    if (!process.stdout.write(chunk)) return void process.stdout.once("drain", more);
  }
}
more();
