import { createDeferredCore } from "../shared/deferred.js";

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
