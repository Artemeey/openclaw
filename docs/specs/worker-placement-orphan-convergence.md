---
title: Worker placement orphan convergence
summary: "Lifecycle rules for terminal cloud workers with pending workspace results."
read_when:
  - Changing cloud worker restart recovery or workspace-result reconciliation
  - Changing session archive behavior for cloud worker placements
  - Diagnosing a placement that remains draining after its worker is gone
---

# Worker placement orphan convergence

## Goal

Cloud worker recovery converges every pending workspace result to one of three
outcomes:

1. The exact attached worker in the current Gateway lifecycle keeps ownership
   and completes the result.
2. OpenClaw preserves durable workspace changes until it applies them or an
   operator explicitly abandons them.
3. OpenClaw proves that the worker is gone and that no durable result exists,
   releases the pending-result fence, and marks the placement failed.

A session archive consumes a settled placement. It may safely reclaim an active
placement, but it never force-abandons an unreconciled workspace result.

## Ownership

The placement recovery sweep owns orphan detection and terminal convergence.
It evaluates the placement, worker environment, turn claim, pending workspace
result, staged result reference, and prepared result reference together.

The archive lifecycle owns session cancellation and the archive commit after
placement recovery settles. It reports the blocking placement state when
recovery has not settled.

## Recovery decisions

A pending result from the active Gateway lifecycle may remain deferred only
while all of these facts still hold:

- the placement is `active` or `draining`;
- its turn claim matches the pending result;
- the environment is `attached` to that session;
- the environment owner epoch matches the placement;
- the admitted worker bundle matches the placement bundle; and
- the environment still accepts the worker execution-context protocol.

If any fact fails, the recovery sweep inspects durable workspace-result
evidence. The evidence is conservative:

- a recorded unaccepted `stagedResultRef` remains evidence even when its Git ref
  cannot be found;
- a canonical staged Git ref without a database pointer is adopted and fenced;
  and
- a prepared Git ref is fenced until verification can resume or an operator
  abandons it.

### No durable result

When the environment is missing or terminal, recovery may fail the placement
only when the pending row has no recorded unaccepted staged-result pointer and
the workspace contains neither a canonical staged ref nor a prepared ref.
Recovery then uses one database transaction to:

1. records the worker-loss cause;
2. removes the pending workspace-result row;
3. releases the turn claim;
4. move `active` or `draining` placement ownership through reconciliation to
   `failed`.

Environment teardown is a separate idempotent retry after that transaction.

The failed placement becomes safe for normal retirement once its environment
is proven gone. A later turn may redispatch, and archive may retire the session.

### Staged or prepared result

An unaccepted staged-result pointer, staged Git ref, or prepared Git ref is
evidence that workspace changes may survive the worker. Recovery retains the
result fence and every Git ref that still exists. It does not infer acceptance
from worker loss or a missing ref.

The session remains unavailable for archive until recovery applies the result
or an administrator explicitly abandons it with `environments.destroy` and
`force: true`. The initiating UI or client must warn that unreconciled workspace
changes can be lost before invoking that destructive RPC.

### Live exact owner

An exact attached worker may reconnect within the current Gateway lifecycle and
finish its claim. The same-lifecycle defer prevents recovery from racing that
worker. Worker loss, owner fencing, or build incompatibility ends the defer and
sends the pending result through the durable-result decisions above. Active
turn claims do not survive a Gateway restart; a cross-restart pending result is
owned by startup reconciliation.

## Archive errors

Archive distinguishes a blocked placement from a stop operation that is still
running. A blocked `requested`, `provisioning`, `syncing`, `starting`,
`draining`, or `reconciling` placement returns `INVALID_REQUEST` and names the
placement state. The same error applies to a `failed` placement whose
environment is still live or cannot be proven gone. A genuinely active archive
drain may still return retryable `UNAVAILABLE` while cancellation or reclaim is
pending.

This distinction prevents clients from promising that repeated archive
requests will settle a terminal orphan.

## Verification

Regression coverage recreates the persisted ordering that exposed the defect:

1. attach a worker and claim a turn;
2. start draining the placement;
3. persist a pending workspace result without a recovery-request timestamp;
4. mark the environment terminal before recovery handoff; and
5. run startup reconciliation under the same Gateway instance identifier.

The sweep must clear the pending result and leave a failed, claimless placement.
Separate coverage keeps an unaccepted staged result fenced and verifies that
archive reports a non-retryable placement-state error.
