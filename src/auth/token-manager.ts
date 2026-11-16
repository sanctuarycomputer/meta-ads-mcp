export class TokenManager {
  private tokens = new Map<string, string>();
  private activeTokenName: string | null = null;
  private envLoaded = false;

  /**
   * Lazy initialization (CODE-B6): we used to read META_TOKENS in the
   * constructor, which fired at module-import time. That made the
   * tokens visible on the import-side stack of any uncaught error and
   * hard to reset deterministically in tests. Now load on first access.
   */
  private ensureEnvLoaded(): void {
    if (this.envLoaded) return;
    this.envLoaded = true;
    this.loadFromEnv();
  }

  /**
   * 254 M4: one token, META_ACCESS_TOKEN, under the name "default". The
   * multi-token registry (META_TOKENS, registered tokens) is gone, so a
   * credential can come from one place only.
   */
  private loadFromEnv(): void {
    const singleToken = process.env.META_ACCESS_TOKEN;
    if (singleToken) {
      this.tokens.set("default", singleToken);
      this.activeTokenName = "default";
    }
  }

  getActiveToken(): string | null {
    this.ensureEnvLoaded();
    if (!this.activeTokenName) return null;
    return this.tokens.get(this.activeTokenName) ?? null;
  }

  getActiveTokenName(): string | null {
    this.ensureEnvLoaded();
    return this.activeTokenName;
  }

  /** 254 M4: there is one token, so there is nothing to switch to. */
  setActiveToken(_name: string): boolean {
    return false;
  }

  listTokens(): { active: string | null; available: string[] } {
    this.ensureEnvLoaded();
    return {
      active: this.activeTokenName,
      available: Array.from(this.tokens.keys()),
    };
  }

  /** 254 M4: tokens come only from META_ACCESS_TOKEN. */
  registerToken(_name: string, _token: string): void {
    throw new Error("removed in this fork: tokens come only from META_ACCESS_TOKEN");
  }

  hasTokens(): boolean {
    this.ensureEnvLoaded();
    return this.tokens.size > 0;
  }

  /** Test-only: reset and re-read env on next access. */
  resetForTests(): void {
    this.tokens.clear();
    this.activeTokenName = null;
    this.envLoaded = false;
  }
}

/** 254 M4: a fixed mask; no character of the token is shown. */
export function maskToken(_token: string): string {
  return "[masked]";
}

export const tokenManager = new TokenManager();
