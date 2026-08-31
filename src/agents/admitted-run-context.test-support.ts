import type { AdmittedRunContext, PreparedAgentRunAdmission } from "./admitted-run-context.js";
import { createOperationalRunInstanceRef } from "./admitted-run-context.js";

/** Explicit no-audit carrier for fixtures that enter below the admission owner. */
export function createTestAdmittedRunContext(runId: string): AdmittedRunContext {
  return Object.freeze({ operationalRunInstance: createOperationalRunInstanceRef(runId) });
}

/** Explicit prepared-owner seam for tests that exercise post-selection admission. */
export function createTestPreparedRunAdmission(runId: string): PreparedAgentRunAdmission {
  const admitted = createTestAdmittedRunContext(runId);
  return Object.freeze({
    operationalRunInstance: admitted.operationalRunInstance,
    admit: async () => admitted,
    close: () => {},
  });
}

export function withTestAdmittedRunContext<T extends { runId: string }>(
  params: T,
): T & { admittedRunContext: AdmittedRunContext } {
  return {
    ...params,
    admittedRunContext: createTestAdmittedRunContext(params.runId),
  };
}

/** Owns one canonical admission across a fixture's complete retry/fallback lifetime. */
export async function withTestPreparedRunAdmission<R>(
  runId: string,
  run: (preparedRunAdmission: PreparedAgentRunAdmission) => Promise<R>,
): Promise<R> {
  // Tests reset modules before loading runners; resolve their current lease owner, not
  // the module instance captured when this helper was first imported.
  const { prepareSystemAgentRunAdmission } = await import("./admitted-run-context.js");
  const prepared = prepareSystemAgentRunAdmission({}, runId, "test", "test-runner");
  try {
    return await run(prepared);
  } finally {
    prepared.close();
  }
}

/** Exercises post-selection admission and closes it only after the runner settles. */
export function wrapRunWithTestPreparedAdmission<P extends { runId: string }, R>(
  run: (params: P) => Promise<R>,
): (params: Omit<P, "admittedRunContext" | "preparedRunAdmission">) => Promise<R> {
  return (params) =>
    withTestPreparedRunAdmission(params.runId, (preparedRunAdmission) =>
      run({ ...params, preparedRunAdmission } as unknown as P),
    );
}
