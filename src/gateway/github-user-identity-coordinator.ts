import { ControlUiGitHubError } from "./control-ui-github-api.js";

const SUCCESS_CACHE_MS = 5 * 60_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const CACHE_LIMIT = 200;

export type ResolvedGitHubUserIdentity = { accountId: number; login: string };

type LookupEntry = {
  freshUntil: number;
  inFlight?: Promise<ResolvedGitHubUserIdentity>;
  value?: ResolvedGitHubUserIdentity;
};

class GitHubUserIdentityCoordinator {
  private readonly backoffs = new Map<string, number>();
  private readonly lookups = new Map<string, LookupEntry>();

  lookup(params: {
    allowStaleOnRateLimit: boolean;
    credentialScope: string;
    lookupKey: string;
    request: () => Promise<ResolvedGitHubUserIdentity>;
  }): Promise<ResolvedGitHubUserIdentity> {
    const cacheKey = `${params.credentialScope}:${params.lookupKey}`;
    const cached = this.touchLookup(cacheKey);
    if (cached?.value && cached.freshUntil > Date.now()) {
      return Promise.resolve(cached.value);
    }

    const backoffRemaining = this.backoffRemaining(params.credentialScope);
    if (backoffRemaining > 0) {
      // Numeric account IDs are immutable. Login aliases are not, so they must
      // never use stale verification when GitHub cannot confirm current ownership.
      if (params.allowStaleOnRateLimit && cached?.value) {
        return Promise.resolve(cached.value);
      }
      return Promise.reject(this.rateLimitError(backoffRemaining));
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }

    const entry = cached ?? { freshUntil: 0 };
    const current = params.request().then(
      (identity) => {
        entry.value = identity;
        entry.freshUntil = Date.now() + SUCCESS_CACHE_MS;
        return identity;
      },
      (error: unknown) => {
        if (error instanceof ControlUiGitHubError && error.statusCode === 429) {
          const retryAfterMs = error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS;
          this.setBackoff(params.credentialScope, retryAfterMs);
          if (params.allowStaleOnRateLimit && entry.value) {
            return entry.value;
          }
        }
        if (!entry.value) {
          this.lookups.delete(cacheKey);
        }
        throw error;
      },
    );
    entry.inFlight = current;
    this.lookups.delete(cacheKey);
    this.lookups.set(cacheKey, entry);
    this.pruneLookups();
    void current.then(
      () => {
        entry.inFlight = undefined;
      },
      () => {
        entry.inFlight = undefined;
      },
    );
    return current;
  }

  reset(): void {
    this.backoffs.clear();
    this.lookups.clear();
  }

  private backoffRemaining(credentialScope: string): number {
    const blockedUntil = this.backoffs.get(credentialScope) ?? 0;
    const remaining = Math.max(0, blockedUntil - Date.now());
    if (remaining === 0) {
      this.backoffs.delete(credentialScope);
    }
    return remaining;
  }

  private pruneLookups(): void {
    while (this.lookups.size > CACHE_LIMIT) {
      const oldestIdle = [...this.lookups].find(([, entry]) => !entry.inFlight);
      if (!oldestIdle) {
        return;
      }
      this.lookups.delete(oldestIdle[0]);
    }
  }

  private rateLimitError(retryAfterMs: number): ControlUiGitHubError {
    return new ControlUiGitHubError(
      429,
      `GitHub identity lookup rate limited; retry after ${retryAfterMs}ms`,
      { retryAfterMs },
    );
  }

  private setBackoff(credentialScope: string, retryAfterMs: number): void {
    // GitHub quotas belong to the credential (or anonymous source IP), so one
    // quota response stops every identity lookup in that scope until reset.
    this.backoffs.delete(credentialScope);
    this.backoffs.set(credentialScope, Date.now() + retryAfterMs);
    while (this.backoffs.size > CACHE_LIMIT) {
      const oldestKey = this.backoffs.keys().next().value;
      if (typeof oldestKey !== "string") {
        return;
      }
      this.backoffs.delete(oldestKey);
    }
  }

  private touchLookup(cacheKey: string): LookupEntry | undefined {
    const cached = this.lookups.get(cacheKey);
    if (cached) {
      this.lookups.delete(cacheKey);
      this.lookups.set(cacheKey, cached);
    }
    return cached;
  }
}

export const githubUserIdentityCoordinator = new GitHubUserIdentityCoordinator();
