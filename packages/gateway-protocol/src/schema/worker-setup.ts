import type { Static } from "typebox";
import { Type } from "typebox";
import { closedObject } from "./closed-object.js";
import { WorkerMachineOptionsSchema } from "./environments.js";
import { SecretRefSchema } from "./primitives.js";

const SetupId = Type.String({
  minLength: 1,
  maxLength: 128,
  pattern: "^(?!constructor$|prototype$)[a-zA-Z0-9][a-zA-Z0-9_-]*$",
});
const Label = Type.String({ minLength: 1, maxLength: 160 });
const Message = Type.String({ maxLength: 1024 });
const Settings = Type.Record(Type.String(), Type.Unknown(), { maxProperties: 32 });
const Credentials = Type.Record(SetupId, SecretRefSchema, { maxProperties: 8 });
const Method = Type.String({ minLength: 3, maxLength: 200, pattern: "^[a-z0-9][a-z0-9._-]*$" });

/** Manifest-owned discovery; these are plugin RPCs, not core lifecycle methods. */
export const WorkerSetupDescriptorSchema = closedObject({
  id: SetupId,
  methods: closedObject({
    describe: Method,
    install: Method,
    prepare: Method,
    check: Method,
  }),
});

export const WorkerSetupDiagnosticSchema = closedObject({
  code: SetupId,
  severity: Type.Union([Type.Literal("info"), Type.Literal("warning"), Type.Literal("error")]),
  message: Message,
  field: Type.Optional(Type.String({ maxLength: 256 })),
  action: Type.Optional(
    Type.Union([
      Type.Literal("install"),
      Type.Literal("save_credentials"),
      Type.Literal("configure_endpoint"),
      Type.Literal("restart"),
      Type.Literal("update_dependency"),
      Type.Literal("use_session"),
    ]),
  ),
});
const Diagnostics = Type.Array(WorkerSetupDiagnosticSchema, { maxItems: 32 });

export const WorkerSetupDependencySchema = closedObject({
  state: Type.Union([
    Type.Literal("available"),
    Type.Literal("missing"),
    Type.Literal("incompatible"),
    Type.Literal("unsupported"),
  ]),
  version: Type.Optional(Label),
  requiredVersion: Label,
  managed: Type.Boolean(),
});

export const WorkerSetupCredentialSchema = closedObject({
  key: SetupId,
  label: Label,
  required: Type.Boolean(),
  description: Type.Optional(Message),
  helpUrl: Type.Optional(
    Type.String({
      minLength: 9,
      maxLength: 2048,
      pattern: "^https://[^\\s/?#]+(?:[/?#][^\\s]*)?$",
    }),
  ),
});

export const WorkerSetupProviderSchema = closedObject({
  id: SetupId,
  label: Label,
  compatibility: Type.Union([
    Type.Literal("guided"),
    Type.Literal("advanced"),
    Type.Literal("unsupported"),
  ]),
  reason: Type.Optional(Message),
  settingsSchema: Settings,
  uiHints: Type.Record(
    Type.String(),
    closedObject({
      label: Type.Optional(Label),
      help: Type.Optional(Message),
      advanced: Type.Optional(Type.Boolean()),
    }),
    { maxProperties: 32 },
  ),
  defaults: Settings,
  credentials: Type.Array(WorkerSetupCredentialSchema, { maxItems: 8 }),
  machines: Type.Optional(WorkerMachineOptionsSchema),
});

export const WorkerSetupConnectionSchema = closedObject({
  connectionId: SetupId,
  label: Label,
  provider: SetupId,
  credentials: Credentials,
  state: Type.Union([Type.Literal("configured"), Type.Literal("configured_unavailable")]),
  profileIds: Type.Array(SetupId, { maxItems: 128 }),
});

export const WorkerSetupProfileSchema = closedObject({
  profileId: SetupId,
  label: Label,
  provider: SetupId,
  connectionId: Type.Optional(SetupId),
  /** Existing Gateway idle suspension policy; absent means no configured suspension. */
  suspendAfter: Type.Optional(Type.String({ maxLength: 64 })),
  settings: Settings,
});

