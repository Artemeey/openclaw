import { definePluginDoctorMigrationFromPlans } from "openclaw/plugin-sdk/runtime-doctor-migrations";
import { detectIMessageLegacyStateMigrations } from "./src/state-migrations.js";

export { legacyConfigRules, normalizeCompatibilityConfig } from "./config-doctor-api.js";

export const stateMigrations = [
  definePluginDoctorMigrationFromPlans({
    id: "imessage-legacy-state",
    label: "iMessage legacy state",
    resolvePlans: detectIMessageLegacyStateMigrations,
  }),
];
