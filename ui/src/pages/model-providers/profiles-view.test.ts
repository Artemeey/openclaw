/* @vitest-environment jsdom */

import { render } from "lit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { i18n } from "../../i18n/index.ts";
import type { ModelProviderCard } from "./data.ts";
import { renderProfiles } from "./profiles-view.ts";

type ProfileViewProps = Parameters<typeof renderProfiles>[1];

function card(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  return {
    id: "openai",
    displayName: "OpenAI",
    profiles: [],
    profileProviderIds: {},
    profileAuthProviderIds: {},
    profileOwnerProfileIds: {},
    profileOrder: [],
    profileOrders: {},
    profileOrderProviders: {},
    profileOrderFallbacks: {},
    profileOrderFallbackOrders: {},
    profileOrderLockedOwners: {},
    credentialProviderIds: ["openai"],
    hasConfigApiKey: false,
    modelCount: 1,
    availableModelCount: 1,
    apiKey: { source: "env", envVar: "OPENAI_API_KEY" },
    ...overrides,
  };
}

function props(overrides: Partial<ProfileViewProps> = {}): ProfileViewProps {
  return {
    busy: {},
    canMutate: true,
    configBusy: false,
    messages: {},
    profileCanClearCooldown: true,
    profileCanLogout: true,
    profileCanReorder: true,
    onClearProfileCooldown: () => undefined,
    onLogoutProfile: () => undefined,
    onOpenModelSetup: () => undefined,
    onProfileOrderChange: () => undefined,
    ...overrides,
  };
}

function mount(provider: ModelProviderCard, viewProps = props()): HTMLDivElement {
  const container = document.createElement("div");
  document.body.append(container);
  render(renderProfiles(provider, viewProps), container);
  return container;
}

function text(element: Element | null): string {
  return element?.textContent?.replace(/\s+/gu, " ").trim() ?? "";
}

function profileCard(overrides: Partial<ModelProviderCard> = {}): ModelProviderCard {
  const profileIds = ["openai:one", "openai:two"];
  return card({
    profiles: [
      {
        profileId: profileIds[0]!,
        type: "oauth",
        status: "ok",
        email: "one@example.com",
        displayName: "One",
        logoutSupported: true,
      },
      {
        profileId: profileIds[1]!,
        type: "oauth",
        status: "ok",
        email: "two@example.com",
        displayName: "Two",
        logoutSupported: true,
      },
    ],
    profileProviderIds: Object.fromEntries(profileIds.map((id) => [id, "openai"])),
    profileAuthProviderIds: Object.fromEntries(profileIds.map((id) => [id, "openai"])),
    profileOwnerProfileIds: { openai: profileIds },
    profileOrder: profileIds,
    profileOrders: { openai: profileIds },
    profileOrderProviders: { openai: "openai" },
    profileOrderFallbacks: { openai: "automatic" },
    ...overrides,
  });
}

function pointerEvent(type: string, values: Record<string, unknown>): PointerEvent {
  const event = new Event(type, { bubbles: true, cancelable: true }) as PointerEvent;
  Object.defineProperties(
    event,
    Object.fromEntries(Object.entries(values).map(([key, value]) => [key, { value }])),
  );
  return event;
}

