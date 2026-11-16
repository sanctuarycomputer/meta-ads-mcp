// validate_only and the tool result rules (ticket 253, Task 6; spec §Design "validate_only results", "Result order",
// spec-3 S3-2 and S3-3): served tools through createServer, an in-memory MCP client, and the real gate (RealWriteGate
// and a GuardRunner running tests/fixtures/meta-ads-guard/stubs/record-allow.mjs), never tests/setup-write-gate.ts.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createServer } from "../../src/server.js";
import { cleanupTestToken, mockFetchResponse, setupTestToken } from "../setup.js";
import {
  ADSET, BUSINESS, CAMP, LABEL, NOT_SENT, NO_WRITE, connect, descriptors, dropGuard, fake, formOf, graphError,
  installFetch, smallWorld, textOf, useGuard, writes, type ToolResult,
} from "./validate-only-helpers.js";

// The singleton every tool uses, with the real gate in place of setup-write-gate.ts's pass-through one.
const guard = vi.hoisted(() => ({ env: {} as NodeJS.ProcessEnv }));
vi.unmock("../../src/meta/client.js");
vi.mock("../../src/meta/client.js", async (orig) => {
  const m = await orig<typeof import("../../src/meta/client.js")>();
  const { GuardRunner, RealWriteGate } = await import("../../src/meta/write-guard.js");
  const { fileURLToPath } = await import("node:url");
  const cwd = fileURLToPath(new URL("../..", import.meta.url));
  return {
    ...m,
    metaApiClient: new m.MetaApiClient({
      maxRetries: 0,
      writeGateForTests: (get) => new RealWriteGate(get, new GuardRunner({ env: guard.env, cwd, timeoutMs: 15_000 })),
    }),
  };
});

const WRITE_LIST = "campaigns:write,adsets:write,ads:write,creatives:write,abtesting:write";
const ENV_KEYS = ["META_ADS_TOOLSETS", "META_ADS_READ_ONLY"] as const;
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

async function call(name: string, args: Record<string, unknown>): Promise<ToolResult> {
  const { client, close } = await connect(createServer());
  try {
    return (await client.callTool({ name, arguments: args })) as ToolResult;
  } finally {
    await close();
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) delete process.env[k];
  process.env.META_ADS_TOOLSETS = WRITE_LIST;
  setupTestToken();
  fake.calls = [];
  fake.world = smallWorld();
  fake.onWrite = () => mockFetchResponse({ success: true });
  installFetch();
  for (const k of Object.keys(guard.env)) delete guard.env[k];
  useGuard(guard.env);
});

