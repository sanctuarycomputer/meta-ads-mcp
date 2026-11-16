/**
 * Stdio startup (ticket 252, spec check 3; done-when 3).
 *
 * src/index.ts is loaded fresh for each case with process.argv set, both
 * transports' start functions replaced, process.exit stubbed to throw, and
 * the things stdio must not touch watched: net listeners, the Firestore
 * constructor, the HTTP transport module, stdout and the console, and where
 * the logger writes.
 */
import net from "node:net";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { isStdioTransport } from "../../src/utils/transport-mode.js";

const state = vi.hoisted(() => ({
  httpLoaded: 0,
  firestoreConstructed: 0,
  started: [] as string[],
  listed: [] as string[],
  pino: [] as Array<{ options: unknown; destination: unknown }>,
  httpFactory: undefined as undefined | (() => McpServer),
  settle: (_how: string) => {},
}));

vi.mock("../../src/transport/stdio.js", () => ({
  startStdioTransport: vi.fn(async (server: McpServer) => {
    state.started.push("stdio");
    const client = new Client({ name: "probe", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(b), client.connect(a)]); // runs initialize
    state.listed = (await client.listTools()).tools.map((t) => t.name);
    await client.close();
    await server.close();
    state.settle("stdio");
  }),
}));

// Registered per launch (vi.doMock), so its factory runs, and counts, each time a fresh src/index.ts loads it.
function mockHttp(): void {
  vi.doMock("../../src/transport/http.js", () => {
    state.httpLoaded++;
    return {
      startHttpTransport: vi.fn(async (factory: () => McpServer) => {
        state.httpFactory = factory;
        state.started.push("http");
        state.settle("http");
      }),
    };
  });
}

vi.mock("@google-cloud/firestore", () => ({
  Firestore: class {
    constructor() {
      state.firestoreConstructed++;
    }
  },
  FieldValue: {},
  Timestamp: class {},
}));

vi.mock("pino", () => {
  const logger: Record<string, unknown> = {};
  for (const k of ["trace", "debug", "info", "warn", "error", "fatal"]) logger[k] = () => {};
  logger.child = () => logger;
  const pino = Object.assign(
    (options: unknown, destination?: unknown) => {
      state.pino.push({ options, destination });
      return logger;
    },
    { destination: (o: unknown) => ({ destinationOf: o }), stdTimeFunctions: {}, stdSerializers: {} },
  );
  return { default: pino };
});

class Exit extends Error {
  constructor(readonly code: number | undefined) {
    super(`process.exit(${code})`);
  }
}

type Outcome = { how: string; code?: number; stderr: string };

const ENV = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY", "FIRESTORE_PROJECT_ID"] as const;
const savedEnv = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
const savedArgv = process.argv;

beforeEach(() => {
  for (const k of ENV) delete process.env[k];
  process.env.FIRESTORE_PROJECT_ID = "toolsets-test";
  state.httpLoaded = 0;
  state.firestoreConstructed = 0;
  state.started = [];
  state.listed = [];
  state.pino = [];
  state.httpFactory = undefined;
});

afterEach(() => {
  process.argv = savedArgv;
  for (const k of ENV) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  vi.restoreAllMocks();
});

/** Load src/index.ts fresh with these arguments; resolve when a transport has started or the process exited. */
async function launch(args: string[], env: Record<string, string> = {}): Promise<Outcome> {
  Object.assign(process.env, env);
  process.argv = ["node", "dist/index.js", ...args];
  vi.resetModules();
  mockHttp();
  let stderr = "";
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write);
  vi.spyOn(process, "exit").mockImplementation(((code?: number) => {
    throw new Exit(code);
  }) as typeof process.exit);
  const started = new Promise<string>((resolve) => {
    state.settle = resolve;
  });
  try {
    await import("../../src/index.js");
  } catch (error) {
    if (error instanceof Exit) return { how: "exit", code: error.code, stderr };
    throw error;
  }
  const how = await Promise.race([started, new Promise<string>((r) => setTimeout(() => r("timeout"), 10_000))]);
  return { how, stderr };
}

