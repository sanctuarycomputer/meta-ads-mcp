import { requestContext } from "../auth/token-store.js";
import { validateMetaId } from "../utils/format.js";
import { scrubCredentialsDeep, scrubErrorCredentials, withHeldSecret } from "../utils/scrub-credentials.js";
import { metaApiClient } from "./client.js";

/**
 * Runs `work` with a Page access token instead of the person's. The token is
 * fetched for this one operation with the person's own token and lives only
 * in memory for its duration: it is never logged, returned or stored. Editing
 * a Page post needs it (with pages_manage_posts), and so do the Page's lead
 * forms (with pages_manage_ads).
 */
export async function withPageToken<T>(pageId: string, work: () => Promise<T>, timeoutMs?: number): Promise<T> {
  // Trimmed by readPageToken, as getAccessToken trims: the value sent, signed and scrubbed is one string.
  const token = await metaApiClient.readPageToken(
    validateMetaId(pageId, "page"),
    timeoutMs === undefined ? undefined : { timeoutMs },
  );
  if (!token) {
    throw new Error(`Meta returned no Page access token for page ${pageId}: the person has to manage the Page, with pages_manage_posts to edit its posts or pages_manage_ads for its lead forms.`);
  }
  // Held for the work's duration, so every scrub inside it, and the two
  // below, remove the token in each of its forms.
  return withHeldSecret(token, async () => {
    let result: T;
    try {
      result = await requestContext.run({ ...requestContext.getStore(), accessToken: token }, work);
    } catch (err) {
      throw scrubErrorCredentials(err, token);
    }
    // Whatever Meta answered with the Page token (a field it echoed, an
    // expansion that reached the Page) goes back without it.
    return scrubCredentialsDeep(result, token);
  });
}

export async function grantedPermissions(): Promise<Set<string>> {
  const res = await metaApiClient.get<{ data?: Array<{ permission?: string; status?: string }> }>("/me/permissions");
  return new Set(
    (res.data ?? [])
      .filter((p) => p.status === "granted" && typeof p.permission === "string")
      .map((p) => p.permission as string),
  );
}
