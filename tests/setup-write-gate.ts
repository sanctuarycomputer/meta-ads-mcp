// Every test file's singleton client gets a pass-through write gate (ticket 253, Task 5): the tool suites written
// before the guard keep testing their tools, not the guard. A test of the guard itself builds its own client with
// RealWriteGate (tests/meta/write-guard-client*.test.ts) or unmocks this module.
import { randomUUID } from "node:crypto";
import { vi } from "vitest";

import type { WriteGate } from "../src/meta/write-guard.js";

/** A gate that allows every write with a fresh request_id and acks every outcome. For tests only. */
export const PASS = (): WriteGate => ({
  check: async () => ({ requestId: randomUUID(), label: null }),
  outcome: async () => null,
});

vi.mock("../src/meta/client.js", async (orig) => {
  const m = await orig<typeof import("../src/meta/client.js")>();
  return { ...m, metaApiClient: new m.MetaApiClient({ writeGateForTests: PASS }) };
});