describe("provider profile roster", () => {
  beforeEach(async () => {
    await i18n.setLocale("en");
  });

  afterEach(() => {
    document.body.replaceChildren();
    vi.restoreAllMocks();
  });

  it("renders a compact aligned roster with quiet account actions", () => {
    const provider = profileCard({
      profiles: [
        ...profileCard().profiles,
        {
          profileId: "openai:three",
          type: "oauth",
          status: "expiring",
          email: "three@example.com",
          cooldownUntil: Date.now() + 60_000,
          logoutSupported: true,
        },
      ],
      profileProviderIds: {
        ...profileCard().profileProviderIds,
        "openai:three": "openai",
      },
      profileAuthProviderIds: {
        ...profileCard().profileAuthProviderIds,
        "openai:three": "openai",
      },
      profileOwnerProfileIds: {
        openai: ["openai:one", "openai:two", "openai:three"],
      },
      profileOrder: ["openai:one", "openai:two", "openai:three"],
      profileOrders: { openai: ["openai:one", "openai:two", "openai:three"] },
    });
    const container = mount(provider);

    expect(container.textContent?.replace(/\s+/gu, " ")).toContain(
      "3 accounts · drag to set priority",
    );
    expect(container.querySelectorAll(".model-providers__profile")).toHaveLength(3);
    expect(container.querySelectorAll(".model-providers__profile-logout")).toHaveLength(3);
    expect(container.querySelectorAll(".model-providers__profile-order")).toHaveLength(0);
    expect(container.querySelector(".model-providers__profile-retry")).not.toBeNull();
  });

  it("only offers profile actions advertised by the connected gateway", () => {
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [{ ...base.profiles[0]!, cooldownUntil: Date.now() + 60_000 }, base.profiles[1]!],
      }),
      props({
        profileCanClearCooldown: false,
        profileCanLogout: true,
        profileCanReorder: false,
      }),
    );

    expect(text(container.querySelector(".model-providers__profiles-heading"))).toContain(
      "tried in priority order",
    );
    expect(container.querySelector('button[aria-label="Use automatic rotation"]')).toBeNull();
    expect(container.querySelector(".model-providers__profile-retry")).toBeNull();
    expect(container.querySelectorAll(".model-providers__profile-logout")).toHaveLength(2);
    expect(
      [...container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip")].every(
        (grip) => grip.disabled,
      ),
    ).toBe(true);
  });

  it("targets logout to the selected saved profile", () => {
    const onLogoutProfile = vi.fn();
    const container = mount(
      card({
        profileProviderIds: { "openai:oauth": "openai-codex" },
        profileAuthProviderIds: { "openai:oauth": "openai" },
        profileOwnerProfileIds: { openai: ["openai:oauth"] },
        profiles: [
          {
            profileId: "openai:oauth",
            type: "oauth",
            status: "ok",
            logoutSupported: true,
          },
        ],
      }),
      props({ onLogoutProfile }),
    );
    const logout = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Log out openai:oauth"]',
    );

    expect(logout?.textContent?.trim()).toBe("");
    expect(logout?.querySelector("svg")).not.toBeNull();
    expect(logout?.title).toBe("Log out openai:oauth");
    logout?.click();
    expect(onLogoutProfile).toHaveBeenCalledWith(
      "openai",
      "openai-codex",
      "openai",
      "openai:oauth",
      "openai:oauth",
    );
  });

  it("shows every quota window, plan, billing fact, and summary for each account", () => {
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [
          {
            ...base.profiles[0]!,
            usage: {
              providerId: "openai",
              windows: [
                { label: "5h", usedPercent: 25 },
                { label: "Week", usedPercent: 3 },
              ],
              plan: "Pro",
              billing: [{ type: "balance", amount: 12, unit: "credits" }],
              summary: "Priority account",
            },
          },
          {
            ...base.profiles[1]!,
            usage: { providerId: "openai", windows: [{ label: "Week", usedPercent: 5 }] },
          },
        ],
      }),
    );

    const first = container.querySelector('[data-profile-id="openai:one"]')!;
    expect(first.textContent?.replace(/\s+/gu, " ")).toContain(
      "One · Pro 5-hour limit 75% left Weekly limit 97% left Balance 12 credits Priority account",
    );
    expect(
      [...first.querySelectorAll('[role="progressbar"]')].map((entry) => ({
        label: entry.getAttribute("aria-label"),
        value: entry.getAttribute("aria-valuenow"),
      })),
    ).toEqual([
      { label: "5-hour limit", value: "25" },
      { label: "Weekly limit", value: "3" },
    ]);
    expect(container.querySelectorAll('[role="progressbar"]')).toHaveLength(3);
  });

  it("uses provider-reported account email when stored metadata has none", () => {
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [
          {
            ...base.profiles[0]!,
            email: undefined,
            displayName: undefined,
            usage: {
              providerId: "openai",
              windows: [],
              accountEmail: "provider@example.com",
            },
          },
          base.profiles[1]!,
        ],
      }),
    );

    expect(text(container.querySelector('[data-profile-id="openai:one"]'))).toContain(
      "provider@example.com",
    );
  });

  it("keeps account usage failures and missing-data states on the affected account", () => {
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [
          {
            ...base.profiles[0]!,
            usage: {
              providerId: "openai",
              windows: [],
              error: "account usage unavailable",
            },
          },
          base.profiles[1]!,
        ],
      }),
    );

    expect(text(container.querySelector('[data-profile-id="openai:one"]'))).toContain(
      "account usage unavailable",
    );
    expect(text(container.querySelector('[data-profile-id="openai:two"]'))).toContain(
      "No live usage data reported by this provider.",
    );
  });

  it("shows externally managed CLI credentials without a false expiry warning", () => {
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [
          {
            ...base.profiles[0]!,
            status: "expired",
            externallyManaged: true,
          },
          base.profiles[1]!,
        ],
      }),
    );

    expect(text(container.querySelector('[data-profile-id="openai:one"]'))).toContain(
      "CLI managed",
    );
    expect(text(container.querySelector('[data-profile-id="openai:one"]'))).not.toContain(
      "Expired",
    );
  });

  it("sends the exact owner, provider, and profile when retrying an account", () => {
    const onClearProfileCooldown = vi.fn();
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [{ ...base.profiles[0]!, cooldownUntil: Date.now() + 60_000 }, base.profiles[1]!],
      }),
      props({ onClearProfileCooldown }),
    );

    container
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:one"] .model-providers__profile-retry',
      )
      ?.click();

    expect(onClearProfileCooldown).toHaveBeenCalledOnce();
    expect(onClearProfileCooldown).toHaveBeenCalledWith("openai", "openai", "openai:one");
  });

  it("does not mark an entire account unavailable for a model-scoped cooldown", () => {
    const base = profileCard();
    const container = mount(
      profileCard({
        profiles: [
          {
            ...base.profiles[0]!,
            cooldownUntil: Date.now() + 60_000,
            cooldownModel: "gpt-5.4",
          },
          base.profiles[1]!,
        ],
      }),
    );
    const row = container.querySelector('[data-profile-id="openai:one"]');

    expect(text(row)).toContain("Ready");
    expect(row?.querySelector(".model-providers__profile-retry")).toBeNull();
  });

  it("reorders immediately with pointer drag or keyboard", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(profileCard(), props({ onProfileOrderChange }));
    const firstGrip = container.querySelector<HTMLButtonElement>(
      '[data-profile-id="openai:one"] .model-providers__profile-grip',
    )!;
    const secondRow = container.querySelector<HTMLElement>('[data-profile-id="openai:two"]')!;
    secondRow.getBoundingClientRect = () => ({ top: 0, height: 52 }) as DOMRect;
    Object.defineProperty(document, "elementFromPoint", {
      configurable: true,
      value: () => secondRow,
    });

    firstGrip.dispatchEvent(
      pointerEvent("pointerdown", {
        pointerId: 1,
        pointerType: "mouse",
        button: 0,
        clientX: 10,
        clientY: 10,
      }),
    );
    firstGrip.dispatchEvent(pointerEvent("pointerup", { pointerId: 1, clientX: 10, clientY: 50 }));
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", ["openai:two", "openai:one"]);

    onProfileOrderChange.mockClear();
    const keyboardEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    container
      .querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:two"] .model-providers__profile-grip',
      )
      ?.dispatchEvent(keyboardEvent);
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", ["openai:two", "openai:one"]);
    expect(keyboardEvent.defaultPrevented).toBe(true);
    expect(text(container.querySelector("[data-profile-reorder-status]"))).toBe(
      "Moved two@example.com to priority 1",
    );

    const boundaryEvent = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    firstGrip.dispatchEvent(boundaryEvent);
    expect(boundaryEvent.defaultPrevented).toBe(true);
  });

  it("restores automatic rotation from an explicit order", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      profileCard(),
      props({ busy: { "profiles:openai": true }, onProfileOrderChange }),
    );
    const automatic = container.querySelector<HTMLButtonElement>(
      'button[aria-label="Use automatic rotation"]',
    );

    expect(automatic?.disabled).toBe(false);
    automatic?.click();

    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", null);
  });

  it("describes the configured fallback and hides reset when config already owns the order", () => {
    const onProfileOrderChange = vi.fn();
    const configuredFallback = mount(
      profileCard({ profileOrderFallbacks: { openai: "config" } }),
      props({ onProfileOrderChange }),
    );

    configuredFallback
      .querySelector<HTMLButtonElement>('button[aria-label="Use configured order"]')
      ?.click();
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", null);

    const configuredOrder = mount(profileCard({ profileOrderFallbacks: {} }));
    expect(configuredOrder.querySelector('button[aria-label="Use automatic rotation"]')).toBeNull();
    expect(configuredOrder.querySelector('button[aria-label="Use configured order"]')).toBeNull();
  });

  it("describes an inherited order behind the local override", () => {
    const container = mount(profileCard({ profileOrderFallbacks: { openai: "inherited" } }));

    expect(container.querySelector('button[aria-label="Use inherited order"]')).not.toBeNull();
  });

  it("does not offer reordering when config pins the profile", () => {
    const onProfileOrderChange = vi.fn();
    const container = mount(
      profileCard({
        profileOrders: { openai: ["openai:one"] },
        profileOrderLockedOwners: { openai: true },
      }),
      props({ onProfileOrderChange }),
    );

    expect(text(container.querySelector(".model-providers__profiles-heading"))).toContain(
      "profile pinned in config",
    );
    expect(container.querySelector('button[aria-label="Use automatic rotation"]')).toBeNull();
    const grips = container.querySelectorAll<HTMLButtonElement>(".model-providers__profile-grip");
    expect([...grips].every((grip) => grip.disabled)).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[aria-label="Include two@example.com in rotation"]',
      )?.disabled,
    ).toBe(true);
  });

  it("keeps excluded accounts out of reorder payloads until included", () => {
    const onProfileOrderChange = vi.fn();
    const provider = profileCard({
      profiles: [
        ...profileCard().profiles,
        {
          profileId: "openai:excluded",
          type: "oauth",
          status: "ok",
          logoutSupported: true,
        },
      ],
      profileProviderIds: {
        ...profileCard().profileProviderIds,
        "openai:excluded": "openai",
      },
      profileAuthProviderIds: {
        ...profileCard().profileAuthProviderIds,
        "openai:excluded": "openai",
      },
      profileOwnerProfileIds: {
        openai: ["openai:one", "openai:two", "openai:excluded"],
      },
    });
    const container = mount(provider, props({ onProfileOrderChange }));
    const excluded = container.querySelector<HTMLElement>('[data-profile-id="openai:excluded"]')!;

    expect(
      excluded.querySelector<HTMLButtonElement>(".model-providers__profile-grip")?.disabled,
    ).toBe(true);
    expect(
      excluded.querySelectorAll<HTMLButtonElement>(".model-providers__profile-actions button"),
    ).toHaveLength(2);
    [...excluded.querySelectorAll<HTMLButtonElement>("button")]
      .find((entry) => entry.textContent?.includes("Include"))
      ?.click();
    expect(onProfileOrderChange).toHaveBeenCalledWith("openai", [
      "openai:one",
      "openai:two",
      "openai:excluded",
    ]);
  });

  it("keeps one owner's actions available while another owner is saving", () => {
    const provider = profileCard({
      profiles: [
        { profileId: "openai:one", type: "oauth", status: "ok", logoutSupported: true },
        {
          profileId: "anthropic:one",
          type: "oauth",
          status: "ok",
          logoutSupported: true,
        },
      ],
      profileProviderIds: { "openai:one": "openai", "anthropic:one": "anthropic" },
      profileAuthProviderIds: { "openai:one": "openai", "anthropic:one": "anthropic" },
      profileOwnerProfileIds: {
        openai: ["openai:one"],
        anthropic: ["anthropic:one"],
      },
      profileOrder: ["openai:one", "anthropic:one"],
    });
    const container = mount(provider, props({ busy: { "logout:openai": true } }));

    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-profile-id="openai:one"] .model-providers__profile-logout',
      )?.disabled,
    ).toBe(true);
    expect(
      container.querySelector<HTMLButtonElement>(
        '[data-profile-id="anthropic:one"] .model-providers__profile-logout',
      )?.disabled,
    ).toBe(false);
  });

  it("disables every profile mutation while settings are saving", () => {
    const base = profileCard();
    const provider = profileCard({
      profiles: [
        { ...base.profiles[0]!, cooldownUntil: Date.now() + 60_000 },
        base.profiles[1]!,
        {
          profileId: "openai:excluded",
          type: "oauth",
          status: "ok",
          logoutSupported: true,
        },
      ],
      profileProviderIds: { ...base.profileProviderIds, "openai:excluded": "openai" },
      profileAuthProviderIds: { ...base.profileAuthProviderIds, "openai:excluded": "openai" },
      profileOwnerProfileIds: {
        openai: ["openai:one", "openai:two", "openai:excluded"],
      },
    });
    const container = mount(provider, props({ configBusy: true }));

    expect(
      [
        ...container.querySelectorAll<HTMLButtonElement>(
          ".model-providers__profile-grip, .model-providers__profile-retry, .model-providers__profile-actions button",
        ),
      ].every((button) => button.disabled),
    ).toBe(true);
  });
});