export const WorkerSetupDescribeParamsSchema = closedObject({});
export const WorkerSetupDescribeResultSchema = closedObject({
  dependency: WorkerSetupDependencySchema,
  providers: Type.Array(WorkerSetupProviderSchema, { maxItems: 128 }),
  connections: Type.Array(WorkerSetupConnectionSchema, { maxItems: 128 }),
  profiles: Type.Array(WorkerSetupProfileSchema, { maxItems: 128 }),
  diagnostics: Diagnostics,
});

export const WorkerSetupInstallParamsSchema = closedObject({});
export const WorkerSetupInstallResultSchema = closedObject({
  status: Type.Union([
    Type.Literal("installed"),
    Type.Literal("unmanaged"),
    Type.Literal("failed"),
  ]),
  dependency: WorkerSetupDependencySchema,
  diagnostics: Diagnostics,
});

/** Credentials are references already saved by the caller, never plaintext. */
export const WorkerSetupPrepareParamsSchema = closedObject({
  connectionId: SetupId,
  profileId: SetupId,
  label: Label,
  provider: SetupId,
  settings: Settings,
  credentials: Credentials,
});
/** Apply patch through config.patch with its current CAS revision; prepare saves nothing. */
export const WorkerSetupPrepareResultSchema = closedObject({
  status: Type.Literal("prepared"),
  saved: Type.Literal(false),
  connectionId: SetupId,
  profileId: SetupId,
  patch: Settings,
  restartRequired: Type.Literal(true),
});

export const WorkerSetupCheckParamsSchema = Type.Union([
  closedObject({ profileId: SetupId }),
  closedObject({ connectionId: SetupId }),
]);
export const WorkerSetupCheckResultSchema = closedObject({
  connectionId: Type.Optional(SetupId),
  profileId: Type.Optional(SetupId),
  status: Type.Union([
    Type.Literal("verified"),
    Type.Literal("configured_unavailable"),
    Type.Literal("unsupported"),
    Type.Literal("failed"),
  ]),
  allocation: Type.Literal("none"),
  credentials: Type.Union([
    Type.Literal("verified"),
    Type.Literal("unavailable"),
    Type.Literal("unverified"),
  ]),
  lifecycle: Type.Union([
    Type.Literal("supported"),
    Type.Literal("unsupported"),
    Type.Literal("unverified"),
  ]),
  endpoint: Type.Union([Type.Literal("configured_unproven"), Type.Literal("not_configured")]),
  realSession: Type.Literal("not_tested"),
  diagnostics: Diagnostics,
});

export type WorkerSetupDescriptor = Static<typeof WorkerSetupDescriptorSchema>;
export type WorkerSetupDiagnostic = Static<typeof WorkerSetupDiagnosticSchema>;
export type WorkerSetupDependency = Static<typeof WorkerSetupDependencySchema>;
export type WorkerSetupCredential = Static<typeof WorkerSetupCredentialSchema>;
export type WorkerSetupProvider = Static<typeof WorkerSetupProviderSchema>;
export type WorkerSetupConnection = Static<typeof WorkerSetupConnectionSchema>;
export type WorkerSetupProfile = Static<typeof WorkerSetupProfileSchema>;
export type WorkerSetupDescribeParams = Static<typeof WorkerSetupDescribeParamsSchema>;
export type WorkerSetupDescribeResult = Static<typeof WorkerSetupDescribeResultSchema>;
export type WorkerSetupInstallParams = Static<typeof WorkerSetupInstallParamsSchema>;
export type WorkerSetupInstallResult = Static<typeof WorkerSetupInstallResultSchema>;
export type WorkerSetupPrepareParams = Static<typeof WorkerSetupPrepareParamsSchema>;
export type WorkerSetupPrepareResult = Static<typeof WorkerSetupPrepareResultSchema>;
export type WorkerSetupCheckParams = Static<typeof WorkerSetupCheckParamsSchema>;
export type WorkerSetupCheckResult = Static<typeof WorkerSetupCheckResultSchema>;
