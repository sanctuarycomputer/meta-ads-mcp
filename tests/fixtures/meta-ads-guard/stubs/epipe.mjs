// Stub guard: closes stdin without reading it and exits 0 printing nothing (R3: a large write meets EPIPE).
process.stdin.destroy();
process.exit(0);
