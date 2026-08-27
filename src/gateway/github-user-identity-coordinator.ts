import { KeyedAsyncQueue } from "../plugin-sdk/keyed-async-queue.js";
import { ControlUiGitHubError } from "./control-ui-github-api.js";

const SUCCESS_CACHE_MS = 5 * 60_000;
const RATE_LIMIT_FALLBACK_MS = 60_000;
const CAPACITY_RETRY_MS = 1_000;
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
  private queue = new KeyedAsyncQueue();

  lookup(params: {
    credentialScope: string;
    identityKind: "account-id" | "login";
    lookupKey: string;
    request: () => Promise<ResolvedGitHubUserIdentity>;
  }): Promise<ResolvedGitHubUserIdentity> {
    const cacheKey = `${params.credentialScope}:${params.lookupKey}`;
    const cacheCompleted = params.identityKind === "account-id";
    const cached = this.touchLookup(cacheKey);
    if (cacheCompleted && cached?.value && cached.freshUntil > Date.now()) {
      return Promise.resolve(cached.value);
    }
    if (cached?.inFlight) {
      return cached.inFlight;
    }

    const backoffRemaining = this.backoffRemaining(params.credentialScope);
    if (backoffRemaining > 0) {
      // Numeric account IDs are immutable. Login aliases are not, so they must
      // never use stale verification when GitHub cannot confirm current ownership.
      if (cacheCompleted && cached?.value) {
        return Promise.resolve(cached.value);
      }
      return Promise.reject(this.rateLimitError(backoffRemaining));
    }
    if (!cached) {
      this.pruneLookups(CACHE_LIMIT - 1);
      if (this.lookups.size >= CACHE_LIMIT) {
        return Promise.reject(this.capacityError());
      }
    }

    const entry = cached ?? { freshUntil: 0 };
    const current = this.queue.enqueue(params.credentialScope, async () => {
      const queuedBackoffRemaining = this.backoffRemaining(params.credentialScope);
      if (queuedBackoffRemaining > 0) {
        if (cacheCompleted && entry.value) {
          return entry.value;
        }
        throw this.rateLimitError(queuedBackoffRemaining);
      }
      try {
        const identity = await params.request();
        if (!cacheCompleted) {
          return identity;
        }
        entry.value = identity;
        entry.freshUntil = Date.now() + SUCCESS_CACHE_MS;
        return identity;
      } catch (error) {
        if (error instanceof ControlUiGitHubError && error.statusCode === 429) {
          const retryAfterMs = error.retryAfterMs ?? RATE_LIMIT_FALLBACK_MS;
          this.setBackoff(params.credentialScope, retryAfterMs);
          if (cacheCompleted && entry.value) {
            return entry.value;
          }
        }
        throw error;
      }
    });
    entry.inFlight = current;
    this.lookups.delete(cacheKey);
    this.lookups.set(cacheKey, entry);
    void current.then(
      () => {
        entry.inFlight = undefined;
        if (!cacheCompleted) {
          this.lookups.delete(cacheKey);
        }
      },
      () => {
        entry.inFlight = undefined;
        if (!entry.value) {
          this.lookups.delete(cacheKey);
        }
      },
    );
    return current;
  }

  reset(): void {
    this.backoffs.clear();
    this.lookups.clear();
    this.queue = new KeyedAsyncQueue();
  }

  private backoffRemaining(credentialScope: string): number {
    const blockedUntil = this.backoffs.get(credentialScope) ?? 0;
    const remaining = Math.max(0, blockedUntil - Date.now());
    if (remaining === 0) {
      this.backoffs.delete(credentialScope);
    }
    return remaining;
  }

  private pruneLookups(maxSize: number): void {
    while (this.lookups.size > maxSize) {
      const oldestIdle = [...this.lookups].find(([, entry]) => !entry.inFlight);
      if (!oldestIdle) {
        return;
      }
      this.lookups.delete(oldestIdle[0]);
    }
  }

  private capacityError(): ControlUiGitHubError {
    return new ControlUiGitHubError(
      429,
      `GitHub identity lookup capacity reached; retry after ${CAPACITY_RETRY_MS}ms`,
      { retryAfterMs: CAPACITY_RETRY_MS },
    );
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
