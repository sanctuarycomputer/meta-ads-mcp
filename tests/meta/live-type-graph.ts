// Test worlds name an object's kind by `metadata.type`, which live Graph no longer answers. This wraps a fake's GET so
// the guard's single-field type reads get the field that kind really answers. One burst of reads costs the one
// metadata GET the worlds were written around, so tests that count or fail the Nth GET keep their meaning.
import { classifyMetaError } from "../../src/meta/errors.js";
import { TYPE_PROBES, objectTypeOf, type GraphGet } from "../../src/meta/write-descriptor.js";

const TYPE_FIELDS: readonly string[] = TYPE_PROBES.map(([field]) => field);
const FIELD_OF_KIND: Readonly<Record<string, readonly [string, unknown]>> = {
  campaign: ["objective", "OUTCOME_LEADS"],
  adset: ["optimization_goal", "LINK_CLICKS"],
  ad: ["adset_id", "9995000000000001"],
  creative: ["object_story_spec", { page_id: "9991000000000001" }],
};

export function withLiveTypes(get: GraphGet): GraphGet {
  const bursts = new Map<string, { answer: Promise<unknown>; left: number }>();
  const unusedMetadata = new Map<string, Promise<unknown>>();
  return async <T>(path: string, params: Record<string, string | number>): Promise<T> => {
    if (params.metadata === undefined && TYPE_FIELDS.includes(String(params.fields))) {
      let burst = bursts.get(path);
      if (!burst) {
        unusedMetadata.delete(path);
        burst = { answer: get(path, { metadata: 1, fields: "id" }), left: TYPE_FIELDS.length };
        bursts.set(path, burst);
      }
      burst.left -= 1;
      if (burst.left === 0) {
        bursts.delete(path);
        unusedMetadata.set(path, burst.answer);
      }
      const answer = (await burst.answer) as { id?: unknown; metadata?: { type?: unknown } } | null;
      const kind = objectTypeOf(answer?.metadata?.type);
      const hit = FIELD_OF_KIND[kind];
      if (hit && hit[0] === params.fields) return { id: answer?.id, [hit[0]]: hit[1] } as T;
      // As live Graph: a creative answers 200 without a field it lacks, any other node answers code 100.
      if (kind === "creative") return { id: answer?.id } as T;
      throw classifyMetaError({ message: "Tried accessing nonexisting field", type: "OAuthException", code: 100 }).mcpError;
    }
    const metadata = params.metadata === 1 ? unusedMetadata.get(path) : undefined;
    if (metadata) {
      unusedMetadata.delete(path);
      return metadata as Promise<T>;
    }
    return get<T>(path, params);
  };
}
