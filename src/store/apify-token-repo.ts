/**
 * One Apify API token per tenant, held in this process's memory (254 M6: no
 * Firestore, so no encryption at rest: the map is the same memory a key
 * would sit in). Apify itself is removed in this fork (M7); the repo stays
 * because the token tools still read and write it.
 */

export interface ApifyTokenDoc {
  token: string;
  apifyUserId: string | null;
  apifyUsername: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ApifyTokenStatus {
  registered: boolean;
  apifyUserId: string | null;
  apifyUsername: string | null;
  updatedAt: number | null;
}

export interface ApifyTokenRepo {
  saveToken(
    fbUserId: string,
    token: string,
    user: { id: string; username: string } | null,
  ): Promise<void>;
  /** Returns null (rather than throwing) when absent. */
  getDecryptedToken(fbUserId: string): Promise<string | null>;
  getStatus(fbUserId: string): Promise<ApifyTokenStatus>;
  deleteToken(fbUserId: string): Promise<boolean>;
}

const EMPTY_STATUS: ApifyTokenStatus = {
  registered: false,
  apifyUserId: null,
  apifyUsername: null,
  updatedAt: null,
};

export class InMemoryApifyTokenRepo implements ApifyTokenRepo {
  private readonly docs = new Map<string, ApifyTokenDoc>();

  async saveToken(
    fbUserId: string,
    token: string,
    user: { id: string; username: string } | null,
  ): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    this.docs.set(fbUserId, {
      token,
      apifyUserId: user?.id ?? null,
      apifyUsername: user?.username ?? null,
      createdAt: this.docs.get(fbUserId)?.createdAt ?? now,
      updatedAt: now,
    });
  }

  async getDecryptedToken(fbUserId: string): Promise<string | null> {
    return this.docs.get(fbUserId)?.token ?? null;
  }

  async getStatus(fbUserId: string): Promise<ApifyTokenStatus> {
    const doc = this.docs.get(fbUserId);
    if (!doc) return { ...EMPTY_STATUS };
    return {
      registered: true,
      apifyUserId: doc.apifyUserId,
      apifyUsername: doc.apifyUsername,
      updatedAt: doc.updatedAt,
    };
  }

  async deleteToken(fbUserId: string): Promise<boolean> {
    return this.docs.delete(fbUserId);
  }
}

let cachedRepo: ApifyTokenRepo | undefined;

export function getApifyTokenRepo(): ApifyTokenRepo {
  cachedRepo ??= new InMemoryApifyTokenRepo();
  return cachedRepo;
}

export function configureApifyTokenRepoForTests(repo: ApifyTokenRepo | undefined): void {
  cachedRepo = repo;
}
