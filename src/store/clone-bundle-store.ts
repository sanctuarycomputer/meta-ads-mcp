export interface CloneBundleCreatedResources {
  adSetId?: string;
  // On the native-copy clone path, ad creatives are duplicated server-side by
  // Meta and are not separately tracked here; creativeIds only collects the
  // creatives minted locally when applying a creative_overrides swap. adIds
  // holds the copied ad ids and is the primary partial-state ledger for cleanup.
  creativeIds: string[];
  adIds: string[];
}

export interface CloneBundleRecord {
  cacheKey: string;
  signature: string;
  state: "in_progress" | "completed" | "failed";
  startedAt: number;
  completedAt?: number;
  result?: unknown;
  createdResources: CloneBundleCreatedResources;
  lastError?: string;
}

export const STALE_IN_PROGRESS_MS = 15 * 60 * 1000;

export interface ClaimOptions {
  // A run in progress past STALE_IN_PROGRESS_MS is taken over by default. A
  // tool whose creates cannot be matched back to a run turns that off: an
  // unfinished run may have created things its record never got.
  reclaimStale?: boolean;
}

function canReclaim(existing: CloneBundleRecord, options: ClaimOptions): boolean {
  return options.reclaimStale !== false
    && existing.state === "in_progress"
    && Date.now() - existing.startedAt > STALE_IN_PROGRESS_MS;
}

class InMemoryStore {
  readonly persistent = false;
  private readonly map = new Map<string, CloneBundleRecord>();

  async getDoc(key: string): Promise<CloneBundleRecord | undefined> {
    return this.map.get(key);
  }

  async claim(key: string, signature: string, options: ClaimOptions = {}): Promise<{ status: "claimed" | "duplicate"; existing?: CloneBundleRecord }> {
    const existing = this.map.get(key);
    if (existing && !canReclaim(existing, options)) return { status: "duplicate", existing };
    this.map.set(key, {
      cacheKey: key,
      signature,
      state: "in_progress",
      startedAt: Date.now(),
      createdResources: { creativeIds: [], adIds: [] },
    });
    return { status: "claimed" };
  }

  async update(key: string, partial: Partial<CloneBundleRecord>): Promise<void> {
    const existing = this.map.get(key);
    if (!existing) return;
    this.map.set(key, { ...existing, ...partial });
  }
}

export interface CloneBundleStore {
  // Whether records outlive this process and are shared by every instance.
  // Always false in this fork (254 M6: no Firestore), so ads_duplicate_ad
  // refuses a real run.
  readonly persistent: boolean;
  getDoc(key: string): Promise<CloneBundleRecord | undefined>;
  claim(key: string, signature: string, options?: ClaimOptions): Promise<{ status: "claimed" | "duplicate"; existing?: CloneBundleRecord }>;
  update(key: string, partial: Partial<CloneBundleRecord>): Promise<void>;
}

let cachedStore: CloneBundleStore | undefined;

export function getCloneBundleStore(): CloneBundleStore {
  if (cachedStore) return cachedStore;
  cachedStore = new InMemoryStore();
  return cachedStore;
}

export function resetCloneBundleStoreForTests(): void {
  cachedStore = undefined;
}

/** Tests only: installs a store (a persistent double exercises a real ads_duplicate_ad run). */
export function configureCloneBundleStoreForTests(store: CloneBundleStore): void {
  cachedStore = store;
}
