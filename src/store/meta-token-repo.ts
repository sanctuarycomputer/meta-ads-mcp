import type { MetaProfile } from "../auth/meta-oauth.js";

/**
 * Named Meta tokens per user, held in this process's memory (254 M6: no
 * Firestore, so no encryption at rest, and no refresh path into the OAuth
 * config).
 */

export type TokenKind = "user" | "system_user";

export interface UserDoc {
  email: string | null;
  name: string | null;
  picture: string | null;
  firstLoginAt: number;
  lastLoginAt: number;
}

export interface MetaTokenDoc {
  token: string;
  kind: TokenKind;
  expiresAt: number | null;
  scopes: string[];
  metaUserId: string | null;
  metaUserName: string | null;
  businessId: string | null;
  businessName: string | null;
  isDefault: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface MetaTokenSummary {
  name: string;
  kind: TokenKind;
  expiresAt: number | null;
  metaUserId: string | null;
  metaUserName: string | null;
  businessId: string | null;
  businessName: string | null;
  isDefault: boolean;
  isExpired: boolean;
}

export interface SaveTokenInput {
  fbUserId: string;
  name: string;
  accessToken: string;
  kind: TokenKind;
  expiresAt: number | null;
  scopes?: string[];
  metaUserId: string | null;
  metaUserName: string | null;
  businessId?: string | null;
  businessName?: string | null;
  setAsDefault?: boolean;
}

export interface MetaTokenRepo {
  upsertUser(fbUserId: string, profile: MetaProfile): Promise<void>;
  getUser(fbUserId: string): Promise<UserDoc | null>;
  saveToken(input: SaveTokenInput): Promise<void>;
  setDefaultToken(fbUserId: string, name: string): Promise<boolean>;
  deleteToken(fbUserId: string, name: string): Promise<boolean>;
  listTokens(fbUserId: string): Promise<MetaTokenSummary[]>;
  getDefaultTokenName(fbUserId: string): Promise<string | null>;
  getDecryptedToken(fbUserId: string, name?: string): Promise<string>;
}

function summarize(name: string, doc: MetaTokenDoc, now: number): MetaTokenSummary {
  return {
    name,
    kind: doc.kind,
    expiresAt: doc.expiresAt,
    metaUserId: doc.metaUserId,
    metaUserName: doc.metaUserName,
    businessId: doc.businessId ?? null,
    businessName: doc.businessName ?? null,
    isDefault: doc.isDefault,
    isExpired: doc.expiresAt !== null && doc.expiresAt < now,
  };
}

export class InMemoryMetaTokenRepo implements MetaTokenRepo {
  private users = new Map<string, UserDoc>();
  private tokens = new Map<string, Map<string, MetaTokenDoc>>();

  private getUserTokens(fbUserId: string): Map<string, MetaTokenDoc> {
    let bucket = this.tokens.get(fbUserId);
    if (!bucket) {
      bucket = new Map();
      this.tokens.set(fbUserId, bucket);
    }
    return bucket;
  }

  async upsertUser(fbUserId: string, profile: MetaProfile): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const existing = this.users.get(fbUserId);
    if (existing) {
      this.users.set(fbUserId, {
        ...existing,
        email: profile.email,
        name: profile.name,
        picture: profile.pictureUrl,
        lastLoginAt: now,
      });
    } else {
      this.users.set(fbUserId, {
        email: profile.email,
        name: profile.name,
        picture: profile.pictureUrl,
        firstLoginAt: now,
        lastLoginAt: now,
      });
    }
  }

  async getUser(fbUserId: string): Promise<UserDoc | null> {
    return this.users.get(fbUserId) ?? null;
  }

