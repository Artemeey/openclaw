// Control UI tests cover provider quota summary behavior.
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ModelAuthStatusProvider, ModelAuthStatusResult } from "../api/types.ts";
import { collectProviderQuotaGroups, formatQuotaReset } from "./provider-quota-summary.ts";

describe("formatQuotaReset", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("returns compact relative reset windows", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() + 30 * 60_000)).toBe("30m");
    expect(formatQuotaReset(Date.now() + 2 * 60 * 60_000 + 15 * 60_000)).toBe("2h 15m");
  });

  it("returns <1m for sub-minute reset windows instead of 0m", () => {
    vi.spyOn(Date, "now").mockReturnValue(Date.parse("2026-05-30T12:00:00.000Z"));

    expect(formatQuotaReset(Date.now() - 1)).toBe("now");
    expect(formatQuotaReset(Date.now())).toBe("now");
    expect(formatQuotaReset(Date.now() + 1)).toBe("<1m");
    expect(formatQuotaReset(Date.now() + 59_999)).toBe("<1m");
    expect(formatQuotaReset(Date.now() + 60_000)).toBe("1m");
  });

  it("ignores Date-invalid reset timestamps", () => {
    expect(formatQuotaReset(8_640_000_000_000_001)).toBeNull();
    expect(formatQuotaReset(Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("collectProviderQuotaGroups", () => {
  const acceptAll = () => true;
  type ModelAuthUsage = NonNullable<ModelAuthStatusProvider["profiles"][number]["usage"]>;

  function providerWithProfileUsage(
    provider: string,
    usage?: ModelAuthUsage,
    profileId = `${provider}:default`,
  ): ModelAuthStatusProvider {
    return {
      provider,
      authProvider: provider === "claude-cli" ? "anthropic" : provider,
      displayName: "Claude",
      status: "ok",
      profiles: [
        {
          profileId,
          type: "oauth",
          status: "ok",
          ...(usage ? { usage } : {}),
        },
      ],
    };
  }

  function providerUsage(
    usage: ModelAuthUsage,
    displayName = "Claude",
  ): NonNullable<ModelAuthStatusResult["providerUsage"]>[number] {
    return { ...usage, displayName };
  }

  it("collapses providers sharing identical usage into one group", () => {
    const usage: ModelAuthUsage = {
      providerId: "anthropic",
      plan: "Max (20x)",
      windows: [
        { label: "5h", usedPercent: 21.6, resetAt: 1_800_000_000_000 },
        { label: "Week", usedPercent: 25 },
      ],
      billing: [{ type: "budget", used: 157.85, limit: 400, unit: "USD", period: "month" }],
    };
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithProfileUsage("anthropic", usage, "anthropic:default"),
          providerWithProfileUsage("claude-cli", usage, "anthropic:default"),
        ],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["anthropic", "claude-cli"],
        displayName: "Claude",
        accountLabel: "anthropic:default",
        plan: "Max (20x)",
        windows: [
          { label: "5h", usedPercent: 22, resetAt: 1_800_000_000_000 },
          { label: "Week", usedPercent: 25 },
        ],
        budgets: [{ used: 157.85, limit: 400, unit: "USD" }],
      },
    ]);
  });

  it("carries the account label and keeps distinct accounts in separate groups", () => {
    const windows = [{ label: "5h", usedPercent: 10 }];
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithProfileUsage("anthropic", {
            providerId: "anthropic",
            accountEmail: "work@example.com",
            windows,
          }),
          providerWithProfileUsage("claude-cli", {
            providerId: "anthropic",
            accountEmail: "personal@example.com",
            windows,
          }),
        ],
      },
      acceptAll,
    );

    expect(groups.map((group) => group.accountLabel)).toEqual([
      "work@example.com",
      "personal@example.com",
    ]);
    expect(groups).toHaveLength(2);
  });

  it("includes provider-wide billing and every account quota", () => {
    const provider = providerWithProfileUsage("openai");
    provider.profiles = [
      {
        profileId: "openai:work",
        type: "oauth",
        status: "ok",
        email: "work@example.com",
        usage: {
          providerId: "openai",
          plan: "Pro",
          windows: [
            { label: "5h", usedPercent: 10 },
            { label: "Week", usedPercent: 20 },
          ],
        },
      },
      {
        profileId: "openai:personal",
        type: "oauth",
        status: "ok",
        displayName: "Personal",
        usage: {
          providerId: "openai",
          plan: "Plus",
          windows: [{ label: "Week", usedPercent: 30 }],
        },
      },
    ];

    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [provider],
        providerUsage: [
          providerUsage({
            providerId: "openai",
            windows: [],
            billing: [{ type: "budget", used: 12, limit: 100, unit: "USD" }],
          }),
        ],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["openai"],
        displayName: "Claude",
        windows: [],
        budgets: [{ used: 12, limit: 100, unit: "USD" }],
      },
      {
        providers: ["openai"],
        displayName: "Claude",
        accountLabel: "work@example.com",
        plan: "Pro",
        windows: [
          { label: "5h", usedPercent: 10 },
          { label: "Week", usedPercent: 20 },
        ],
        budgets: [],
      },
      {
        providers: ["openai"],
        displayName: "Claude",
        accountLabel: "Personal",
        plan: "Plus",
        windows: [{ label: "Week", usedPercent: 30 }],
        budgets: [],
      },
    ]);
  });

  it("keeps profiles distinct when the provider omits account identity", () => {
    const provider = providerWithProfileUsage("anthropic");
    const usage = {
      providerId: "anthropic",
      windows: [{ label: "Week", usedPercent: 10 }],
    };
    provider.profiles = [
      { profileId: "anthropic:first", type: "oauth", status: "ok", usage },
      { profileId: "anthropic:second", type: "oauth", status: "ok", usage },
    ];

    const groups = collectProviderQuotaGroups({ ts: 1, providers: [provider] }, acceptAll);

    expect(groups).toHaveLength(2);
    expect(groups.map((group) => group.accountLabel)).toEqual([
      "anthropic:first",
      "anthropic:second",
    ]);
  });

  it("drops providers without windows or budgets and invalid budget shapes", () => {
    const groups = collectProviderQuotaGroups(
      {
        ts: 1,
        providers: [
          providerWithProfileUsage("anthropic"),
          providerWithProfileUsage("openrouter"),
          providerWithProfileUsage("openai"),
        ],
        providerUsage: [
          providerUsage({ providerId: "anthropic", windows: [] }),
          providerUsage({
            providerId: "openrouter",
            windows: [],
            billing: [
              { type: "balance", amount: 10, unit: "USD" },
              { type: "budget", used: 5, limit: 0, unit: "USD" },
            ],
          }),
          providerUsage({
            providerId: "openai",
            windows: [{ label: "Week", usedPercent: 140 }],
          }),
        ],
      },
      acceptAll,
    );

    expect(groups).toEqual([
      {
        providers: ["openai"],
        displayName: "Claude",
        windows: [{ label: "Week", usedPercent: 100 }],
        budgets: [],
      },
    ]);
  });

  it("applies the provider filter", () => {
    const usage = { providerId: "anthropic", windows: [{ label: "5h", usedPercent: 10 }] };
    const groups = collectProviderQuotaGroups(
      { ts: 1, providers: [providerWithProfileUsage("anthropic", usage)] },
      () => false,
    );
    expect(groups).toEqual([]);
  });
});
