// Endpoint coverage (ticket 253, Task 7): every request each of the vendored endpoints.json `coverage` tools sends
// (contract docs/contracts/meta-ads-guard.md@1.0 §4) builds a valid descriptor (buildDescriptor, validateDescriptor)
// that resolves to the row the coverage implies (matchEndpoint). The one exception is a `POST /{act}` node write
// from a tool outside ACCOUNT_TOOLS (ads_activate_entity), which M16 refuses before any read (P2-4).
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

import {
  ACCOUNT_TOOLS,
  WriteRefusal,
  buildDescriptor,
  matchEndpoint,
  validateDescriptor,
  type GraphGet,
} from "../../src/meta/write-descriptor.js";

interface CoverageRequest {
  method: "POST" | "DELETE";
  path: string;
  object_type: string;
}
interface Row {
  id: string;
  method: string;
  path: string;
  object_type: string;
}
const ENDPOINTS = JSON.parse(
  readFileSync(fileURLToPath(new URL("../fixtures/meta-ads-guard/endpoints.json", import.meta.url)), "utf8"),
) as { rows: Row[]; coverage: Array<{ tool: string; requests: CoverageRequest[] }> };

const ACT = "act_9990000000000001";
const NODE = "9994000000000001";
const EDGE_ID = "9993000000000001";

// The Graph `metadata.type` a GET answers for each contract object type; `other` and `any` are a type the
// contract does not list.
const GRAPH_TYPE: Readonly<Record<string, string>> = {
  campaign: "campaign",
  adset: "adset",
  ad: "ad",
  creative: "adcreative",
  study: "adstudy",
  audience: "customaudience",
  page_post: "post",
  other: "comment",
  any: "comment",
};

// `{act}` an account, the first `{id}` the written node (a Page post's id for a page_post), a later `{id}` an edge id.
function pathOf(r: CoverageRequest): string {
  let ids = 0;
  return r.path.replace(/\{(act|id)\}/g, (_m, p: string) => {
    if (p === "act") return ACT;
    ids += 1;
    if (ids > 1) return EDGE_ID;
    return r.object_type === "page_post" ? `9991000000000001_${NODE}` : NODE;
  });
}

// A permissive Graph: the node answers with its metadata type and a full set of facts; every listing is empty.
function graphFor(r: CoverageRequest): GraphGet {
  const type = GRAPH_TYPE[r.object_type];
  return async <T>(path: string): Promise<T> => {
    const segments = path.split("/").filter(Boolean);
    if (segments.length > 1) return { data: [] } as T;
    const facts = {
      id: segments[0],
      metadata: { type: path === `/${ACT}` ? "adaccount" : type },
      account_id: "9990000000000001",
      name: "sb-usb-h1",
      status: "PAUSED",
      effective_status: "PAUSED",
      buying_type: "AUCTION",
      spend_cap: "100000",
      amount_spent: "0",
      currency: "USD",
      business: { id: "9999000000000001" },
    };
    return facts as T;
  };
}

// The row a coverage request implies: same method and path, its object type's own row, else the `any` row.
function impliedRow(r: CoverageRequest): Row {
  const same = ENDPOINTS.rows.filter((x) => x.method === r.method && x.path === r.path);
  const row = same.find((x) => x.object_type === r.object_type) ?? same.find((x) => x.object_type === "any");
  if (!row) throw new Error(`no row for ${r.method} ${r.path} ${r.object_type}`);
  return row;
}

const cases = ENDPOINTS.coverage.flatMap((c) =>
  c.requests.map((r) => [`${c.tool}: ${r.method} ${r.path} (${r.object_type})`, c.tool, r] as const),
);
const isAccountNode = (r: CoverageRequest) => r.method === "POST" && r.path === "/{act}";

describe("endpoints.json coverage", () => {
  it("lists 65 tools, each once", () => {
    const tools = ENDPOINTS.coverage.map((c) => c.tool);
    expect(tools).toHaveLength(65);
    expect(new Set(tools).size).toBe(65);
  });

  it("the only account-node writer outside ACCOUNT_TOOLS is ads_activate_entity", () => {
    const outside = cases.filter(([, tool, r]) => isAccountNode(r) && !ACCOUNT_TOOLS.has(tool)).map(([, tool]) => tool);
    expect(outside).toEqual(["ads_activate_entity"]);
  });

  it.each(cases)("%s", async (_name, tool, r) => {
    const req = { method: r.method, path: pathOf(r), params: r.method === "DELETE" ? {} : { name: "n" } };
    const ctx = { tool, validateOnly: false, requestId: "f0000000-0000-4000-8000-000000000999", accounts: new Set<string>() };
    if (isAccountNode(r) && !ACCOUNT_TOOLS.has(tool)) {
      // M16 (P2-4): refused before any read.
      const reads: string[] = [];
      const get: GraphGet = async (path) => {
        reads.push(path);
        throw new Error("no read expected");
      };
      const err = await buildDescriptor(req, ctx, get).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(WriteRefusal);
      expect((err as Error).message).toBe(`MCP error -32600: write refused: ${tool} expects a non-account object, ${ACT} is a account`);
      expect(reads).toEqual([]);
      return;
    }
    const d = await buildDescriptor(req, ctx, graphFor(r));
    expect(validateDescriptor(d)).toEqual([]);
    expect(d.tool).toBe(tool);
    expect(matchEndpoint(d.method, d.path, d.object.type)?.id).toBe(impliedRow(r).id);
  });
});
