import { describe, expect, it } from "vitest";
import type { SessionsListResult } from "../../api/types.ts";
import { createSessionOwnerAssignmentOverlay } from "./session-owner-assignment-overlay.ts";

function result(ownerId: string, assignedAt: number): SessionsListResult {
  return {
    ts: assignedAt,
    path: "(multiple)",
    count: 1,
    defaults: { modelProvider: null, model: null, contextTokens: null },
    sessions: [
      {
        key: "agent:main:owned",
        kind: "direct",
        updatedAt: assignedAt,
        owner: {
          actor: { type: "human", id: ownerId },
          assignedBy: { type: "human", id: ownerId },
          assignedAt,
        },
      },
    ],
  };
}

describe("session owner assignment overlay", () => {
  it("keeps the confirmed owner until older same-scope requests settle", () => {
    const overlay = createSessionOwnerAssignmentOverlay();
    const confirmed = result("profile-ada", 20).sessions[0]!.owner!;
    const claim = overlay.confirm("agent:main:owned", confirmed, new Map([["primary", 1]]));

    overlay.observeCanonical(result("profile-ada", 20), 2, "primary");

    expect(overlay.decorate(result("profile-bob", 10))?.sessions[0]?.owner).toEqual(confirmed);

    overlay.settleConfirmed("agent:main:owned", claim);
    expect(overlay.decorate(result("profile-bob", 10))?.sessions[0]?.owner?.actor.id).toBe(
      "profile-bob",
    );
  });
});
