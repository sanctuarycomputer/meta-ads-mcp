import { hashToken } from "../auth/token-store.js";

/**
 * One Gemini API key per tenant, held in this process's memory (254 M6: no
 * Firestore, so no encryption at rest: the map is the same memory a key
 * would sit in). Gemini itself is removed in this fork (M7); the repo stays
 * because the key tools still read and write it.
 */

export interface GeminiKeyDoc {
  key: string;
  /** Truncated SHA-256, for log correlation only. */
  keyHash: string;
  createdAt: number;
  updatedAt: number;
}

export interface GeminiKeyStatus {
  registered: boolean;
  keyFingerprint: string | null;
  updatedAt: number | null;
}

export interface GeminiKeyRepo {
  saveKey(fbUserId: string, key: string): Promise<void>;
  /** Returns null (rather than throwing) when absent. */
  getDecryptedKey(fbUserId: string): Promise<string | null>;
  getStatus(fbUserId: string): Promise<GeminiKeyStatus>;
  deleteKey(fbUserId: string): Promise<boolean>;
}

const EMPTY_STATUS: GeminiKeyStatus = { registered: false, keyFingerprint: null, updatedAt: null };

export class InMemoryGeminiKeyRepo implements GeminiKeyRepo {
  private readonly docs = new Map<string, GeminiKeyDoc>();

  async saveKey(fbUserId: string, key: string): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.docs.set(fbUserId, {
      key,
      keyHash: hashToken(key),
      createdAt: this.docs.get(fbUserId)?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async getDecryptedKey(fbUserId: string): Promise<string | null> {
    return this.docs.get(fbUserId)?.key ?? null;
  }

  async getStatus(fbUserId: string): Promise<GeminiKeyStatus> {
    const doc = this.docs.get(fbUserId);
    return doc ? { registered: true, keyFingerprint: doc.keyHash, updatedAt: doc.updatedAt } : { ...EMPTY_STATUS };
  }

  async deleteKey(fbUserId: string): Promise<boolean> {
    return this.docs.delete(fbUserId);
  }
}

let cachedRepo: GeminiKeyRepo | undefined;

export function getGeminiKeyRepo(): GeminiKeyRepo {
  cachedRepo ??= new InMemoryGeminiKeyRepo();
  return cachedRepo;
}

export function configureGeminiKeyRepoForTests(repo: GeminiKeyRepo | undefined): void {
  cachedRepo = repo;
}
