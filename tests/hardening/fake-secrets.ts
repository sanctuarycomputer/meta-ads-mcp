/**
 * Test credentials, built at runtime so no secret-shaped literal is ever
 * committed (gitleaks scans this repo's history in CI). Each is a readable
 * label plus a run of "x", long enough to count as a secret (8+ characters).
 */
export function fakeSecret(label: string, n = 24): string {
  return `fake-${label}-${"x".repeat(n)}`;
}

export const TOKEN = fakeSecret("access-token");
export const SECRET = fakeSecret("app-secret");
export const OTHER = fakeSecret("other-token");
export const PAGE = fakeSecret("page-token");
export const PROOF = fakeSecret("proof");
