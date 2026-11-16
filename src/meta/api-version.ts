// Graph v27.0 only: older versions answer with error #2635, and moving to a
// newer one is a deliberate change of this constant, with its tests and the
// pins in the deploy files (tests/meta/api-version.test.ts).
export const DEFAULT_META_API_VERSION = "v27.0";

const VERSION_PATTERN = /^v(\d+)\.(\d+)$/;

function parseVersion(version: string): [number, number] {
  const match = VERSION_PATTERN.exec(version);
  if (!match) {
    throw new Error(`Invalid Meta API version "${version}": expected the form v27.0.`);
  }
  return [Number(match[1]), Number(match[2])];
}

/** The version every request is built with: v27.0, and nothing else. */
export function assertMetaApiVersion(version: string): string {
  parseVersion(version);
  if (version !== DEFAULT_META_API_VERSION) {
    throw new Error(`Meta API version "${version}" is not supported: this server runs only on ${DEFAULT_META_API_VERSION}.`);
  }
  return version;
}

export function resolveMetaApiVersion(): string {
  const configured = process.env.META_API_VERSION?.trim();
  if (!configured) return DEFAULT_META_API_VERSION;
  if (!VERSION_PATTERN.test(configured)) {
    throw new Error(`META_API_VERSION must be ${DEFAULT_META_API_VERSION}, got "${configured}".`);
  }
  return assertMetaApiVersion(configured);
}

// Compares any two versions, old ones included: targeting rules name the
// version a field was removed in (meta/targeting-compat.ts).
export function isMetaApiVersionAtLeast(version: string, minimum: string): boolean {
  const [major, minor] = parseVersion(version);
  const [minimumMajor, minimumMinor] = parseVersion(minimum);
  return major === minimumMajor ? minor >= minimumMinor : major > minimumMajor;
}
