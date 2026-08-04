import type { PluginRuntime } from "openclaw/plugin-sdk/plugin-runtime";
import type { FaceTimeConfig } from "./config.js";
import { inspectFaceTimeDriver, type FaceTimeDriverStatus } from "./driver-setup.js";
import { formatErrorMessage } from "./errors.js";
import { inspectFaceTimeArtifacts } from "./plugin-paths.js";

export type FaceTimeStaticStatus = {
  enabled: boolean;
  activation: "inactive";
  configValid: boolean;
  configErrors: string[];
  artifacts: Awaited<ReturnType<typeof inspectFaceTimeArtifacts>>;
  driverStatus?: FaceTimeDriverStatus;
  driverError?: string;
  note: string;
};

export async function inspectFaceTimeStaticStatus(params: {
  config: FaceTimeConfig;
  configErrors: string[];
  pluginRoot: string;
  runCommandWithTimeout: PluginRuntime["system"]["runCommandWithTimeout"];
}): Promise<FaceTimeStaticStatus> {
  const artifacts = await inspectFaceTimeArtifacts({ pluginRoot: params.pluginRoot });
  let driverStatus: FaceTimeDriverStatus | undefined;
  let driverError: string | undefined;
  try {
    driverStatus = await inspectFaceTimeDriver(params);
  } catch (error) {
    driverError = formatErrorMessage(error);
  }
  return {
    enabled: params.config.enabled,
    activation: "inactive",
    configValid: params.configErrors.length === 0,
    configErrors: params.configErrors,
    artifacts,
    driverStatus,
    driverError,
    note: "Static inspection only; helper, carrier, model media, and remote audibility were not activated or tested.",
  };
}
