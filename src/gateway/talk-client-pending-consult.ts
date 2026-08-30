import { BoundedSerialQueue } from "../shared/bounded-serial-queue.js";
import { createDeferredCore } from "../shared/deferred.js";

const REALTIME_CONTROL_MAX_PENDING = 8;

export function createRealtimeControlQueue(): BoundedSerialQueue {
  return new BoundedSerialQueue({
    maxPendingCount: REALTIME_CONTROL_MAX_PENDING,
    maxPendingWeight: REALTIME_CONTROL_MAX_PENDING,
  });
}

export type PendingConsult<CapturedControl> = {
  controller: AbortController;
  controlTarget: Promise<CapturedControl | undefined>;
  resolveControlTarget: (captured: CapturedControl | undefined) => void;
};

export function createPendingTalkConsult<CapturedControl>(): PendingConsult<CapturedControl> {
  const targetReady = createDeferredCore<CapturedControl | undefined>();
  return {
    controller: new AbortController(),
    controlTarget: targetReady.promise,
    resolveControlTarget: targetReady.resolve,
  };
}
