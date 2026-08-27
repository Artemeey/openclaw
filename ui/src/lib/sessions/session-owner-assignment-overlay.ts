import type { SessionOwner } from "../../../../packages/gateway-protocol/src/index.js";
import type { SessionsListResult } from "../../api/types.ts";

type ConfirmedOwnerClaim = {
  confirmedScopes: Set<string>;
  owner: SessionOwner;
  scopeRevisions: Map<string, number>;
  sessionId?: string;
};

function ownersMatch(left: SessionOwner | undefined, right: SessionOwner): boolean {
  return (
    left?.actor.type === right.actor.type &&
    left.actor.id === right.actor.id &&
    left.assignedBy?.type === right.assignedBy?.type &&
    left.assignedBy?.id === right.assignedBy?.id &&
    left.assignedAt === right.assignedAt
  );
}

function ownerSupersedes(current: SessionOwner | undefined, confirmed: SessionOwner): boolean {
  return (
    current?.assignedAt !== undefined &&
    confirmed.assignedAt !== undefined &&
    current.assignedAt > confirmed.assignedAt
  );
}

export function createSessionOwnerAssignmentOverlay() {
  const claims = new Map<string, ConfirmedOwnerClaim>();

  return {
    confirm(
      key: string,
      owner: SessionOwner,
      scopeRevisions: ReadonlyMap<string, number>,
      sessionId?: string,
    ): ConfirmedOwnerClaim {
      const claim = {
        confirmedScopes: new Set<string>(),
        owner,
        scopeRevisions: new Map(scopeRevisions),
        ...(sessionId ? { sessionId } : {}),
      };
      claims.set(key.trim(), claim);
      return claim;
    },
    retire(key: string): void {
      claims.delete(key);
    },
    settleConfirmed(key: string, claim: ConfirmedOwnerClaim): void {
      if (claims.get(key) !== claim) {
        return;
      }
      for (const scope of claim.confirmedScopes) {
        claim.scopeRevisions.delete(scope);
      }
      claim.confirmedScopes.clear();
      if (claim.scopeRevisions.size === 0) {
        claims.delete(key);
      }
    },
    clear(): void {
      claims.clear();
    },
    decorate: (result: SessionsListResult | null): SessionsListResult | null => {
      if (!result || claims.size === 0) {
        return result;
      }
      let changed = false;
      const sessions = result.sessions.map((row) => {
        const claim = claims.get(row.key);
        if (!claim) {
          return row;
        }
        if (claim.sessionId && row.sessionId && claim.sessionId !== row.sessionId) {
          claims.delete(row.key);
          return row;
        }
        if (ownersMatch(row.owner, claim.owner)) {
          return row;
        }
        changed = true;
        return { ...row, owner: claim.owner };
      });
      return changed ? { ...result, sessions, owners: undefined } : result;
    },
    observeCanonical: (
      result: SessionsListResult | null,
      requestRevision: number,
      scope: string | undefined,
    ): void => {
      if (!scope) {
        return;
      }
      for (const [key, claim] of claims) {
        const scopeRevision = claim.scopeRevisions.get(scope);
        if (scopeRevision === undefined) {
          continue;
        }
        const row = result?.sessions.find((candidate) => candidate.key === key);
        if (claim.sessionId && row?.sessionId && claim.sessionId !== row.sessionId) {
          claims.delete(key);
          continue;
        }
        if (row?.owner && ownerSupersedes(row.owner, claim.owner)) {
          claim.owner = row.owner;
          if (row.sessionId) {
            claim.sessionId = row.sessionId;
          }
          claim.confirmedScopes.add(scope);
          continue;
        }
        if (ownersMatch(row?.owner, claim.owner) || (requestRevision > scopeRevision && !row)) {
          claim.confirmedScopes.add(scope);
        }
      }
    },
    retireScope: (scope: string): void => {
      for (const [key, claim] of claims) {
        claim.confirmedScopes.delete(scope);
        if (claim.scopeRevisions.delete(scope) && claim.scopeRevisions.size === 0) {
          claims.delete(key);
        }
      }
    },
  };
}
