import type { ReactiveController, ReactiveControllerHost } from "lit";
import type { ModelProvidersData } from "./load.ts";

export class ProfileDeadlineController implements ReactiveController {
  private timer: number | null = null;

  constructor(
    private readonly host: ReactiveControllerHost,
    private readonly getData: () => ModelProvidersData | null,
  ) {
    host.addController(this);
  }

  hostUpdated() {
    this.schedule(this.getData(), () => this.host.requestUpdate());
  }

  hostDisconnected() {
    this.clear();
  }

  clear() {
    if (this.timer !== null) {
      window.clearTimeout(this.timer);
      this.timer = null;
    }
  }

  private schedule(data: ModelProvidersData | null, onDeadline: () => void) {
    this.clear();
    const now = Date.now();
    let nextDeadline = Number.POSITIVE_INFINITY;
    let hasRelativeAge = false;
    for (const provider of data?.authStatus?.providers ?? []) {
      for (const profile of provider.profiles) {
        hasRelativeAge ||= profile.lastUsedAt !== undefined;
        for (const deadline of [
          profile.cooldownUntil,
          profile.disabledUntil,
          profile.blockedUntil,
        ]) {
          if (deadline !== undefined && deadline > now && deadline < nextDeadline) {
            nextDeadline = deadline;
          }
        }
      }
    }
    if (!Number.isFinite(nextDeadline) && !hasRelativeAge) {
      return;
    }
    // Status and retry controls derive from wall time, so repaint at the
    // earliest eligibility boundary even when no Gateway event arrives.
    const deadlineDelay = Number.isFinite(nextDeadline) ? nextDeadline - now + 50 : 2_147_483_647;
    const delay = Math.min(deadlineDelay, 60_000, 2_147_483_647);
    this.timer = window.setTimeout(() => {
      this.timer = null;
      onDeadline();
    }, delay);
  }
}