afterEach(() => {
  cleanupTestToken();
  vi.unstubAllGlobals();
  dropGuard();
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("the validate_only argument", () => {
  it("every served write tool takes it, optional, and no read tool does", async () => {
    process.env.META_ADS_TOOLSETS = `${WRITE_LIST},campaigns,adsets`;
    const { client, close } = await connect(createServer());
    try {
      const { tools } = await client.listTools();
      const write = tools.filter((t) => t.annotations?.readOnlyHint !== true);
      const read = tools.filter((t) => t.annotations?.readOnlyHint === true);
      expect(write).toHaveLength(16);
      expect(read.length).toBeGreaterThan(0);
      for (const t of write) {
        expect(t.inputSchema.properties?.validate_only, t.name).toEqual({
          type: "boolean",
          description: "Ask Meta to check the write without making it",
        });
        expect(t.inputSchema.required ?? [], t.name).not.toContain("validate_only");
      }
      for (const t of read) expect(Object.keys(t.inputSchema.properties ?? {}), t.name).not.toContain("validate_only");
    } finally {
      await close();
    }
  });
});

describe("rule 2: a write sent under validate_only", () => {
  it("ads_update_campaign sends execution_options as a form field, the guard sees validate_only, the result is labelled documented", async () => {
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed", validate_only: true });

    expect(writes()).toHaveLength(1);
    const form = formOf(writes()[0]);
    expect(form.get("execution_options")).toBe('["validate_only"]');
    expect(form.get("name")).toBe("renamed");
    expect(form.has("validate_only")).toBe(false);
    const [d] = descriptors();
    expect(descriptors()).toHaveLength(1);
    expect(d).toMatchObject({ tool: "ads_update_campaign", validate_only: true, path: `/${CAMP}` });
    expect(d.params_keys).toContain("execution_options");

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      [`POST /${CAMP} sent with validate_only`, `Meta's answer: {"success":true}`, LABEL.documented].join("\n"),
    );
  });

  it("ads_update_ad_set sends execution_options too, and is labelled unconfirmed", async () => {
    const r = await call("ads_update_ad_set", { ad_set_id: ADSET, name: "renamed", validate_only: true });

    expect(writes()).toHaveLength(1);
    expect(formOf(writes()[0]).get("execution_options")).toBe('["validate_only"]');
    expect(descriptors()).toHaveLength(1);
    expect(descriptors()[0]).toMatchObject({ tool: "ads_update_ad_set", validate_only: true });
    expect(descriptors()[0].params_keys).toContain("execution_options");

    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      [`POST /${ADSET} sent with validate_only`, `Meta's answer: {"success":true}`, LABEL.unconfirmed].join("\n"),
    );
  });

  it("a single-write tool gets rule 2, not the no-write line, and no not-sent line", async () => {
    const r = await call("ads_delete_ad_set", { ad_set_id: ADSET, validate_only: true });
    expect(writes()).toHaveLength(1);
    expect(textOf(r)).toContain(`POST /${ADSET} sent with validate_only`);
    expect(textOf(r)).toContain(LABEL.unconfirmed);
    expect(textOf(r)).not.toContain(NO_WRITE);
    expect(textOf(r)).not.toContain(NOT_SENT);
    // The handler's claim is not passed on: the write may have done nothing.
    expect(textOf(r)).not.toContain("has been deleted");
  });

  it("Meta answering the validated write with an error is isError, with the label line", async () => {
    fake.onWrite = () => graphError("Invalid parameter");
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed", validate_only: true });
    expect(writes()).toHaveLength(1);
    expect(r.isError).toBe(true);
    const lines = textOf(r).split("\n");
    expect(lines[0]).toBe(`POST /${CAMP} sent with validate_only`);
    expect(lines[1]).toMatch(/^Meta's error: .*Invalid parameter/);
    expect(lines[2]).toBe(LABEL.documented);
  });

  it("POST /{business}/ad_studies is labelled contradicted", async () => {
    fake.onWrite = () => mockFetchResponse({ id: "9992000000000001" });
    const r = await call("ads_create_ad_study", {
      account_id: "act_9990000000000001",
      business_id: BUSINESS,
      name: "s",
      start_time: "2030-01-01",
      end_time: "2030-01-10",
      cells: [
        { name: "a", treatment_percentage: 50, campaigns: [CAMP] },
        { name: "b", treatment_percentage: 50, ad_sets: [ADSET] },
      ],
      validate_only: true,
    });
    expect(writes()).toHaveLength(1);
    expect(writes()[0].path).toBe(`/${BUSINESS}/ad_studies`);
    expect(formOf(writes()[0]).get("execution_options")).toBe('["validate_only"]');
    expect(descriptors()[0]).toMatchObject({ tool: "ads_create_ad_study", validate_only: true });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toBe(
      [`POST /${BUSINESS}/ad_studies sent with validate_only`, `Meta's answer: {"id":"9992000000000001"}`, LABEL.contradicted].join("\n"),
    );
  });
});

describe("rule 3 and rule 4", () => {
  it("validate_only on a call whose handler throws before any write: the handler's error and the no-write line", async () => {
    const r = await call("ads_update_campaign", { campaign_id: CAMP, spend_cap: 100, remove_spend_cap: true, validate_only: true });
    expect(writes()).toHaveLength(0);
    expect(descriptors()).toHaveLength(0);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe(`Pass spend_cap or remove_spend_cap, not both.\n${NO_WRITE}`);
  });

  it("without validate_only: no execution_options, the guard sees validate_only false, the handler's result unchanged", async () => {
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed" });
    expect(writes()).toHaveLength(1);
    expect(formOf(writes()[0]).has("execution_options")).toBe(false);
    expect(descriptors()[0]).toMatchObject({ validate_only: false });
    expect(descriptors()[0].params_keys).not.toContain("execution_options");
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([{ type: "text", text: `Campaign ${CAMP} updated successfully.\nChanges: {"name":"renamed"}` }]);
  });

  it("validate_only false is the same as leaving it out", async () => {
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed", validate_only: false });
    expect(formOf(writes()[0]).has("execution_options")).toBe(false);
    expect(descriptors()[0]).toMatchObject({ validate_only: false });
    expect(textOf(r)).toBe(`Campaign ${CAMP} updated successfully.\nChanges: {"name":"renamed"}`);
  });

  it("an outcome the guard does not ack appears as a line after the handler's result", async () => {
    useGuard(guard.env, "NACK");
    const r = await call("ads_update_campaign", { campaign_id: CAMP, name: "renamed" });
    expect(writes()).toHaveLength(1);
    const id = descriptors()[0].request_id;
    expect(r.isError).toBeFalsy();
    expect(r.content).toEqual([
      { type: "text", text: `Campaign ${CAMP} updated successfully.\nChanges: {"name":"renamed"}` },
      { type: "text", text: `guard outcome record for ${id} was not acknowledged` },
    ]);
  });
});
