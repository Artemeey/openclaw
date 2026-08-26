import type { ReactiveController, ReactiveControllerHost } from "lit";
import { MODEL_AUTH_USAGE_REFRESH_DELAY_MS } from "../../lib/model-auth.ts";
import type { ModelProvidersData } from "./load.ts";

export class ProfileDeadlineController implements ReactiveController {
  private connected = false;
  private deadlineTimer: number | null = null;
  private deadlineTimerAt: number | null = null;
  private updateStartedAt = 0;
  private usageRefreshTimer: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getData: () => ModelProvidersData | null,
    private readonly refreshUsage: () => void,
  ) {
    host.addController(this);
  }

  hostConnected() {
    this.connected = true;
  }

  hostUpdate() {
    this.updateStartedAt = Date.now();
  }

  hostUpdated() {
    if (!this.connected) {
      return;
    }
    this.schedule(this.getData(), () => this.host.requestUpdate());
  }

  hostDisconnected() {
    this.connected = false;
    this.clear();
  }

  clear() {
    this.clearDeadline();
    this.clearUsageRefresh();
  }

  scheduleUsageRefresh(pending: boolean) {
    this.clearUsageRefresh();
    if (!pending) {
      return;
    }
    this.usageRefreshTimer = window.setTimeout(() => {
      this.usageRefreshTimer = null;
      this.refreshUsage();
    }, MODEL_AUTH_USAGE_REFRESH_DELAY_MS);
  }

  private clearDeadline() {
    if (this.deadlineTimer !== null) {
      window.clearTimeout(this.deadlineTimer);
      this.deadlineTimer = null;
    }
    this.deadlineTimerAt = null;
  }

  private clearUsageRefresh() {
    if (this.usageRefreshTimer !== null) {
      window.clearTimeout(this.usageRefreshTimer);
      this.usageRefreshTimer = null;
    }
  }

  private schedule(data: ModelProvidersData | null, onDeadline: () => void) {
    const now = Date.now();
    let nextDeadline = Number.POSITIVE_INFINITY;
    let crossedDeadline = false;
    let hasRelativeAge = false;
    for (const provider of data?.authStatus?.providers ?? []) {
      for (const profile of provider.profiles) {
        hasRelativeAge ||= profile.lastUsedAt !== undefined;
        for (const deadline of [
          profile.cooldownUntil,
          profile.disabledUntil,
          profile.blockedUntil,
        ]) {
          if (deadline !== undefined && deadline > this.updateStartedAt && deadline <= now) {
            crossedDeadline = true;
          }
          if (deadline !== undefined && deadline > now && deadline < nextDeadline) {
            nextDeadline = deadline;
          }
        }
      }
    }
    if (crossedDeadline) {
      this.clearDeadline();
      onDeadline();
      return;
    }
    if (!Number.isFinite(nextDeadline) && !hasRelativeAge) {
      return;
    }
    // Status and retry controls derive from wall time, so repaint at the
    // earliest eligibility boundary even when no Gateway event arrives.
    const deadlineDelay = Number.isFinite(nextDeadline) ? nextDeadline - now + 50 : 2_147_483_647;
    const delay = Math.min(deadlineDelay, 60_000, 2_147_483_647);
    const timerAt = now + delay;
    // Keep an earlier wake-up across intervening renders. Replacing it can
    // strand controls when rendering crosses the underlying deadline.
    if (
      this.deadlineTimer !== null &&
      this.deadlineTimerAt !== null &&
      this.deadlineTimerAt <= timerAt
    ) {
      return;
    }
    this.clearDeadline();
    this.deadlineTimerAt = timerAt;
    this.deadlineTimer = window.setTimeout(() => {
      this.deadlineTimer = null;
      this.deadlineTimerAt = null;
      onDeadline();
    }, delay);
  }
}
