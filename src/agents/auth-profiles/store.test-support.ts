import "./store.js";

type AuthProfileStoreTestApi = {
  resetBeforeMultiStoreCommitForTest(): void;
  resetRuntimeSnapshotPublisherForTest(): void;
  setBeforeMultiStoreCommitForTest(run: (agentDir: string | undefined) => void): void;
  setRuntimeSnapshotPublisherForTest(publisher: (publish: () => void) => void): void;
};

function getTestApi(): AuthProfileStoreTestApi {
  return (globalThis as Record<PropertyKey, unknown>)[
    Symbol.for("openclaw.authProfileStoreTestApi")
  ] as AuthProfileStoreTestApi;
}

export const testing: AuthProfileStoreTestApi = {
  resetBeforeMultiStoreCommitForTest: () => getTestApi().resetBeforeMultiStoreCommitForTest(),
  resetRuntimeSnapshotPublisherForTest: () => getTestApi().resetRuntimeSnapshotPublisherForTest(),
  setBeforeMultiStoreCommitForTest: (run) => getTestApi().setBeforeMultiStoreCommitForTest(run),
  setRuntimeSnapshotPublisherForTest: (publisher) =>
    getTestApi().setRuntimeSnapshotPublisherForTest(publisher),
};
