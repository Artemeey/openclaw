import { describe, expect, it, vi } from "vitest";
import type { PreparedAgentRunAdmission } from "./admitted-run-context.js";
import { wrapRunWithTestPreparedAdmission } from "./admitted-run-context.test-support.js";

describe("runner fixture admission ownership", () => {
  it.each(["resolve", "reject"] as const)(
    "keeps a post-reset admission active across retries and closes after %s",
    async (outcome) => {
      vi.resetModules();
      const { resolvePreparedRunAdmission, resolveAdmittedRunActiveAssertion } =
        await import("./admitted-run-context.js");
      const failure = new Error("fixture run failed");
      let assertActive: (() => void) | undefined;
      const run = wrapRunWithTestPreparedAdmission(
        async (params: { runId: string; preparedRunAdmission?: PreparedAgentRunAdmission }) => {
          const first = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
          assertActive = resolveAdmittedRunActiveAssertion(first);
          expect(assertActive).toBeTypeOf("function");
          expect(assertActive).not.toThrow();
          await Promise.resolve();
          const retry = await resolvePreparedRunAdmission({ ...params, runtimeKind: "embedded" });
          expect(retry).toBe(first);
          expect(assertActive).not.toThrow();
          if (outcome === "reject") {
            throw failure;
          }
          return "complete";
        },
      );

      const result = run({ runId: `fixture-owner-${outcome}` });
      if (outcome === "reject") {
        await expect(result).rejects.toBe(failure);
      } else {
        await expect(result).resolves.toBe("complete");
      }
      expect(assertActive).toThrow("admitted run authority is no longer active");
    },
  );
});
