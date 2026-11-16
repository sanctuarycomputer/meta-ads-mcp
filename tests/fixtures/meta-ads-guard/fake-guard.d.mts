// Types for the vendored fake-guard.mjs, for the exports tests use.
export const OWNER_KEY: Record<string, string | null>;
export interface FakeAnswer {
  stdout: string;
  stderr: string;
  exit: number;
  delayMs: number;
}
export interface Fixture {
  name: string;
  descriptor?: Record<string, unknown>;
  reply?: Record<string, unknown>;
  fake?: { stdout: string; exit: number; delay_ms?: number };
  [key: string]: unknown;
}
export function validateDescriptor(d: unknown): string[];
export function validateOutcome(o: unknown): string[];
export function normalise(d: unknown): string;
export function loadFixtures(dir: string): Fixture[];
export function answer(input: string, fixtures: Fixture[]): FakeAnswer;
export function matchEndpoint(endpoints: unknown, method: string, path: string, objectType: string): unknown;
export function deriveKind(row: unknown, d: unknown): string;
export function deriveCreativeBearing(row: unknown, d: unknown): boolean;
export function deriveAccountLimit(endpoints: unknown, row: unknown, d: unknown): unknown;
