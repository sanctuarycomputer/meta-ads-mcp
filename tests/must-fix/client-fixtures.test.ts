// Contract docs/contracts/meta-ads-guard.md@1.1 §2 (hosts) and §13 (client fixtures), spec check 2 "Hosts" and
// check 6 "Client fixtures": each `for: "client"` fixture's request goes through the real client. A video upload
// (`POST /act_{id}/advideos`) goes to graph-video.facebook.com, which takes nothing else; every other request goes
// to the client's base host. The gate is a recording one (it allows and counts), so what is decided here is the
// client's alone.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { MetaApiClient } from "../../src/meta/client.js";
import { WriteRefusal } from "../../src/meta/write-descriptor.js";
import { callContext, newCallContext, type WriteGate } from "../../src/meta/write-guard.js";
import { loadFixtures, type Fixture } from "../fixtures/meta-ads-guard/fake-guard.mjs";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";

const FIXTURE_DIR = join(fileURLToPath(new URL("../fixtures/meta-ads-guard", import.meta.url)), "fixtures");
const CLIENT_FIXTURES = loadFixtures(FIXTURE_DIR).filter((f) => f.for === "client");
const refused = (detail: string) => `MCP error -32600: write refused: ${detail}`;

interface ClientRequest {
  method: "GET" | "POST";
  host: string;
  path: string;
}

let fetches: URL[];
let asked: number;

const recordingGate = (): WriteGate => ({
  check: async () => {
    asked++;
    return { requestId: randomUUID(), label: null };
  },
  outcome: async () => null,
});

function clientAt(baseUrl?: string): MetaApiClient {
  return new MetaApiClient({ maxRetries: 0, ...(baseUrl === undefined ? {} : { baseUrl }), writeGateForTests: recordingGate });
}

// The fixture's path carries Graph's `/v<n>` prefix; the client joins its own.
const clientPath = (path: string): string => path.replace(/^\/v\d+\.\d+/, "");
const VIDEO_PATH = "/act_9990000000000001/advideos";

/** Sends one request through `client` inside a write tool's call: a GET, or a POST as a multipart upload. */
function send(client: MetaApiClient, method: "GET" | "POST", path: string): Promise<unknown> {
  return callContext.run(newCallContext("ads_test_upload", false), () => {
    if (method === "GET") return client.get(path, { fields: "id" });
    const form = new FormData();
    form.set("name", "clip");
    form.set("source", new Blob([new Uint8Array([1, 2, 3])], { type: "video/mp4" }), "clip.mp4");
    return client.postMultipart(path, form);
  });
}

async function refusalOf(p: Promise<unknown>): Promise<unknown> {
  try {
    await p;
  } catch (e) {
    return e;
  }
  throw new Error("expected a refusal, got a resolve");
}

beforeEach(() => {
  setupTestToken();
  fetches = [];
  asked = 0;
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: string) => {
      fetches.push(new URL(input));
      return mockFetchResponse({ id: "9990000000099999" });
    }),
  );
});

afterEach(() => {
  cleanupTestToken();
  vi.unstubAllGlobals();
});

describe("contract §13 client fixtures, through the real client", () => {
  it("are exactly the three host fixtures", () => {
    expect(CLIENT_FIXTURES.map((f) => f.name).sort()).toEqual(["host-video-get", "host-video-other-path", "host-video-upload"]);
  });

  it.each(CLIENT_FIXTURES.map((f) => [f.name, f] as const))("%s", async (_name, f: Fixture) => {
    const req = f.request as ClientRequest;
    if (f.client === "ask-guard") {
      // The default client: the row routes the upload to its host.
      await expect(send(clientAt(), req.method, clientPath(req.path))).resolves.toEqual({ id: "9990000000099999" });
      expect(asked).toBe(1);
      expect(fetches.map((u) => u.host)).toEqual([req.host]);
      expect(fetches[0].pathname).toMatch(new RegExp(`^/v\\d+\\.\\d+${clientPath(req.path)}$`));
    } else {
      expect(f.client).toBe("refuse");
      // A client whose base host is the fixture's: the host check alone refuses it.
      const err = await refusalOf(send(clientAt(`https://${req.host}`), req.method, clientPath(req.path)));
      expect(err).toBeInstanceOf(WriteRefusal);
      expect((err as Error).message).toBe(refused("the host graph-video.facebook.com takes only POST /act_{id}/advideos"));
      expect(fetches).toEqual([]);
      expect(asked).toBe(0);
    }
  });
});

describe("hosts: only the video row moves a request", () => {
  it("a GET from the default client goes to graph.facebook.com", async () => {
    await send(clientAt(), "GET", "/act_9990000000000001/advideos");
    expect(fetches.map((u) => u.host)).toEqual(["graph.facebook.com"]);
  });

  it("POST /act_<n>/adimages from the default client goes to graph.facebook.com", async () => {
    await send(clientAt(), "POST", "/act_9990000000000001/adimages");
    expect(asked).toBe(1);
    expect(fetches.map((u) => u.host)).toEqual(["graph.facebook.com"]);
  });

  it("a video upload from a client on graph-video.facebook.com goes there too", async () => {
    await send(clientAt("https://graph-video.facebook.com"), "POST", "/act_9990000000000001/advideos");
    expect(asked).toBe(1);
    expect(fetches.map((u) => u.host)).toEqual(["graph-video.facebook.com"]);
  });

  // T2-1: every sender passes its own method to the routing; the fork's video senders today use postForm
  // (creatives.ts, bulk-ads.ts: ruling O5). A DELETE of the same path matches no host row and stays.
  it.each([
    ["post", () => clientAt().post(VIDEO_PATH, { name: "clip", file_url: "https://example.com/clip.mp4" }), "graph-video.facebook.com"],
    ["postForm", () => clientAt().postForm(VIDEO_PATH, { name: "clip", file_url: "https://example.com/clip.mp4" }), "graph-video.facebook.com"],
    ["delete", () => clientAt().delete(VIDEO_PATH, { name: "clip" }), "graph.facebook.com"],
    ["delete (form body)", () => clientAt().delete(VIDEO_PATH, { name: "clip" }, undefined, { formBody: true }), "graph.facebook.com"],
  ] as const)("%s of /act_<n>/advideos from the default client goes to its host", async (_m, call, host) => {
    await callContext.run(newCallContext("ads_test_upload", false), call);
    expect(asked).toBe(1);
    expect(fetches.map((u) => u.host)).toEqual([host]);
  });

  // A request the row does not move keeps the client's base, port and all: the existing checks refuse it first.
  it("a client on graph-video.facebook.com with a port is refused for its port, before the host's rows", async () => {
    const err = await refusalOf(send(clientAt("https://graph-video.facebook.com:8443"), "GET", "/act_9990000000000001/advideos"));
    expect((err as Error).message).toBe(refused("the base URL has a port"));
    expect(fetches).toEqual([]);
    expect(asked).toBe(0);
  });
});
