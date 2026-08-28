import { describe, expect, it } from "vitest";
import { LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED } from "./legacy-config-migrations.runtime.retired.js";

function applyRetired(raw: Record<string, unknown>) {
  const changes: string[] = [];
  for (const migration of LEGACY_CONFIG_MIGRATIONS_RUNTIME_RETIRED) {
    migration.apply(raw, changes);
  }
  return { raw, changes };
}

function whatsappAckConfig(params: {
  root: Record<string, unknown>;
  account?: Record<string, unknown>;
  scope?: string;
}): Record<string, unknown> {
  return {
    ...(params.scope ? { messages: { ackReactionScope: params.scope } } : {}),
    channels: {
      whatsapp: {
        ackReaction: params.root,
        ...(params.account ? { accounts: { work: { ackReaction: params.account } } } : {}),
      },
    },
  };
}

describe("retired WhatsApp ack reaction migration", () => {
  it.each([
    ["explicit", { emoji: "eyes", direct: true, group: "mentions" }],
    ["implicit", { emoji: "eyes" }],
  ])("reports the %s unrepresentable legacy defaults", (_name, ackReaction) => {
    const result = applyRetired(whatsappAckConfig({ root: ackReaction }));

    expect(result.raw).not.toHaveProperty("channels.whatsapp.ackReaction");
    expect(result.raw).not.toHaveProperty("messages.ackReactionScope");
    const warning = result.changes.find((change) => change.includes("cannot represent"));
    expect(warning).toContain("channels.whatsapp.ackReaction");
    expect(warning).toContain('final scope is "group-mentions"');
    expect(warning).toContain('use "direct"');
    expect(warning).toContain('or "all"');
  });

  it("reports a representable account scope discarded by the root scope", () => {
    const result = applyRetired(
      whatsappAckConfig({
        root: { direct: false, group: "always" },
        account: { direct: true, group: "never" },
      }),
    );

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-all");
    expect(result.changes.join("\n")).toContain(
      'channels.whatsapp.accounts.work.ackReaction requested "direct", but final messages.ackReactionScope is "group-all"',
    );
  });

  it("reports a representable legacy scope discarded by a canonical scope", () => {
    const result = applyRetired(
      whatsappAckConfig({
        root: { direct: true, group: "never" },
        scope: "group-mentions",
      }),
    );

    expect(result.raw).toHaveProperty("messages.ackReactionScope", "group-mentions");
    expect(result.changes.join("\n")).toContain(
      'channels.whatsapp.ackReaction requested "direct", but final messages.ackReactionScope is "group-mentions"',
    );
  });

  it.each([
    ["matching scopes", "direct", { direct: true, group: "never" }],
    ["equivalent disabled scopes", "none", { direct: false, group: "never" }],
  ])("keeps %s quiet", (_name, scope, ackReaction) => {
    const result = applyRetired(whatsappAckConfig({ root: ackReaction, scope }));

    expect(result.raw).toHaveProperty("messages.ackReactionScope", scope);
    expect(result.changes).toEqual([
      "Moved translatable channels.whatsapp.ackReaction settings to messages ack settings.",
    ]);
  });
});
