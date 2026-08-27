import { lazyCompile } from "./protocol-validator.js";
import {
  WorkerSetupCheckParamsSchema,
  WorkerSetupDescribeParamsSchema,
  WorkerSetupInstallParamsSchema,
  WorkerSetupPrepareParamsSchema,
} from "./schema/worker-setup.js";

export const validateWorkerSetupDescribeParams = lazyCompile(WorkerSetupDescribeParamsSchema);
export const validateWorkerSetupInstallParams = lazyCompile(WorkerSetupInstallParamsSchema);
export const validateWorkerSetupPrepareParams = lazyCompile(WorkerSetupPrepareParamsSchema);
export const validateWorkerSetupCheckParams = lazyCompile(WorkerSetupCheckParamsSchema);