const STDIO_FORMS = [["--transport", "stdio"], ["--transport=stdio"], ["-t", "stdio"], ["-tstdio"]];

describe("stdio startup touches no network, Firestore, HTTP module or stdout (check 3)", () => {
  it.each(STDIO_FORMS)("%s %s", async (...args) => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const stdout = vi.spyOn(process.stdout, "write");
    const consoles = (["log", "info", "debug", "dir", "table", "warn"] as const).map((m) => vi.spyOn(console, m));

    const out = await launch(args.filter((a): a is string => typeof a === "string"));

    expect(out).toEqual({ how: "stdio", stderr: "" });
    expect(state.started).toEqual(["stdio"]);
    expect(state.listed).toContain("ads_get_campaigns"); // initialize and tools/list ran
    expect(state.listed).toHaveLength(34); // the env's selection (unset: the read default), not the catalogue
    expect(listen).not.toHaveBeenCalled(); // 3.1
    expect(state.firestoreConstructed).toBe(0); // 3.2
    expect(state.httpLoaded).toBe(0); // 3.3
    expect(stdout).not.toHaveBeenCalled(); // 3.5
    for (const c of consoles) expect(c).not.toHaveBeenCalled();
    expect(state.pino).toHaveLength(1); // 3.5: the logger writes to fd 2
    expect(state.pino[0].destination).toEqual({ destinationOf: { fd: 2, sync: false } });
  });

  it("http is the control: the HTTP module loads, and the logger is not on fd 2", async () => {
    const out = await launch(["--transport", "http"]);
    expect(out.how).toBe("http");
    expect(state.httpLoaded).toBe(1);
    // Each request's server is the env's selection, not the catalogue.
    const server = state.httpFactory?.();
    expect(server).toBeDefined();
    const client = new Client({ name: "probe", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server?.connect(b), client.connect(a)]);
    expect((await client.listTools()).tools).toHaveLength(34);
    await client.close();
    expect(state.pino).toHaveLength(1);
    expect(state.pino[0].destination).toBeUndefined();
  });

  it("the spies see what they watch for (controls)", async () => {
    const listen = vi.spyOn(net.Server.prototype, "listen");
    const server = net.createServer();
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    await new Promise<void>((resolve) => server.close(() => resolve()));
    expect(listen).toHaveBeenCalled();

    const stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    process.stdout.write("control\n");
    console.log("control");
    expect(stdout).toHaveBeenCalled();
    expect(log).toHaveBeenCalled();

    vi.resetModules();
    const { getFirestore } = await import("../../src/store/firestore.js");
    getFirestore();
    expect(state.firestoreConstructed).toBe(1);
  });
});

describe("--transport must be given as stdio or http (check 3.4)", () => {
  it.each([[[]], [["--transport", "sse"]], [["--transport", "HTTP"]], [["--transport="]], [["--transport"]]])(
    "%j exits 2 before either transport starts",
    async (args) => {
      const out = await launch(args);
      expect(out.how).toBe("exit");
      expect(out.code).toBe(2);
      expect(out.stderr).toMatch(/--transport must be stdio or http/);
      expect(out.stderr.trim().split("\n")).toHaveLength(1);
      expect(state.started).toEqual([]);
      expect(state.httpLoaded).toBe(0);
    },
  );
});

describe("src/index.ts and isStdioTransport agree (check 3.6)", () => {
  it.each([
    ...STDIO_FORMS,
    ["--transport", "http"],
    [],
    ["--transport", "sse"],
    ["--transport"],
    ["-xtstdio"],
    ["--transport", "http", "-tstdio"],
    ["-tstdio", "--", "--transport", "http"],
  ])("%j", async (...args) => {
    const argv = args.filter((a): a is string => typeof a === "string");
    const out = await launch(argv);
    expect(out.how === "stdio", JSON.stringify(out)).toBe(isStdioTransport(["node", "dist/index.js", ...argv]));
    if (out.how === "exit") expect(out.code).toBe(2);
  });
});
