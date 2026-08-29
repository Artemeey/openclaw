// Hover marquee for truncated single-line labels: on pointer enter, animate
// text-indent to slide the clipped tail into view; on leave, the base
// transition in styles/components.css (.hover-marquee) snaps it back quickly.
// text-indent keeps the clipped text inside the same soft-edge viewport while
// avoiding the extra wrapper an inner transform would require.
const MARQUEE_SPEED_PX_PER_SEC = 80;
const MARQUEE_MIN_DURATION_MS = 300;
const MARQUEE_HOVER_DELAY_MS = 500;
type PendingMarquee = { frame: number; timer?: number };

const pendingMarquees = new WeakMap<HTMLElement, PendingMarquee>();
const marqueeWidths = new WeakMap<HTMLElement, number>();
const observedMarquees = new WeakSet<HTMLElement>();
let marqueeResizeObserver: ResizeObserver | undefined;

function isMarqueeHostActive(host: HTMLElement): boolean {
  return host.matches(":hover") || host.matches(":focus-within");
}

function findMarqueeLabel(host: HTMLElement): HTMLElement | null {
  return host.classList.contains("hover-marquee")
    ? host
    : host.querySelector<HTMLElement>(".hover-marquee");
}

function clearPendingMarquee(label: HTMLElement): void {
  const pending = pendingMarquees.get(label);
  if (pending === undefined) {
    return;
  }
  window.cancelAnimationFrame(pending.frame);
  if (pending.timer !== undefined) {
    window.clearTimeout(pending.timer);
  }
  pendingMarquees.delete(label);
}

function observeMarquee(label: HTMLElement): void {
  if (!marqueeResizeObserver && typeof ResizeObserver === "function") {
    // Row endcaps can resize an adopted title without replacing its label.
    // Remeasure the active animation so presence and badge changes cannot clip it.
    marqueeResizeObserver = new ResizeObserver((entries) => {
      for (const entry of entries) {
        if (!(entry.target instanceof HTMLElement)) {
          continue;
        }
        const resizedLabel = entry.target;
        const host = resizedLabel.closest<HTMLElement>(".session-row-host");
        if (!host || !isMarqueeHostActive(host)) {
          marqueeResizeObserver?.unobserve(resizedLabel);
          observedMarquees.delete(resizedLabel);
          marqueeWidths.delete(resizedLabel);
          continue;
        }
        const width = resizedLabel.clientWidth;
        // ResizeObserver can redeliver unchanged geometry. Restarting for that
        // no-op would remove the scrolling class on every animation frame.
        if (marqueeWidths.get(resizedLabel) === width) {
          continue;
        }
        marqueeWidths.set(resizedLabel, width);
        clearPendingMarquee(resizedLabel);
        resizedLabel.classList.remove("hover-marquee--scrolling");
        startHoverMarquee(host);
      }
    });
  }
  if (marqueeResizeObserver && !observedMarquees.has(label)) {
    observedMarquees.add(label);
    marqueeResizeObserver.observe(label);
  }
}

function startHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  observeMarquee(label);
  if (label.classList.contains("hover-marquee--scrolling")) {
    return;
  }
  clearPendingMarquee(label);
  // Hover-only row actions change the title width in CSS after mouseenter.
  // Measure on the next frame so the animation owns the visible width instead
  // of depending on a later ResizeObserver notification to correct it.
  const pending: PendingMarquee = {
    frame: window.requestAnimationFrame(() => {
      if (pendingMarquees.get(label) !== pending || !isMarqueeHostActive(host)) {
        return;
      }
      // A negative mid-transition indent (re-hover while snapping back) shrinks
      // scrollWidth; add it back when calculating the clipped distance.
      const indent = Number.parseFloat(getComputedStyle(label).textIndent) || 0;
      marqueeWidths.set(label, label.clientWidth);
      const overflow = label.scrollWidth - indent - label.clientWidth;
      if (overflow <= 1) {
        pendingMarquees.delete(label);
        label.style.removeProperty("--hover-marquee-shift");
        label.style.removeProperty("--hover-marquee-duration");
        return;
      }
      const extraShift = Number(label.dataset.hoverMarqueeExtraShift ?? 0);
      const shift = overflow + (Number.isFinite(extraShift) ? Math.max(0, extraShift) : 0);
      const durationMs = Math.max(
        MARQUEE_MIN_DURATION_MS,
        Math.round((shift / MARQUEE_SPEED_PX_PER_SEC) * 1000),
      );
      label.style.setProperty("--hover-marquee-shift", `${-shift}px`);
      label.style.setProperty("--hover-marquee-duration", `${durationMs}ms`);
      // Keep quick pointer passes quiet; leaving before the timer fires cancels it.
      const hoverDelay = Number(label.dataset.hoverMarqueeDelay);
      pending.timer = window.setTimeout(
        () => {
          pendingMarquees.delete(label);
          label.classList.add("hover-marquee--scrolling");
        },
        Number.isFinite(hoverDelay) ? Math.max(0, hoverDelay) : MARQUEE_HOVER_DELAY_MS,
      );
    }),
  };
  pendingMarquees.set(label, pending);
}

function stopHoverMarquee(host: HTMLElement): void {
  const label = findMarqueeLabel(host);
  if (!label) {
    return;
  }
  clearPendingMarquee(label);
  label.classList.remove("hover-marquee--scrolling");
  marqueeResizeObserver?.unobserve(label);
  observedMarquees.delete(label);
  marqueeWidths.delete(label);
}

export function startHoverMarqueeFromEvent(event: Event): void {
  if (event.currentTarget instanceof HTMLElement) {
    startHoverMarquee(event.currentTarget);
  }
}

export function stopHoverMarqueeFromEvent(event: Event): void {
  if (event.currentTarget instanceof HTMLElement) {
    stopHoverMarquee(event.currentTarget);
  }
}

function restartHoverMarqueeWhen(
  element: Element | undefined,
  isActive: (host: HTMLElement) => boolean,
): void {
  if (!(element instanceof HTMLElement)) {
    return;
  }
  queueMicrotask(() => {
    const host = element.isConnected ? element.closest<HTMLElement>(".session-row-host") : null;
    if (host && isActive(host)) {
      startHoverMarquee(host);
    }
  });
}

export function restartHoverMarqueeIfHovered(element: Element | undefined): void {
  restartHoverMarqueeWhen(element, (host) => host.matches(":hover"));
}

export function restartHoverMarqueeIfActive(element: Element | undefined): void {
  restartHoverMarqueeWhen(element, isMarqueeHostActive);
}