  async saveToken(input: SaveTokenInput): Promise<void> {
    const now = Math.floor(Date.now() / 1000);
    const bucket = this.getUserTokens(input.fbUserId);

    let isDefault = input.setAsDefault ?? false;
    if (input.setAsDefault) {
      for (const [k, v] of bucket) {
        bucket.set(k, { ...v, isDefault: false });
      }
    } else {
      const existingDefault = await this.getDefaultTokenName(input.fbUserId);
      if (!existingDefault) {
        isDefault = true;
      }
    }

    bucket.set(input.name, {
      token: input.accessToken,
      kind: input.kind,
      expiresAt: input.expiresAt,
      scopes: input.scopes ?? [],
      metaUserId: input.metaUserId,
      metaUserName: input.metaUserName,
      businessId: input.businessId ?? null,
      businessName: input.businessName ?? null,
      isDefault,
      createdAt: now,
      updatedAt: now,
    });
  }

  async setDefaultToken(fbUserId: string, name: string): Promise<boolean> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket || !bucket.has(name)) return false;
    const now = Math.floor(Date.now() / 1000);
    for (const [k, v] of bucket) {
      bucket.set(k, { ...v, isDefault: k === name, updatedAt: k === name ? now : v.updatedAt });
    }
    return true;
  }

  async deleteToken(fbUserId: string, name: string): Promise<boolean> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket) return false;
    const existing = bucket.get(name);
    if (!existing) return false;
    bucket.delete(name);
    if (existing.isDefault) {
      const next = bucket.entries().next();
      if (!next.done) {
        const [k, v] = next.value;
        bucket.set(k, { ...v, isDefault: true });
      }
    }
    return true;
  }

  async listTokens(fbUserId: string): Promise<MetaTokenSummary[]> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket) return [];
    const now = Math.floor(Date.now() / 1000);
    return [...bucket.entries()].map(([name, doc]) => summarize(name, doc, now));
  }

  async getDefaultTokenName(fbUserId: string): Promise<string | null> {
    const bucket = this.tokens.get(fbUserId);
    if (!bucket) return null;
    for (const [name, doc] of bucket) {
      if (doc.isDefault) return name;
    }
    return null;
  }

  async getDecryptedToken(fbUserId: string, name?: string): Promise<string> {
    const tokenName = name ?? (await this.getDefaultTokenName(fbUserId));
    if (!tokenName) {
      throw new Error(`No Meta token registered for user ${fbUserId}`);
    }
    const doc = this.tokens.get(fbUserId)?.get(tokenName);
    if (!doc) {
      throw new Error(`Meta token "${tokenName}" not found for user ${fbUserId}`);
    }
    return doc.token;
  }
}

let activeRepo: MetaTokenRepo = new InMemoryMetaTokenRepo();

export function configureMetaTokenRepo(repo: MetaTokenRepo): void {
  activeRepo = repo;
}

export function getMetaTokenRepo(): MetaTokenRepo {
  return activeRepo;
}

export function resetMetaTokenRepoForTests(): void {
  activeRepo = new InMemoryMetaTokenRepo();
}

export function upsertUser(fbUserId: string, profile: MetaProfile): Promise<void> {
  return activeRepo.upsertUser(fbUserId, profile);
}

export function getUser(fbUserId: string): Promise<UserDoc | null> {
  return activeRepo.getUser(fbUserId);
}

export function saveToken(input: SaveTokenInput): Promise<void> {
  return activeRepo.saveToken(input);
}

export function setDefaultToken(fbUserId: string, name: string): Promise<boolean> {
  return activeRepo.setDefaultToken(fbUserId, name);
}

export function deleteToken(fbUserId: string, name: string): Promise<boolean> {
  return activeRepo.deleteToken(fbUserId, name);
}

export function listTokens(fbUserId: string): Promise<MetaTokenSummary[]> {
  return activeRepo.listTokens(fbUserId);
}

export function getDefaultTokenName(fbUserId: string): Promise<string | null> {
  return activeRepo.getDefaultTokenName(fbUserId);
}

export function getDecryptedToken(fbUserId: string, name?: string): Promise<string> {
  return activeRepo.getDecryptedToken(fbUserId, name);
}
