import type { TranslationMap } from "../lib/types.ts";
import { en } from "./en.ts";

// Cloud setup copy loads with its Settings and Plugins entry points.
const enCloudWorkers = {
  cloudSetup: {
    connections: "Provider connections",
    intro: "Connect a cloud provider, then choose it when starting a session.",
    add: "Add cloud provider",
    advanced: "Advanced",
    advancedProfiles: "Existing profiles and manual configuration",
    advancedHelp:
      "Edit cloud worker configuration in the Advanced editor. Existing and provider-owned settings are preserved.",
    plugin: "Cloud plugin",
    provider: "Cloud provider",
    chooseProvider: "Choose a provider…",
    guidedChoices:
      "Guided providers are shown here. Existing profiles and manual provider settings remain in Advanced.",
    noOwners: "No cloud setup plugins are available on this Gateway.",
    plugins: "Manage plugins",
    pluginMissing: "Install this plugin from Plugins to continue.",
    enableHelp:
      "Enable this optional plugin to set up cloud sessions. No cloud machine will be created.",
    enableUnavailable:
      "Plugin changes are restricted. Ask a Gateway administrator to check the plugin allowlist.",
    methodsUnavailable: "Cloud setup is not active yet.",
    reconnect:
      "Reconnect to the Gateway, then refresh. Setup methods must be active before you can continue.",
    applyRestart:
      "Saved. Apply the configuration using the Settings restart action, then reconnect to continue.",
    dependency: "Local dependency",
    dependencyVersion: "Installed: {version}. Required: {required}.",
    notInstalled: "Not installed",
    dependencyAvailable: "Compatible",
    dependencyUnsupported:
      "Managed setup is unavailable on this host. Review the plugin diagnostics and configure it in Advanced.",
    install: "Install compatible dependency",
    installTitle: "Install cloud dependency?",
    installConsent:
      "Download and prepare the plugin's compatible executable on the Gateway host? This changes local software only and does not allocate cloud resources.",
    installFailed:
      "The dependency was not installed. Review the diagnostics, fix the host setup, and retry.",
    providerUnavailable:
      "Guided setup is unavailable for this provider. Use Advanced to inspect its settings.",
    connectionName: "Connection name",
    sharedConnectionHelp:
      "This saved connection is shared and cannot be renamed here. Edit it in Advanced; manage its credentials in Secrets.",
    profileName: "Profile name",
    profileNameHelp: "Names the destination in New Session without renaming the shared connection.",
    profileId: "Profile ID",
    profileIdHelp: "This readable ID appears in the Place picker and when moving sessions.",
    profileIdentity: "Profile ID: {id}",
    identityReserved:
      "Reserved for this save and its retries. Cancel setup to begin a different operation.",
    profileExists:
      "Profile {id} now exists. Your previous save may have succeeded, or another operation claimed the ID. Review the configured profile in Advanced; nothing was overwritten and no second profile was created.",
    getCredential: "Get {name}",
    savedConnection: "Saved connection",
    savedConnectionHelp: "Reuse its protected references without replacing shared credentials.",
    newConnection: "New connection",
    secretHelp:
      "Credentials use write-only protected storage on the Gateway. This page cannot retrieve saved values; configuration contains references only.",
    protectedStorage: "Protected credentials",
    showCredential: "Show credential",
    hideCredential: "Hide credential",
    referenceRetained:
      "Using the saved credential without replacing it. Create a new connection to use another key. References are available in Advanced.",
    secretUnavailable:
      "Protected secret storage is unavailable. Reconnect before entering credentials.",
    providerSettings: "Provider settings",
    idleHelp:
      "Review the provider's settings before starting a session. Gateway idle stop is separate from provider idle limits and is shown on the saved profile.",
    configUnavailable: "Configuration is unavailable. Reconnect and refresh before saving.",
    schemaUnavailable:
      "Provider settings are unavailable. Refresh or use Advanced; nothing has been saved.",
    saveConnection: "Save connection",
    noAllocation: "Saving and checking never create a cloud machine or start a model session.",
    prepareChanged:
      "Configuration changed while preparing this connection. Save again to prepare against the current configuration; saved credential references are retained.",
    checkChanged:
      "Configuration changed during the check. Check the connection again to verify the current settings.",
    required: "Enter the connection and profile names and all required credentials.",
    partialSave:
      "Credentials were stored securely, but the connection was not saved. Their references are retained for retry; no secret was deleted. {error}",
    interrupted:
      "The connection changed during setup. Credential inputs were cleared. A secret write may have completed; retry reuses its reserved name. No saved secret was deleted.",
    connectionSettings: "Connection settings",
    endpointSettings: "Gateway endpoint settings",
    empty: "No cloud connections yet. Add a provider to get started.",
    profile: "Session profile",
    removeProfile: "Remove profile",
    manualProfile: "Edit this profile in Advanced. Its provider-owned settings are preserved.",
    idleSuspension: "Gateway idle stop",
    idleSuspensionHelp:
      "suspendAfter safely stops an idle session worker. The next message provisions a replacement; retained snapshot storage may still be billed.",
    idleSuspensionSet: "Suspend after {duration} idle",
    idleSuspensionUnset: "No Gateway idle stop configured",
    checkUnavailable:
      "Read-only checking is not active. Apply pending configuration, reconnect, and refresh before checking.",
    configured: "Configured",
    credentials: "Credentials",
    credentialsState: {
      verified: "Verified",
      unavailable: "Unavailable",
      unverified: "Not verified",
    },
    lifecycle: "Session lifecycle",
    lifecycleState: {
      supported: "Compatible",
      unsupported: "Unsupported",
      unverified: "Not verified",
    },
    endpoint: "Gateway endpoint",
    endpointState: {
      configured_unproven: "Configured · not proven reachable",
      not_configured: "Not configured",
    },
    readOnlyCheck: "Read-only check",
    check: "Check connection",
    realSession: "Real session",
    notTested: "Not tested",
    startSession: "Start session",
    lifecycleBlocked:
      "The provider does not support the required session lifecycle. Resolve its diagnostics before starting a paid session.",
    startHelp:
      "Continue in New Session with this profile selected. Sending starts an ordinary session and may incur cloud and model costs.",
    testAction: "Cloud session test",
    runTest: "Run test session",
    testHelp:
      "A separate test checks a remote model turn, file roundtrip, and worker cleanup. You will be asked to confirm cloud and model charges before it starts.",
    testUnavailable:
      "Cloud testing is not available on this connection. Reconnect to a Gateway with the test wizard, or start an ordinary session above.",
    testRetained:
      "The current test is shown below. Resolve any pending cleanup before starting another test.",
    testTitle: "Test: {name}",
    testOwner:
      "The Gateway owns this test and its cleanup. You can open the session and return here without stopping it.",
    testSession: "Ordinary session",
    openTestSession: "Open test session",
    testConfirmation: "Confirm test costs",
    confirmTest: "Confirm and run test",
    cancelTest: "Cancel test",
    testPassed: "Passed · cleanup verified",
    testPreviousPassed: "Previous test passed · cleanup verified",
    testPreviousConfig:
      "This test belongs to a previous configuration. It does not verify the current settings.",
    testObserved: "See test result below",
    testStarting: "Preparing confirmation",
    testCancelling: "Cancellation requested · waiting for cleanup",
    testCleanupPending: "Waiting for verified cleanup",
    testInterrupted: "Test observation interrupted",
    testRecovery:
      "Reconnect to resume observation. If the Gateway restarted or the wizard expired, inspect the linked session and Gateway cleanup recovery. This page cannot confirm cleanup and will not start another test automatically.",
    testStatus: {
      running: "Test in progress",
      failed: "Test failed",
      cancelled: "Test cancelled",
      "cleanup-pending": "Cleanup pending · inspect the test session",
    },
    testStage: {
      confirmation: "Awaiting consent",
      creating: "Creating the test session",
      allocating: "Preparing the cloud worker",
      running: "Running the remote turn",
      verifying: "Verifying the file roundtrip",
      cleanup: "Verifying worker cleanup",
      finished: "Test finished",
    },
    testCleanup: {
      "not-allocated": "No worker allocated",
      pending: "Cleanup pending",
      verified: "Cleanup verified",
    },
    configure: "Configure cloud sessions",
  },
  cloudWorkersPage: {
    intro: "Run agent sessions on ephemeral cloud machines instead of this gateway.",
    documentation: "Cloud session documentation",
    editAction: "Edit",
    deleteTitle: "Remove cloud session profile",
    deleteConfirm:
      "Remove profile {profile}? New cloud sessions cannot use it after restart. Its saved connection and credentials are retained for outstanding cleanup.",
    adminRequired: "Administrator access is required to manage cloud worker profiles.",
    providerFact: "Provider: {provider}",
    errors: {
      profileMissing: "This profile changed or was removed. Reload the page and try again.",
      saveFailed: "The profile was not saved. Reload the config and try again.",
      deleteFailed: "The profile was not removed. Reload the config and confirm again.",
    },
  },
} satisfies TranslationMap;

export const registerCloudWorkersEnglish = Object.assign(
  () => {
    Object.assign(en, enCloudWorkers);
  },
  { catalog: enCloudWorkers },
);
