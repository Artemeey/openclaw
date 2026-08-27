#!/usr/bin/env -S pnpm tsx
// Macos Smoke script supports OpenClaw repository automation.
import { createHash } from "node:crypto";
import { copyFile, readFile, rm } from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { posixAgentWorkspaceScript } from "./agent-workspace.ts";
import {
  die,
  currentRunningSnapshotInfo,
  extractLastOpenClawVersionFromLog,
  makeTempDir,
  isLikelyMacosDesktopHome,
  packageBuildCommitFromTgz,
  packageVersionFromTgz,
  parseMacosDsclUserHomeLine,
  modelProviderConfigBatchJson,
  posixCodexPlatformPackageRepairFunction,
  posixProviderOnlyPluginIsolationScript,
  readGitCommitEnv,
  readPositiveIntEnv,
  repoRoot,
  resolveParallelsModelTimeoutSeconds,
  resolveHostIp,
  resolveHostPort,
  resolveLatestVersion,
  resolveProviderAuth,
  resolveSnapshot,
  run,
  say,
  shouldSkipSnapshotRestore,
  shellQuote,
  validateSnapshotRestoreMode,
  warn,
  withProgressOnStderr,
  writeJson,
  writeSummaryMarkdown,
  type HostServer,
  type Mode,
  type PackageArtifact,
  type Provider,
  type ProviderAuth,
  type SnapshotInfo,
} from "./common.ts";
import { MacosGuest } from "./guest-transports.ts";
import { runSmokeLane, type SmokeLane, type SmokeLaneStatus } from "./lane-runner.ts";
import { MacosDiscordSmoke } from "./macos-discord.ts";
import { resolveMacosVmName, waitForVmStatus } from "./parallels-vm.ts";
import { PhaseRunner } from "./phase-runner.ts";
import {
  npmRegistryEnv,
  packAndServeSmokeArtifact,
  parseSmokeCliArgs,
  posixStopGatewayScript,
  type SmokeCliOptions,
} from "./smoke-common.ts";

interface MacosOptions extends SmokeCliOptions {
  appOnboarding?: "dev" | "staged";
  appOnboardingTrials: number;
  vmNameExplicit: boolean;
  skipLatestRefCheck: boolean;
  discordTokenEnv?: string;
  discordGuildId?: string;
  discordChannelId?: string;
}

interface MacosSummary {
  vm: string;
  snapshotHint: string;
  snapshotId: string;
  mode: Mode;
  provider: Provider;
  latestVersion: string;
  installVersion: string;
  targetPackageSpec: string;
  currentHead: string;
  runDir: string;
  freshMain: {
    status: string;
    version: string;
    gateway: string;
    dashboard: string;
    agent: string;
    discord: string;
  };
  upgrade: {
    precheck: string;
    status: string;
    path: string;
    latestVersionInstalled: string;
    mainVersion: string;
    gateway: string;
    dashboard: string;
    agent: string;
    discord: string;
  };
  appOnboarding?: AppOnboardingSummary;
}

interface AppOnboardingResult {
  status: string;
  error?: string | null;
  installTarget: string;
  installedVersion?: string | null;
  installMs: number;
  gatewayMs: number;
  setupMs: number;
  totalMs: number;
  selectedKind?: string | null;
}

interface AppOnboardingTrialSummary {
  trial: number;
  status: "pass";
  coreVersion: string;
  coreCommit: string;
  installMs: number;
  gatewayMs: number;
  setupMs: number;
  appOnboardingMs: number;
  trialWallMs: number;
}

interface AppOnboardingSummary {
  mode: "dev" | "staged";
  status: "pass" | "fail";
  requestedTrials: number;
  completedTrials: number;
  coreVersion: string;
  coreCommit: string;
  codexVersion: string;
  host: {
    corePackageMs: number;
    appPackageMs: number;
    preparationMs: number;
  };
  trials: AppOnboardingTrialSummary[];
  totalWallMs: number;
}

const guestPath =
  "/opt/homebrew/bin:/opt/homebrew/opt/node/bin:/usr/local/bin:/usr/local/sbin:/opt/homebrew/sbin:/usr/bin:/bin:/usr/sbin:/sbin";
const guestOpenClaw = "openclaw";
const guestOpenClawEntry = '"$(npm root -g)/openclaw/openclaw.mjs"';
const guestOpenClawEntryRunner = `node ${guestOpenClawEntry}`;
const guestNode = "node";
const guestNpm = "npm";

const defaultOptions = (): MacosOptions => ({
  appOnboarding: undefined,
  appOnboardingTrials: 1,
  discordChannelId: undefined,
  discordGuildId: undefined,
  discordTokenEnv: undefined,
  hostIp: undefined,
  hostPort: 18425,
  hostPortExplicit: false,
  installUrl: "https://openclaw.ai/install.sh",
  installVersion: "",
  json: false,
  keepServer: false,
  latestVersion: "",
  mode: "both",
  modelId: undefined,
  npmRegistry: undefined,
  provider: "openai",
  skipLatestRefCheck: false,
  snapshotHint: "macOS 26.5 latest",
  targetPackageSpec: "",
  vmName: "macOS Tahoe",
  vmNameExplicit: false,
});

function usage(): string {
  return `Usage: bash scripts/e2e/parallels-macos-smoke.sh [options]

Options:
  --vm <name>                Parallels VM name. Default: "macOS Tahoe"
  --snapshot-hint <name>     Snapshot name substring/fuzzy match.
                             Default: "macOS 26.5 latest"
  --mode <fresh|upgrade|both>
  --provider <openai|anthropic|minimax>
  --model <provider/model>    Override the model used for the agent-turn smoke.
  --api-key-env <var>        Host env var name for provider API key.
  --openai-api-key-env <var> Alias for --api-key-env (backward compatible)
  --install-url <url>        Installer URL for latest release. Default: https://openclaw.ai/install.sh
  --host-port <port>         Host HTTP port for current-main tgz. Default: 18425
  --host-ip <ip>             Override Parallels host IP.
  --latest-version <ver>     Override npm latest version lookup.
  --install-version <ver>    Pin site-installer version/dist-tag for the baseline lane.
  --target-package-spec <npm-spec>
                             Install this npm package tarball instead of packing current main.
  --app-onboarding <dev|staged>
                             Run the opt-in real-app onboarding benchmark instead of CLI smoke.
  --app-onboarding-trials <n>
                             Restored pristine-VM trials. Default: 1
  --npm-registry <url>       Registry used for target package installs.
  --skip-latest-ref-check    Skip the known latest-release ref-mode precheck in upgrade lane.
  --keep-server              Leave temp host HTTP server running.
  --discord-token-env <var>  Host env var name for Discord bot token.
  --discord-guild-id <id>    Discord guild ID for smoke roundtrip.
  --discord-channel-id <id>  Discord channel ID for smoke roundtrip.
  --json                     Print machine-readable JSON summary.
  -h, --help                 Show help.

Environment:
  OPENCLAW_PARALLELS_DEV_TARGET_REF
                             Pin the guest dev update to a full commit SHA.
`;
}

export function parseArgs(argv: string[]): MacosOptions {
  const options = defaultOptions();
  return parseSmokeCliArgs(argv, options, {
    flagHandlers: {
      "--skip-latest-ref-check": (parsed) => (parsed.skipLatestRefCheck = true),
    },
    usage,
    valueHandlers: {
      "--app-onboarding": (parsed, value) => {
        if (value !== "dev" && value !== "staged") {
          die("--app-onboarding must be dev or staged");
        }
        parsed.appOnboarding = value;
      },
      "--app-onboarding-trials": (parsed, value) => {
        if (!/^[1-9]\d*$/u.test(value)) {
          die("--app-onboarding-trials must be a positive integer");
        }
        parsed.appOnboardingTrials = Number(value);
      },
      "--discord-channel-id": (parsed, value) => (parsed.discordChannelId = value),
      "--discord-guild-id": (parsed, value) => (parsed.discordGuildId = value),
      "--discord-token-env": (parsed, value) => (parsed.discordTokenEnv = value),
      "--vm": (parsed, value) => {
        parsed.vmName = value;
        parsed.vmNameExplicit = true;
      },
    },
  });
}

class MacosSmoke {
  private agentTimeoutSeconds: number;
  private auth: ProviderAuth | null;
  private appZipPath = "";
  private appZipSha256 = "";
  private coreSha256 = "";
  private codexFixturePath = "";
  private codexFixtureSha256 = "";
  private hostCorePackageMs = 0;
  private hostAppPackageMs = 0;
  private hostPreparationMs = 0;
  private appOnboardingStartedAt = 0;
  private appOnboardingStatus: "pass" | "fail" = "pass";
  private appOnboardingTrials: AppOnboardingTrialSummary[] = [];
  private discordToken = "";
  private hostIp = "";
  private hostPort = 0;
  private server: HostServer | null = null;
  private runDir = "";
  private tgzDir = "";
  private artifact: PackageArtifact | null = null;
  private targetExpectVersion = "";
  private latestVersion = "";
  private installVersion = "";
  private snapshot!: SnapshotInfo;
  private phases!: PhaseRunner;
  private guest!: MacosGuest;
  private guestEnv: Record<string, string> = {};
  private discord: MacosDiscordSmoke | null = null;
  private guestUser = "";
  private guestTransport: "current-user" | "sudo" = "current-user";
  private modelTimeoutSeconds: number;
  private updateDevTimeoutSeconds: number;
  private devTargetCommit: string | undefined;
  private options: MacosOptions;

  private status = {
    freshAgent: "skip",
    freshDashboard: "skip",
    freshDiscord: "skip",
    freshGateway: "skip",
    freshMain: "skip",
    freshVersion: "skip",
    latestInstalledVersion: "skip",
    upgrade: "skip",
    upgradeAgent: "skip",
    upgradeDashboard: "skip",
    upgradeDiscord: "skip",
    upgradeGateway: "skip",
    upgradePrecheck: "skip",
    upgradeVersion: "skip",
  };

  constructor(options: MacosOptions) {
    this.options = options;
    this.auth = options.appOnboarding
      ? null
      : resolveProviderAuth({
          apiKeyEnv: options.apiKeyEnv,
          modelId: options.modelId,
          provider: options.provider,
        });
    this.agentTimeoutSeconds = readPositiveIntEnv("OPENCLAW_PARALLELS_MACOS_AGENT_TIMEOUT_S", 2700);
    this.modelTimeoutSeconds = resolveParallelsModelTimeoutSeconds("macos");
    this.updateDevTimeoutSeconds = readPositiveIntEnv(
      "OPENCLAW_PARALLELS_MACOS_UPDATE_DEV_TIMEOUT_S",
      1800,
    );
    this.devTargetCommit = readGitCommitEnv("OPENCLAW_PARALLELS_DEV_TARGET_REF");
    this.validateDiscord();
  }

  async run(): Promise<void> {
    this.options.vmName = resolveMacosVmName(this.options.vmName, this.options.vmNameExplicit);
    this.runDir = await makeTempDir("openclaw-parallels-macos.");
    this.phases = new PhaseRunner(this.runDir);
    this.guest = new MacosGuest(
      {
        getTransport: () => this.guestTransport,
        getEnv: () => this.guestEnv,
        getUser: () => this.guestUser,
        path: guestPath,
        resolveDesktopHome: (user) => this.resolveDesktopHome(user),
        vmName: this.options.vmName,
      },
      this.phases,
    );
    this.discord = this.createDiscordSmoke();
    this.tgzDir = await makeTempDir("openclaw-parallels-macos-tgz.");
    try {
      validateSnapshotRestoreMode(this.options.mode, "macOS smoke");
      this.snapshot = shouldSkipSnapshotRestore()
        ? currentRunningSnapshotInfo(this.options.vmName)
        : resolveSnapshot(this.options.vmName, this.options.snapshotHint);
      if (!this.options.appOnboarding) {
        this.latestVersion = resolveLatestVersion(this.options.latestVersion);
        this.installVersion = this.options.installVersion || this.latestVersion;
      }

      say(`VM: ${this.options.vmName}`);
      say(`Snapshot hint: ${this.options.snapshotHint}`);
      say(`Resolved snapshot: ${this.snapshot.name} [${this.snapshot.state}]`);
      if (this.latestVersion) {
        say(`Latest npm version: ${this.latestVersion}`);
      }
      say(
        `Current head: ${run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim()}`,
      );
      say(
        `Discord smoke: ${this.discordEnabled() ? `guild=${this.options.discordGuildId} channel=${this.options.discordChannelId}` : "disabled"}`,
      );
      say(`Run logs: ${this.runDir}`);

      if (this.options.appOnboarding) {
        await this.runAppOnboardingBenchmark();
        const summaryPath = await this.writeSummary();
        if (this.options.json) {
          process.stdout.write(await readFile(summaryPath, "utf8"));
        } else {
          this.printSummary(summaryPath);
        }
        if (this.appOnboardingStatus === "fail") {
          process.exitCode = 1;
        }
        return;
      }

      if (this.needsHostTgz()) {
        this.hostIp = resolveHostIp(this.options.hostIp);
        this.hostPort = await resolveHostPort(
          this.options.hostPort,
          this.options.hostPortExplicit,
          defaultOptions().hostPort,
        );
        [this.artifact, this.server, this.hostPort] = await packAndServeSmokeArtifact(
          this.tgzDir,
          this.options.targetPackageSpec,
          this.hostIp,
          this.hostPort,
          this.artifactLabel(),
          true,
          this.options.provider,
        );
        if (this.options.targetPackageSpec) {
          this.targetExpectVersion =
            this.artifact.version || (await packageVersionFromTgz(this.artifact.path));
        }
      } else if (this.targetInstallsDirectly()) {
        this.targetExpectVersion = run(
          "npm",
          [
            "view",
            this.options.targetPackageSpec || "",
            "version",
            "--userconfig",
            path.join(this.tgzDir, "npmrc"),
          ],
          { quiet: true },
        ).stdout.trim();
      }

      if (this.options.mode === "fresh" || this.options.mode === "both") {
        await this.runLane("fresh", async () => this.runFreshLane());
      }
      if (this.options.mode === "upgrade" || this.options.mode === "both") {
        await this.runLane("upgrade", async () => this.runUpgradeLane());
      }

      const summaryPath = await this.writeSummary();
      if (this.options.json) {
        process.stdout.write(await readFile(summaryPath, "utf8"));
      } else {
        this.printSummary(summaryPath);
      }
      if (this.status.freshMain === "fail" || this.status.upgrade === "fail") {
        process.exitCode = 1;
      }
    } finally {
      if (!this.options.keepServer) {
        await this.server?.stop().catch(() => undefined);
        await rm(this.tgzDir, { force: true, recursive: true }).catch(() => undefined);
      }
      await this.cleanupDiscordMessages().catch(() => undefined);
      await this.stopVmAfterSuccessfulDiscordSmoke().catch(() => undefined);
    }
  }

  private validateDiscord(): void {
    if (
      !this.options.discordTokenEnv &&
      !this.options.discordGuildId &&
      !this.options.discordChannelId
    ) {
      return;
    }
    if (!this.options.discordTokenEnv) {
      die("--discord-token-env is required when Discord smoke args are set");
    }
    if (!this.options.discordGuildId) {
      die("--discord-guild-id is required when Discord smoke args are set");
    }
    if (!this.options.discordChannelId) {
      die("--discord-channel-id is required when Discord smoke args are set");
    }
    this.discordToken = process.env[this.options.discordTokenEnv] ?? "";
    if (!this.discordToken) {
      die(`${this.options.discordTokenEnv} is required for Discord smoke`);
    }
  }

  private discordEnabled(): boolean {
    return Boolean(
      this.discordToken && this.options.discordGuildId && this.options.discordChannelId,
    );
  }

  private createDiscordSmoke(): MacosDiscordSmoke | null {
    if (!this.discordEnabled()) {
      return null;
    }
    return new MacosDiscordSmoke({
      config: {
        channelId: this.options.discordChannelId || "",
        guildId: this.options.discordGuildId || "",
        token: this.discordToken,
      },
      guest: this.guest,
      guestNode,
      guestOpenClaw,
      guestOpenClawEntry,
      runDir: this.runDir,
      vmName: this.options.vmName,
    });
  }

  private targetInstallsDirectly(): boolean {
    const spec = this.options.targetPackageSpec;
    return Boolean(spec && !/^(https?:|file:|\/|\.\/|\.\.\/|.*\.tgz$)/.test(spec));
  }

  private needsHostTgz(): boolean {
    return this.options.targetPackageSpec
      ? !this.targetInstallsDirectly()
      : this.options.mode !== "upgrade";
  }

  private artifactLabel(): string {
    if (this.targetInstallsDirectly()) {
      return "target package spec";
    }
    return this.options.targetPackageSpec ? "target package tgz" : "current main tgz";
  }

  private async runAppOnboardingBenchmark(): Promise<void> {
    if (this.options.provider !== "openai") {
      die("--app-onboarding currently requires --provider openai");
    }
    if (this.options.targetPackageSpec) {
      die("--app-onboarding packs the current checkout; do not pass --target-package-spec");
    }
    if (this.discordEnabled()) {
      die("--app-onboarding cannot be combined with Discord smoke options");
    }

    this.appOnboardingStartedAt = Date.now();
    await this.prepareAppOnboardingHostArtifacts();
    try {
      for (let trial = 1; trial <= this.options.appOnboardingTrials; trial += 1) {
        try {
          this.appOnboardingTrials.push(await this.runAppOnboardingTrial(trial));
        } catch (error) {
          this.appOnboardingStatus = "fail";
          warn(
            `app onboarding trial ${trial} failed: ${error instanceof Error ? error.message : String(error)}`,
          );
          break;
        }
      }
    } finally {
      const cleanupPassed = await this.phaseReturns("app.cleanup.restore-pristine", 780, () =>
        this.restoreSnapshotStopped(),
      );
      if (!cleanupPassed) {
        this.appOnboardingStatus = "fail";
      }
    }
  }

  private async prepareAppOnboardingHostArtifacts(): Promise<void> {
    const preparationStartedAt = Date.now();
    this.hostIp = resolveHostIp(this.options.hostIp);
    this.hostPort = await resolveHostPort(
      this.options.hostPort,
      this.options.hostPortExplicit,
      defaultOptions().hostPort,
    );

    const coreStartedAt = Date.now();
    await this.phase("host.package-core", 2400, async () => {
      [this.artifact, this.server, this.hostPort] = await packAndServeSmokeArtifact(
        this.tgzDir,
        undefined,
        this.hostIp,
        this.hostPort,
        "app onboarding core and Codex candidates",
        true,
        "openai",
      );
    });
    this.hostCorePackageMs = Date.now() - coreStartedAt;

    if (!this.artifact || !this.server) {
      die("app onboarding core artifact/server missing");
    }
    this.coreSha256 = await this.sha256(this.artifact.path);

    const appStartedAt = Date.now();
    await this.phase("host.package-app", 2400, async () => {
      const architecture = run("uname", ["-m"], { quiet: true }).stdout.trim();
      const packaged = run("bash", ["scripts/package-mac-app.sh"], {
        check: false,
        env: {
          ...process.env,
          ALLOW_ADHOC_SIGNING: "1",
          BUILD_ARCHS: architecture,
          OPENCLAW_SKIP_MLX_TTS: "1",
          SKIP_PNPM_INSTALL: "1",
          SKIP_TSC: "1",
          SKIP_UI_BUILD: "1",
        },
        quiet: true,
      });
      this.log(packaged.stdout);
      this.log(packaged.stderr);
      if (packaged.status !== 0) {
        throw new Error(`macOS app packaging failed with exit code ${packaged.status}`);
      }

      this.appZipPath = path.join(
        this.tgzDir,
        `OpenClaw-app-${this.artifact?.buildCommitShort || "candidate"}.zip`,
      );
      await rm(this.appZipPath, { force: true });
      const zipped = run(
        "ditto",
        [
          "-c",
          "-k",
          "--sequesterRsrc",
          "--keepParent",
          path.join(repoRoot, "dist/OpenClaw.app"),
          this.appZipPath,
        ],
        { check: false, quiet: true },
      );
      this.log(zipped.stdout);
      this.log(zipped.stderr);
      if (zipped.status !== 0) {
        throw new Error(`macOS app archive failed with exit code ${zipped.status}`);
      }

      const fixtureSource = path.join(
        repoRoot,
        "scripts/e2e/parallels/fixtures/codex-app-server.mjs",
      );
      this.codexFixturePath = path.join(this.tgzDir, "codex-app-server.mjs");
      await copyFile(fixtureSource, this.codexFixturePath);
      this.appZipSha256 = await this.sha256(this.appZipPath);
      this.codexFixtureSha256 = await this.sha256(this.codexFixturePath);
    });
    this.hostAppPackageMs = Date.now() - appStartedAt;
    this.hostPreparationMs = Date.now() - preparationStartedAt;
  }

  private async runAppOnboardingTrial(trial: number): Promise<AppOnboardingTrialSummary> {
    const trialStartedAt = Date.now();
    const prefix = `app.trial-${trial}`;
    await this.phase(`${prefix}.restore-snapshot`, 780, () => this.restoreSnapshot());
    await this.phase(`${prefix}.reset-state`, 180, () => this.resetAppOnboardingState());
    await this.phase(`${prefix}.stage-candidate`, 420, () => this.stageAppOnboardingCandidate());

    let result: AppOnboardingResult | undefined;
    await this.phase(
      `${prefix}.app-onboarding`,
      this.options.appOnboarding === "dev" ? 7200 : 1800,
      async () => {
        await this.launchAppOnboarding(trial);
        result = this.readAppOnboardingResult(trial);
        this.log(JSON.stringify(result));
        if (result.status !== "passed") {
          throw new Error(result.error || "app onboarding reported failure");
        }
      },
    );
    if (!result) {
      throw new Error("app onboarding result missing");
    }

    let coreCommit = "";
    await this.phase(`${prefix}.verify`, 420, () => {
      coreCommit = this.verifyAppOnboardingTrial(result as AppOnboardingResult);
    });
    return {
      trial,
      status: "pass",
      coreVersion: result.installedVersion || "",
      coreCommit,
      installMs: result.installMs,
      gatewayMs: result.gatewayMs,
      setupMs: result.setupMs,
      appOnboardingMs: result.totalMs,
      trialWallMs: Date.now() - trialStartedAt,
    };
  }

  private resetAppOnboardingState(): void {
    this.guestSh(String.raw`set -eu
/usr/bin/pkill -x OpenClaw >/dev/null 2>&1 || true
/bin/launchctl bootout "gui/$(/usr/bin/id -u)/ai.openclaw.gateway" >/dev/null 2>&1 || true
/usr/bin/pkill -f '^openclaw-gateway([[:space:]]|$)' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
/usr/bin/defaults delete ai.openclaw.mac.debug >/dev/null 2>&1 || true
/bin/rm -rf "$HOME/.openclaw"
/bin/rm -f "$HOME/.npmrc"
/bin/rm -f "$HOME/Library/LaunchAgents/ai.openclaw.gateway.plist"
/bin/rm -f /private/tmp/openclaw-onboarding-result-*.json
/bin/rm -f /private/tmp/openclaw-onboarding-codex-app-server.jsonl
/bin/rm -rf /private/tmp/openclaw-app-onboarding`);
  }

  private stageAppOnboardingCandidate(): void {
    if (!this.server || !this.artifact) {
      die("app onboarding artifact server missing");
    }
    const stageDir = "/private/tmp/openclaw-app-onboarding";
    const coreStagePath = `${stageDir}/openclaw-current.tgz`;
    const appStagePath = `${stageDir}/OpenClaw.app.zip`;
    const fixtureStagePath = `${stageDir}/codex-app-server.mjs`;
    const registry = this.server.registry?.url;
    if (!registry) {
      die("app onboarding npm registry missing matching Codex candidate");
    }
    const coreStage =
      this.options.appOnboarding === "staged"
        ? `download ${shellQuote(this.server.urlFor(this.artifact.path))} ${shellQuote(coreStagePath)} ${shellQuote(this.coreSha256)}`
        : "";
    this.guestSh(`set -euo pipefail
stage_dir=${shellQuote(stageDir)}
rm -rf "$stage_dir"
mkdir -p "$stage_dir"
download() {
  url="$1"
  destination="$2"
  expected="$3"
  curl -fsSL --connect-timeout 10 --max-time 300 --retry 2 --retry-delay 2 "$url" -o "$destination"
  actual=$(/usr/bin/shasum -a 256 "$destination" | /usr/bin/awk '{print $1}')
  [ "$actual" = "$expected" ] || {
    echo "SHA-256 mismatch for $destination: expected $expected, got $actual" >&2
    exit 1
  }
}
download ${shellQuote(this.server.urlFor(this.appZipPath))} ${shellQuote(appStagePath)} ${shellQuote(this.appZipSha256)}
download ${shellQuote(this.server.urlFor(this.codexFixturePath))} ${shellQuote(fixtureStagePath)} ${shellQuote(this.codexFixtureSha256)}
${coreStage}
/usr/bin/ditto -x -k ${shellQuote(appStagePath)} "$stage_dir"
printf 'registry=%s\n' ${shellQuote(registry)} >"$HOME/.npmrc"
chmod 0600 "$HOME/.npmrc"`);

    const installed = run(
      "prlctl",
      [
        "exec",
        this.options.vmName,
        "/usr/bin/install",
        "-m",
        "0755",
        fixtureStagePath,
        "/usr/local/bin/codex",
      ],
      { check: false, quiet: true, timeoutMs: this.remainingPhaseTimeoutMs(60_000) },
    );
    this.log(installed.stdout);
    this.log(installed.stderr);
    if (installed.status !== 0) {
      throw new Error(`Codex fixture install failed with exit code ${installed.status}`);
    }
    this.guestExec(["/usr/local/bin/codex", "--version"]);
  }

  private async launchAppOnboarding(trial: number): Promise<void> {
    if (!this.server?.registry || !this.artifact?.version) {
      die("app onboarding candidate metadata missing");
    }
    const stageDir = "/private/tmp/openclaw-app-onboarding";
    const resultPath = `/private/tmp/openclaw-onboarding-result-${trial}.json`;
    const argumentsLocal = [
      "--onboarding-e2e",
      "--onboarding-codex-command",
      "/usr/local/bin/codex",
      "--onboarding-result-path",
      resultPath,
    ];
    if (this.options.appOnboarding === "staged") {
      argumentsLocal.push(
        "--onboarding-candidate-package",
        `${stageDir}/openclaw-current.tgz`,
        "--onboarding-candidate-version",
        this.artifact.version,
      );
    }
    const appExecutable = `${stageDir}/OpenClaw.app/Contents/MacOS/OpenClaw`;
    await this.guest.shBackground(
      `macos-app-onboarding-${trial}`,
      `set -euo pipefail
rm -f ${shellQuote(resultPath)} /private/tmp/openclaw-onboarding-codex-app-server.jsonl
${shellQuote(appExecutable)} ${argumentsLocal.map(shellQuote).join(" ")}
test -s ${shellQuote(resultPath)}
cat ${shellQuote(resultPath)}`,
      npmRegistryEnv(this.server.registry.url),
      this.options.appOnboarding === "dev" ? 7_100_000 : 1_700_000,
    );
  }

  private readAppOnboardingResult(trial: number): AppOnboardingResult {
    const raw = this.guestExec([
      "/bin/cat",
      `/private/tmp/openclaw-onboarding-result-${trial}.json`,
    ]);
    return JSON.parse(raw) as AppOnboardingResult;
  }

  private verifyAppOnboardingTrial(result: AppOnboardingResult): string {
    if (!this.artifact?.version || !this.artifact.buildCommit) {
      die("app onboarding core artifact identity missing");
    }
    const expectedVersion = this.artifact.version;
    const cli = `${this.guestHome()}/.openclaw/bin/openclaw`;
    const inspectPath = "/private/tmp/openclaw-onboarding-codex-inspect.json";
    this.guestSh(`set -euo pipefail
test -x ${shellQuote(cli)}
${shellQuote(cli)} --version
/bin/launchctl print "gui/$(/usr/bin/id -u)/ai.openclaw.gateway"
${shellQuote(cli)} gateway status --deep --require-rpc --timeout 15000
${shellQuote(cli)} plugins inspect codex --runtime --json >${shellQuote(inspectPath)}
/opt/homebrew/bin/node - ${shellQuote(String(result.installedVersion || ""))} ${shellQuote(expectedVersion)} ${shellQuote(inspectPath)} <<'JS'
const fs = require("node:fs");
const [installedVersion, expectedVersion, inspectPath] = process.argv.slice(2);
if (installedVersion !== expectedVersion) {
  throw new Error("installed core version " + installedVersion + " did not match " + expectedVersion);
}
const inspect = JSON.parse(fs.readFileSync(inspectPath, "utf8"));
if (inspect.plugin?.id !== "codex" || inspect.plugin?.status !== "loaded") {
  throw new Error("Codex plugin was not loaded: " + JSON.stringify(inspect.plugin));
}
if (inspect.plugin?.version !== expectedVersion || inspect.install?.version !== expectedVersion) {
  throw new Error("Codex version did not match core " + expectedVersion + ": " + JSON.stringify({ plugin: inspect.plugin?.version, install: inspect.install?.version }));
}
const methods = fs.readFileSync("/private/tmp/openclaw-onboarding-codex-app-server.jsonl", "utf8")
  .trim().split(/\\n/u).filter(Boolean).map((line) => JSON.parse(line).method);
for (const method of ["initialize", "thread/start", "turn/start"]) {
  if (!methods.includes(method)) throw new Error("Codex app-server did not receive " + method);
}
JS`);

    const buildInfoPath = this.guestSh(
      `find ${shellQuote(`${this.guestHome()}/.openclaw`)} -path '*/openclaw/dist/build-info.json' -type f -print -quit`,
    )
      .replaceAll("\r", "")
      .trim()
      .split("\n")
      .at(-1);
    if (!buildInfoPath) {
      throw new Error("installed core build-info.json was not found");
    }
    const coreCommit = this.guestSh(
      `/opt/homebrew/bin/node -p "require(${JSON.stringify(buildInfoPath)}).commit"`,
    )
      .replaceAll("\r", "")
      .trim()
      .split("\n")
      .at(-1);
    if (!coreCommit) {
      throw new Error("installed core commit was empty");
    }
    if (this.options.appOnboarding === "staged" && coreCommit !== this.artifact.buildCommit) {
      throw new Error(
        `installed core commit ${coreCommit} did not match staged ${this.artifact.buildCommit}`,
      );
    }
    if (this.options.appOnboarding === "dev") {
      const checkoutCommit = this.guestSh(
        `git -C ${shellQuote(`${this.guestHome()}/.openclaw/dev/openclaw`)} rev-parse HEAD`,
      )
        .replaceAll("\r", "")
        .trim()
        .split("\n")
        .at(-1);
      if (coreCommit !== checkoutCommit) {
        throw new Error(
          `installed core commit ${coreCommit} did not match dev checkout ${checkoutCommit || "<empty>"}`,
        );
      }
    }
    return coreCommit;
  }

  private restoreSnapshotStopped(): void {
    if (shouldSkipSnapshotRestore()) {
      warn("OPENCLAW_PARALLELS_SKIP_SNAPSHOT_RESTORE leaves app-onboarding guest state intact");
      return;
    }
    const status = run("prlctl", ["status", this.options.vmName], {
      check: false,
      quiet: true,
      timeoutMs: this.remainingPhaseTimeoutMs(60_000),
    });
    this.log(status.stdout);
    this.log(status.stderr);
    if (status.stdout.includes(" running") || status.stdout.includes(" suspended")) {
      const stopped = run("prlctl", ["stop", this.options.vmName, "--kill"], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(120_000),
      });
      this.log(stopped.stdout);
      this.log(stopped.stderr);
      if (stopped.status !== 0) {
        throw new Error(`final VM stop failed with exit code ${stopped.status}`);
      }
      waitForVmStatus(this.options.vmName, "stopped", 360, {
        probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000),
      });
    }
    const restored = run(
      "prlctl",
      [
        "snapshot-switch",
        this.options.vmName,
        "--id",
        this.snapshot.id,
        "--skip-resume",
      ],
      { check: false, quiet: true, timeoutMs: this.remainingPhaseTimeoutMs(360_000) },
    );
    this.log(restored.stdout);
    this.log(restored.stderr);
    if (restored.status !== 0) {
      throw new Error(`final snapshot restore failed with exit code ${restored.status}`);
    }
    waitForVmStatus(this.options.vmName, "stopped", 360, {
      probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000),
    });
  }

  private async sha256(filePath: string): Promise<string> {
    return createHash("sha256").update(await readFile(filePath)).digest("hex");
  }

  private requireAuth(): ProviderAuth {
    if (!this.auth) {
      throw new Error("provider auth is unavailable in app-onboarding mode");
    }
    return this.auth;
  }

  private async runLane(name: "fresh" | "upgrade", fn: () => Promise<void>): Promise<void> {
    await runSmokeLane(name, fn, (lane, status) => this.setLaneStatus(lane, status));
  }

  private setLaneStatus(name: SmokeLane, status: SmokeLaneStatus): void {
    if (name === "fresh") {
      this.status.freshMain = status;
    } else {
      this.status.upgrade = status;
    }
  }

  private async runFreshLane(): Promise<void> {
    await this.phase("fresh.restore-snapshot", 780, () => this.restoreSnapshot());
    await this.phase("fresh.reset-state", 180, () => this.resetState());
    await this.phase("fresh.install-main", this.targetInstallsDirectly() ? 420 : 420, () =>
      this.installMain("openclaw-main-fresh.tgz"),
    );
    this.status.freshVersion = await this.extractLastVersion("fresh.install-main");
    await this.phase("fresh.verify-main-version", 60, () => this.verifyTargetVersion());
    await this.phase("fresh.verify-bundle-permissions", 180, () => this.verifyBundlePermissions());
    await this.phase("fresh.onboard-ref", 420, () => this.runRefOnboard());
    await this.phase("fresh.gateway-start", 180, () => this.startManualGatewayIfNeeded());
    await this.phase("fresh.gateway-status", 180, () => this.verifyGateway());
    this.status.freshGateway = "pass";
    await this.phase("fresh.dashboard-load", 180, () => this.verifyDashboardLoad());
    this.status.freshDashboard = "pass";
    await this.phase("fresh.first-agent-turn", this.agentTimeoutSeconds, () => this.verifyTurn());
    this.status.freshAgent = "pass";
    if (this.discordEnabled()) {
      this.status.freshDiscord = "fail";
      await this.phase("fresh.discord-config", 600, () => this.configureDiscord());
      await this.phase("fresh.discord-gateway-ready", 180, () => this.ensureDiscordGatewayReady());
      await this.phase("fresh.discord-roundtrip", 180, () => this.runDiscordRoundtrip("fresh"));
      this.status.freshDiscord = "pass";
    }
  }

  private async runUpgradeLane(): Promise<void> {
    await this.phase("upgrade.restore-snapshot", 780, () => this.restoreSnapshot());
    await this.phase("upgrade.reset-state", 180, () => this.resetState());
    await this.phase("upgrade.install-latest", 420, () => this.installLatestRelease());
    this.status.latestInstalledVersion = await this.extractLastVersion("upgrade.install-latest");
    await this.phase("upgrade.verify-latest-version", 60, () =>
      this.verifyVersionContains(this.installVersion),
    );
    if (this.options.skipLatestRefCheck) {
      this.status.upgradePrecheck = "skipped";
    } else if (
      await this.phaseReturns("upgrade.latest-ref-precheck", 180, () =>
        this.captureLatestRefFailure(),
      )
    ) {
      this.status.upgradePrecheck = "latest-ref-pass";
    } else {
      this.status.upgradePrecheck = "latest-ref-fail";
    }
    if (this.options.targetPackageSpec) {
      await this.phase("upgrade.install-main", this.targetInstallsDirectly() ? 420 : 420, () =>
        this.installMain("openclaw-main-upgrade.tgz"),
      );
      this.status.upgradeVersion = await this.extractLastVersion("upgrade.install-main");
      await this.phase("upgrade.verify-main-version", 60, () => this.verifyTargetVersion());
      await this.phase("upgrade.verify-bundle-permissions", 180, () =>
        this.verifyBundlePermissions(),
      );
    } else {
      await this.phase("upgrade.update-dev", this.updateDevTimeoutSeconds, () =>
        this.runDevChannelUpdate(),
      );
      this.status.upgradeVersion = await this.extractLastVersion("upgrade.update-dev");
      await this.phase("upgrade.verify-dev-channel", 60, () => this.verifyDevChannelUpdate());
    }
    await this.phase("upgrade.onboard-ref", 420, () => this.runRefOnboard());
    await this.phase("upgrade.gateway-start", 180, () => this.startManualGatewayIfNeeded());
    await this.phase("upgrade.gateway-status", 180, () => this.verifyGateway());
    this.status.upgradeGateway = "pass";
    await this.phase("upgrade.dashboard-load", 180, () => this.verifyDashboardLoad());
    this.status.upgradeDashboard = "pass";
    await this.phase("upgrade.first-agent-turn", this.agentTimeoutSeconds, () => this.verifyTurn());
    this.status.upgradeAgent = "pass";
    if (this.discordEnabled()) {
      this.status.upgradeDiscord = "fail";
      await this.phase("upgrade.discord-config", 600, () => this.configureDiscord());
      await this.phase("upgrade.discord-gateway-ready", 180, () =>
        this.ensureDiscordGatewayReady(),
      );
      await this.phase("upgrade.discord-roundtrip", 180, () => this.runDiscordRoundtrip("upgrade"));
      this.status.upgradeDiscord = "pass";
    }
  }

  private async phase(
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<void> {
    await this.phases.phase(name, timeoutSeconds, fn);
  }

  private remainingPhaseTimeoutMs(fallbackMs?: number): number | undefined {
    return this.phases.remainingTimeoutMs(fallbackMs);
  }

  private async phaseReturns(
    name: string,
    timeoutSeconds: number,
    fn: () => Promise<void> | void,
  ): Promise<boolean> {
    return await this.phases.phaseReturns(name, timeoutSeconds, fn);
  }

  private log(text: string): void {
    this.phases.append(text);
  }

  private guestExec(
    args: string[],
    options: { check?: boolean; env?: Record<string, string> } = {},
  ): string {
    return this.guest.exec(args, options);
  }

  private guestOpenClawEntryExec(
    args: string[],
    options: { check?: boolean; env?: Record<string, string> } = {},
  ): string {
    const argv = args.map((arg) => shellQuote(arg)).join(" ");
    return this.guestSh(
      `set -e
entry="$(npm root -g)/openclaw/openclaw.mjs"
exec node "$entry" ${argv}`,
      options.env,
    );
  }

  private guestSh(script: string, env: Record<string, string> = {}): string {
    return this.guest.sh(script, env);
  }

  private waitForCurrentUser(timeoutSeconds = 360): void {
    const prlctlDeadline = Date.now() + 45_000;
    const deadline = Date.now() + timeoutSeconds * 1000;
    while (Date.now() < prlctlDeadline && Date.now() < deadline) {
      const result = run("prlctl", ["exec", this.options.vmName, "--current-user", "whoami"], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(),
      });
      const user = result.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
      if (result.status === 0 && /^[A-Za-z0-9._-]+$/.test(user)) {
        this.guestUser = user;
        this.guestTransport = "current-user";
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    const fallback = this.resolveDesktopUser();
    if (fallback) {
      this.guestUser = fallback;
      this.guestTransport = "sudo";
      warn(
        `desktop user unavailable via Parallels --current-user; using root sudo fallback for ${fallback}`,
      );
      return;
    }
    while (Date.now() < deadline) {
      const result = run("prlctl", ["exec", this.options.vmName, "--current-user", "whoami"], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(),
      });
      const user = result.stdout.trim().replaceAll("\r", "").split("\n").at(-1) ?? "";
      if (result.status === 0 && /^[A-Za-z0-9._-]+$/.test(user)) {
        this.guestUser = user;
        this.guestTransport = "current-user";
        return;
      }
      run("sleep", ["2"], { quiet: true });
    }
    throw new Error("guest current user did not become available");
  }

  private resolveDesktopUser(): string {
    const consoleUser =
      run("prlctl", ["exec", this.options.vmName, "/usr/bin/stat", "-f", "%Su", "/dev/console"], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(30_000),
      })
        .stdout.trim()
        .replaceAll("\r", "")
        .split("\n")
        .at(-1) ?? "";
    if (
      /^[A-Za-z0-9._-]+$/.test(consoleUser) &&
      consoleUser !== "root" &&
      consoleUser !== "loginwindow"
    ) {
      return consoleUser;
    }
    const users = run(
      "prlctl",
      ["exec", this.options.vmName, "/usr/bin/dscl", ".", "-list", "/Users", "NFSHomeDirectory"],
      {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(30_000),
      },
    ).stdout.replaceAll("\r", "");
    for (const line of users.split("\n")) {
      const parsed = parseMacosDsclUserHomeLine(line);
      const user = parsed?.user;
      if (
        user &&
        isLikelyMacosDesktopHome(parsed?.home) &&
        !user.startsWith("_") &&
        user !== "Shared" &&
        user !== ".localized"
      ) {
        return user;
      }
    }
    return "";
  }

  private resolveDesktopHome(user: string): string {
    const output = run(
      "prlctl",
      [
        "exec",
        this.options.vmName,
        "/usr/bin/dscl",
        ".",
        "-read",
        `/Users/${user}`,
        "NFSHomeDirectory",
      ],
      { check: false, quiet: true, timeoutMs: this.remainingPhaseTimeoutMs(30_000) },
    ).stdout.replaceAll("\r", "");
    const match = /^NFSHomeDirectory:\s+(.+)$/m.exec(output);
    return match?.[1]?.trim() || `/Users/${user}`;
  }

  private restoreSnapshot(): void {
    // A restored baseline must resolve public packages, not the previous candidate registry.
    this.guestEnv = {};
    if (shouldSkipSnapshotRestore()) {
      say(`Skip snapshot restore; using current running VM ${this.options.vmName}`);
      this.waitForCurrentUser();
      return;
    }
    say(`Restore snapshot ${this.options.snapshotHint} (${this.snapshot.id})`);
    let restored = false;
    for (let attempt = 1; attempt <= 2; attempt++) {
      const result = run(
        "prlctl",
        ["snapshot-switch", this.options.vmName, "--id", this.snapshot.id],
        { check: false, quiet: true, timeoutMs: this.remainingPhaseTimeoutMs(360_000) },
      );
      this.log(result.stdout);
      this.log(result.stderr);
      if (result.status === 0) {
        restored = true;
        break;
      }
      warn(`snapshot-switch attempt ${attempt} failed (rc=${result.status})`);
      const status = run("prlctl", ["status", this.options.vmName], {
        check: false,
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(60_000),
      }).stdout;
      if (status.includes(" running") || status.includes(" suspended")) {
        run("prlctl", ["stop", this.options.vmName, "--kill"], {
          check: false,
          quiet: true,
          timeoutMs: this.remainingPhaseTimeoutMs(120_000),
        });
        waitForVmStatus(this.options.vmName, "stopped", 360, {
          probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000),
        });
      }
      run("sleep", ["3"], { quiet: true });
    }
    if (!restored) {
      throw new Error("snapshot restore failed");
    }
    const status = run("prlctl", ["status", this.options.vmName], {
      check: false,
      quiet: true,
      timeoutMs: this.remainingPhaseTimeoutMs(60_000),
    }).stdout;
    if (this.snapshot.state === "poweroff" || status.includes(" stopped")) {
      waitForVmStatus(this.options.vmName, "stopped", 360, {
        probeTimeoutMs: () => this.remainingPhaseTimeoutMs(30_000),
      });
      say(`Start restored poweroff snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], {
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(120_000),
      });
    } else if (status.includes(" suspended")) {
      say(`Resume restored snapshot ${this.snapshot.name}`);
      run("prlctl", ["start", this.options.vmName], {
        quiet: true,
        timeoutMs: this.remainingPhaseTimeoutMs(120_000),
      });
    }
    this.waitForCurrentUser();
  }

  private resetState(): void {
    this.guestSh(String.raw`/usr/bin/pkill -f 'openclaw.*gateway run' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw-gateway' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
printf 'preflight.user=%s\n' "$(whoami)"
printf 'preflight.home=%s\n' "$HOME"
printf 'preflight.path=%s\n' "$PATH"
printf 'preflight.umask=%s\n' "$(umask)"
printf 'preflight.npmRoot=%s\n' "$(${guestNpm} root -g 2>/dev/null || true)"
${guestNpm} uninstall -g openclaw >/dev/null 2>&1 || true
rm -rf "$HOME/.openclaw"
# Restored snapshots can contain corrupt optional-dependency tarballs that npm silently skips.
rm -rf "$HOME/.npm/_cacache"
rm -f /tmp/openclaw-parallels-macos-gateway.log`);
  }

  private installLatestRelease(): void {
    this.guestSh(
      `export OPENCLAW_NO_ONBOARD=1
curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${shellQuote(
        this.options.installUrl,
      )} -o /tmp/openclaw-install.sh
bash /tmp/openclaw-install.sh --version ${shellQuote(this.installVersion)}
${guestOpenClaw} --version`,
    );
  }

  private installMain(tempName: string): void {
    this.guestEnv = npmRegistryEnv(this.options.npmRegistry ?? this.server?.registry?.url);
    if (this.targetInstallsDirectly()) {
      this
        .guestSh(`printf 'install-source: registry-spec %s\\n' ${shellQuote(this.options.targetPackageSpec || "")}
for attempt in 1 2; do
  if ${guestNpm} install -g ${shellQuote(this.options.targetPackageSpec || "")}; then
    break
  fi
  if [ "$attempt" -eq 2 ]; then
    exit 1
  fi
  echo "npm install attempt $attempt failed; retrying in 5s" >&2
  sleep 5
done
${guestOpenClaw} --version`);
      return;
    }
    if (!this.artifact || !this.server) {
      die("package artifact/server missing");
    }
    const tgzUrl = this.server.urlFor(this.artifact.path);
    this.guestSh(`printf 'install-source: host-tgz %s\\n' ${shellQuote(tgzUrl)}
curl -fsSL --connect-timeout 10 --max-time 120 --retry 2 --retry-delay 2 ${shellQuote(
      tgzUrl,
    )} -o /tmp/${tempName}
${guestNpm} install -g /tmp/${tempName}
${guestOpenClaw} --version`);
  }

  private async verifyTargetVersion(): Promise<void> {
    if (this.options.targetPackageSpec) {
      this.verifyVersionContains(this.targetExpectVersion);
      return;
    }
    if (!this.artifact) {
      die("package artifact missing");
    }
    const commit =
      this.artifact.buildCommitShort ||
      (await packageBuildCommitFromTgz(this.artifact.path)).slice(0, 7);
    this.verifyVersionContains(commit);
  }

  private verifyVersionContains(needle: string): void {
    const version = this.guestExec([guestOpenClaw, "--version"]);
    if (!version.includes(needle)) {
      throw new Error(`version mismatch: expected substring ${needle}`);
    }
  }

  private verifyBundlePermissions(): void {
    this.guestSh(String.raw`set -eu
root=$(npm root -g)
check_path() {
  path="$1"
  [ -e "$path" ] || return 0
  perm=$(/usr/bin/stat -f '%OLp' "$path")
  perm_oct=$((8#$perm))
  if (( perm_oct & 0002 )); then
    echo "world-writable install artifact: $path ($perm)" >&2
    exit 1
  fi
}
check_path "$root/openclaw"
check_path "$root/openclaw/extensions"
if [ -d "$root/openclaw/extensions" ]; then
  while IFS= read -r -d '' extension_dir; do
    check_path "$extension_dir"
  done < <(/usr/bin/find "$root/openclaw/extensions" -mindepth 1 -maxdepth 1 -type d -print0)
fi`);
  }

  private runRefOnboard(): void {
    const auth = this.requireAuth();
    const daemonFlag = this.guestTransport === "sudo" ? "--skip-health" : "--install-daemon";
    this.guestExec([
      "/usr/bin/env",
      `${auth.apiKeyEnv}=${auth.apiKeyValue}`,
      guestOpenClaw,
      "onboard",
      "--non-interactive",
      "--mode",
      "local",
      "--auth-choice",
      auth.authChoice,
      ...(auth.tokenProvider ? ["--token-provider", auth.tokenProvider] : []),
      "--secret-input-mode",
      "ref",
      "--gateway-port",
      "18789",
      "--gateway-bind",
      "loopback",
      daemonFlag,
      "--skip-skills",
      "--accept-risk",
      "--json",
    ]);
  }

  private captureLatestRefFailure(): void {
    this.runRefOnboard();
    this.showGatewayStatusCompat();
  }

  private ensureGuestPnpm(): void {
    this.guestSh(String.raw`set -eu
bootstrap_root=/tmp/openclaw-smoke-pnpm-bootstrap
bootstrap_bin="$bootstrap_root/node_modules/.bin"
if [ -x "$bootstrap_bin/pnpm" ]; then
  echo "bootstrap-pnpm: reuse"
  "$bootstrap_bin/pnpm" --version
  exit 0
fi
echo "bootstrap-pnpm: install"
rm -rf "$bootstrap_root"
mkdir -p "$bootstrap_root"
npm install --prefix "$bootstrap_root" --no-save pnpm@11
"$bootstrap_bin/pnpm" --version`);
  }

  private async runDevChannelUpdate(): Promise<void> {
    this.ensureGuestPnpm();
    const home = this.guestHome();
    const devTargetEnv = this.devTargetCommit
      ? ` OPENCLAW_UPDATE_DEV_TARGET_REF=${shellQuote(this.devTargetCommit)}`
      : "";
    await this.guest.shBackground(
      "macos-update-dev",
      `set -eu
rm -rf ${shellQuote(`${home}/openclaw`)}
export PATH=${shellQuote(`/tmp/openclaw-smoke-pnpm-bootstrap/node_modules/.bin:${guestPath}`)}
${guestNode} - <<'JS'
const fs = require("node:fs");
const path = require("node:path");
const configPath = path.join(process.env.HOME || ${JSON.stringify(home)}, ".openclaw", "openclaw.json");
const config = fs.existsSync(configPath) ? JSON.parse(fs.readFileSync(configPath, "utf8")) : {};
config.update = { ...(config.update || {}), channel: "dev" };
fs.mkdirSync(path.dirname(configPath), { recursive: true });
fs.writeFileSync(configPath, JSON.stringify(config, null, 2) + "\\n");
JS
/usr/bin/env NODE_OPTIONS=--max-old-space-size=8192 OPENCLAW_ALLOW_OLDER_BINARY_DESTRUCTIVE_ACTIONS=1${devTargetEnv} ${guestOpenClawEntryRunner} update --channel dev --yes --json --no-restart --timeout ${this.updateDevTimeoutSeconds}
${guestOpenClawEntryRunner} --version
${guestOpenClawEntryRunner} update status --json`,
      {},
      this.updateDevTimeoutSeconds * 1000,
    );
  }

  private verifyDevChannelUpdate(): void {
    const status = this.guestOpenClawEntryExec(["update", "status", "--json"]);
    const expectedBranch = this.devTargetCommit ? "HEAD" : "main";
    for (const needle of [
      '"installKind": "git"',
      '"value": "dev"',
      `"branch": "${expectedBranch}"`,
    ]) {
      if (!status.includes(needle)) {
        throw new Error(`dev update status missing ${needle}`);
      }
    }
    if (this.devTargetCommit) {
      const checkoutHead =
        this.guestSh(`git -C ${shellQuote(`${this.guestHome()}/openclaw`)} rev-parse HEAD`)
          .replaceAll("\r", "")
          .trim()
          .split("\n")
          .at(-1) ?? "";
      if (checkoutHead !== this.devTargetCommit) {
        throw new Error(
          `dev update checkout head ${checkoutHead || "<empty>"} did not match ${this.devTargetCommit}`,
        );
      }
    }
  }

  private startManualGatewayIfNeeded(): void {
    if (this.guestTransport !== "sudo") {
      return;
    }
    const auth = this.requireAuth();
    const home = this.guestHome();
    this.guestSh(
      `set -euo pipefail
trap '' HUP
/usr/bin/pkill -f 'openclaw.*gateway run' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw-gateway' >/dev/null 2>&1 || true
/usr/bin/pkill -f 'openclaw.mjs gateway' >/dev/null 2>&1 || true
/usr/bin/env HOME=${shellQuote(home)} USER=${shellQuote(this.guestUser)} LOGNAME=${shellQuote(this.guestUser)} PATH=${shellQuote(guestPath)} ${shellQuote(
        `${auth.apiKeyEnv}=${auth.apiKeyValue}`,
      )} OPENCLAW_HOME=${shellQuote(home)} OPENCLAW_STATE_DIR=${shellQuote(`${home}/.openclaw`)} OPENCLAW_CONFIG_PATH=${shellQuote(
        `${home}/.openclaw/openclaw.json`,
      )} ${guestOpenClawEntryRunner} gateway run --bind loopback --port 18789 --force </dev/null >/tmp/openclaw-parallels-macos-gateway.log 2>&1 &
sleep 1`,
    );
  }

  private verifyGateway(): void {
    for (let attempt = 1; attempt <= 8; attempt++) {
      const result = this.guestOpenClaw(
        ["gateway", "status", "--deep", "--require-rpc", "--timeout", "15000"],
        false,
      );
      if (result) {
        return;
      }
      if (attempt < 8) {
        warn(`gateway-status retry ${attempt}`);
        run("sleep", ["5"], { quiet: true });
      }
    }
    throw new Error("gateway status did not become RPC-ready");
  }

  private showGatewayStatusCompat(): void {
    const help = this.guestExec([guestOpenClaw, "gateway", "status", "--help"], { check: false });
    const args = help.includes("--require-rpc")
      ? ["gateway", "status", "--deep", "--require-rpc"]
      : ["gateway", "status", "--deep"];
    if (!this.guestOpenClaw(args, false)) {
      throw new Error("gateway status failed");
    }
  }

  private guestOpenClaw(args: string[], check: boolean): boolean {
    const result = this.guest.run([guestOpenClaw, ...args], { check: false });
    if (check && result.status !== 0) {
      throw new Error(`openclaw ${args.join(" ")} failed`);
    }
    return result.status === 0;
  }

  private verifyDashboardLoad(): void {
    this.guestSh(String.raw`set -eu
deadline=$((SECONDS + 120))
while [ $SECONDS -lt $deadline ]; do
  if curl -fsSL --connect-timeout 2 --max-time 5 http://127.0.0.1:18789/ >/tmp/openclaw-dashboard-smoke.html 2>/dev/null; then
    if grep -F '<title>OpenClaw Control</title>' /tmp/openclaw-dashboard-smoke.html >/dev/null &&
      grep -F '<openclaw-app></openclaw-app>' /tmp/openclaw-dashboard-smoke.html >/dev/null; then
      asset_paths="$(
        sed -nE 's/.*<(script|link)[^>]*(src|href)=["'"'"']([^"'"'"']+)["'"'"'].*/\3/p' /tmp/openclaw-dashboard-smoke.html |
          grep -E '(^|/)assets/' |
          grep -Ev '^(https?:)?//' |
          sort -u
      )"
      if [ -n "$asset_paths" ]; then
        assets_ok=1
        while IFS= read -r asset_path; do
          [ -n "$asset_path" ] || continue
          case "$asset_path" in
            http://127.0.0.1:18789/*) asset_url="$asset_path" ;;
            /*) asset_url="http://127.0.0.1:18789$asset_path" ;;
            *) asset_url="http://127.0.0.1:18789/$asset_path" ;;
          esac
          curl -fsSL --connect-timeout 2 --max-time 5 "$asset_url" >/dev/null 2>/dev/null ||
            assets_ok=0
        done <<EOF
$asset_paths
EOF
        [ "$assets_ok" -eq 1 ] && exit 0
      fi
    fi
  fi
  sleep 1
done
echo "dashboard HTML did not become ready" >&2
exit 1`);
  }

  private restrictAgentTurnPlugins(): void {
    const auth = this.requireAuth();
    this.guestSh(
      posixProviderOnlyPluginIsolationScript({
        fallbackPluginId: this.options.provider,
        homeFallback: this.guestHome(),
        modelId: auth.modelId,
        nodeCommand: guestNode,
      }),
    );
  }

  private verifyTurn(): void {
    const auth = this.requireAuth();
    this.guestSh(
      `set -euo pipefail\n${posixStopGatewayScript(this.guestTransport === "sudo" ? undefined : guestOpenClawEntryRunner)}`,
    );
    this.guestOpenClawEntryExec(["models", "set", auth.modelId]);
    const modelProviderConfigBatch = modelProviderConfigBatchJson(
      auth.modelId,
      "macos",
      this.modelTimeoutSeconds,
    );
    if (modelProviderConfigBatch) {
      this.guestSh(`provider_config_batch="$(mktemp)"
cat >"$provider_config_batch" <<'JSON'
${modelProviderConfigBatch}
JSON
${guestOpenClawEntryRunner} config set --batch-file "$provider_config_batch" --strict-json
rm -f "$provider_config_batch"`);
    }
    this.guestOpenClawEntryExec([
      "config",
      "set",
      "agents.defaults.skipBootstrap",
      "true",
      "--strict-json",
    ]);
    this.guestOpenClawEntryExec(["config", "set", "tools.profile", "minimal"]);
    this.restrictAgentTurnPlugins();
    this.guestSh(
      `${posixAgentWorkspaceScript("Parallels macOS smoke test assistant.")}
${posixCodexPlatformPackageRepairFunction()}
agent_ok=false
for attempt in 1 2; do
  session_id="parallels-macos-smoke"
  if [ "$attempt" -gt 1 ]; then session_id="parallels-macos-smoke-retry-$attempt"; fi
  rm -f "$HOME/.openclaw/agents/main/sessions/$session_id.jsonl"
  output_file="$(mktemp)"
  set +e
  /usr/bin/env ${shellQuote(`${auth.apiKeyEnv}=${auth.apiKeyValue}`)} ${guestOpenClawEntryRunner} agent --local --agent main --session-id "$session_id" --message ${shellQuote(
    "Reply with exact ASCII text OK only.",
  )} --thinking off --timeout ${this.modelTimeoutSeconds} --json >"$output_file" 2>&1
  rc=$?
  set -e
  cat "$output_file"
  if [ "$rc" -ne 0 ]; then
    if [ "$attempt" -lt 2 ] && repair_missing_codex_platform_package "$output_file"; then
      rm -f "$output_file"
      echo "agent turn attempt $attempt hit a missing Codex platform package; retrying"
      continue
    fi
    rm -f "$output_file"
    exit "$rc"
  fi
  if grep -Eq '"finalAssistant(Raw|Visible)Text"[[:space:]]*:[[:space:]]*"OK"' "$output_file"; then
    agent_ok=true
    rm -f "$output_file"
    break
  fi
  rm -f "$output_file"
  if [ "$attempt" -lt 2 ]; then
    echo "agent turn attempt $attempt finished without OK response; retrying"
    sleep 3
  fi
done
if [ "$agent_ok" != true ]; then
  echo "openclaw agent finished without OK response" >&2
  exit 1
fi`,
    );
  }

  private configureDiscord(): void {
    this.discord?.configure();
  }

  private ensureDiscordGatewayReady(): void {
    this.startManualGatewayIfNeeded();
    this.verifyGateway();
    const status = this.guestOpenClawEntryExec(["channels", "status", "--probe", "--json"]);
    if (!status.includes('"discord"')) {
      throw new Error("Discord channel unavailable after gateway restart");
    }
  }

  private async runDiscordRoundtrip(phase: "fresh" | "upgrade"): Promise<void> {
    if (!this.discord) {
      throw new Error("Discord smoke is not configured");
    }
    await this.discord.runRoundtrip(phase);
  }

  private async cleanupDiscordMessages(): Promise<void> {
    await this.discord?.cleanupMessages();
  }

  private async stopVmAfterSuccessfulDiscordSmoke(): Promise<void> {
    this.discord?.stopVmAfterSuccessfulSmoke(this.status.freshDiscord, this.status.upgradeDiscord);
  }

  private guestHome(): string {
    if (!this.guestUser) {
      this.waitForCurrentUser();
    }
    return this.guestTransport === "sudo"
      ? this.resolveDesktopHome(this.guestUser)
      : this.guestExec(["/usr/bin/id", "-P"]).split(":")[8] || `/Users/${this.guestUser}`;
  }

  private async extractLastVersion(phaseName: string): Promise<string> {
    return await extractLastOpenClawVersionFromLog(path.join(this.runDir, `${phaseName}.log`));
  }

  private upgradeSummaryLabel(): string {
    return this.options.targetPackageSpec ? "latest->target-package" : "latest->dev";
  }

  private async writeSummary(): Promise<string> {
    const appOnboarding = this.options.appOnboarding
      ? {
          mode: this.options.appOnboarding,
          status: this.appOnboardingStatus,
          requestedTrials: this.options.appOnboardingTrials,
          completedTrials: this.appOnboardingTrials.length,
          coreVersion: this.artifact?.version || "",
          coreCommit: this.artifact?.buildCommit || "",
          codexVersion: "0.149.1",
          host: {
            corePackageMs: this.hostCorePackageMs,
            appPackageMs: this.hostAppPackageMs,
            preparationMs: this.hostPreparationMs,
          },
          trials: this.appOnboardingTrials,
          totalWallMs: this.appOnboardingStartedAt ? Date.now() - this.appOnboardingStartedAt : 0,
        }
      : undefined;
    const summary: MacosSummary = {
      currentHead:
        this.artifact?.buildCommitShort ||
        run("git", ["rev-parse", "--short", "HEAD"], { quiet: true }).stdout.trim(),
      freshMain: {
        agent: this.status.freshAgent,
        dashboard: this.status.freshDashboard,
        discord: this.status.freshDiscord,
        gateway: this.status.freshGateway,
        status: this.status.freshMain,
        version: this.status.freshVersion,
      },
      installVersion: this.installVersion,
      latestVersion: this.latestVersion,
      mode: this.options.mode,
      provider: this.options.provider,
      runDir: this.runDir,
      snapshotHint: this.options.snapshotHint,
      snapshotId: this.snapshot.id,
      targetPackageSpec: this.options.targetPackageSpec || "",
      upgrade: {
        agent: this.status.upgradeAgent,
        dashboard: this.status.upgradeDashboard,
        discord: this.status.upgradeDiscord,
        gateway: this.status.upgradeGateway,
        latestVersionInstalled: this.status.latestInstalledVersion,
        mainVersion: this.status.upgradeVersion,
        path: this.upgradeSummaryLabel(),
        precheck: this.status.upgradePrecheck,
        status: this.status.upgrade,
      },
      vm: this.options.vmName,
      ...(appOnboarding ? { appOnboarding } : {}),
    };
    const summaryPath = path.join(this.runDir, "summary.json");
    await writeJson(summaryPath, summary);
    if (summary.appOnboarding) {
      const app = summary.appOnboarding;
      await writeSummaryMarkdown({
        lines: [
          `- vm: ${summary.vm}`,
          `- app onboarding: ${app.status} (${app.mode})`,
          `- exact core: ${app.coreVersion} (${app.coreCommit})`,
          `- matching Codex: ${app.codexVersion}`,
          `- host core package: ${app.host.corePackageMs} ms`,
          `- host app package: ${app.host.appPackageMs} ms`,
          `- host preparation total: ${app.host.preparationMs} ms`,
          `- restored trials: ${app.completedTrials}/${app.requestedTrials}`,
          ...app.trials.map(
            (trial) =>
              `- trial ${trial.trial}: app=${trial.appOnboardingMs} ms wall=${trial.trialWallMs} ms install=${trial.installMs} ms gateway=${trial.gatewayMs} ms setup=${trial.setupMs} ms`,
          ),
          `- total wall: ${app.totalWallMs} ms`,
          `- logs: ${summary.runDir}`,
        ],
        summaryPath,
        title: "macOS Parallels App Onboarding",
      });
      return summaryPath;
    }
    await writeSummaryMarkdown({
      lines: [
        `- vm: ${summary.vm}`,
        `- target: ${summary.targetPackageSpec || "current main"}`,
        `- fresh: ${summary.freshMain.status} ${summary.freshMain.version}`,
        `- fresh gateway/dashboard/agent: ${summary.freshMain.gateway}/${summary.freshMain.dashboard}/${summary.freshMain.agent}`,
        `- upgrade: ${summary.upgrade.status} ${summary.upgrade.mainVersion}`,
        `- logs: ${summary.runDir}`,
      ],
      summaryPath,
      title: "macOS Parallels Smoke",
    });
    return summaryPath;
  }

  private printSummary(summaryPath: string): void {
    process.stdout.write("\nSummary:\n");
    if (this.options.appOnboarding) {
      process.stdout.write(
        `  app-onboarding: ${this.appOnboardingStatus} (${this.options.appOnboarding}) trials=${this.appOnboardingTrials.length}/${this.options.appOnboardingTrials}\n`,
      );
      process.stdout.write(
        `  host: core-package=${this.hostCorePackageMs}ms app-package=${this.hostAppPackageMs}ms preparation=${this.hostPreparationMs}ms\n`,
      );
      for (const trial of this.appOnboardingTrials) {
        process.stdout.write(
          `  trial-${trial.trial}: app=${trial.appOnboardingMs}ms wall=${trial.trialWallMs}ms version=${trial.coreVersion} commit=${trial.coreCommit}\n`,
        );
      }
      process.stdout.write(`  logs: ${this.runDir}\n`);
      process.stdout.write(`  summary: ${summaryPath}\n`);
      return;
    }
    if (this.options.targetPackageSpec) {
      process.stdout.write(`  target-package: ${this.options.targetPackageSpec}\n`);
    }
    if (this.installVersion) {
      process.stdout.write(`  baseline-install-version: ${this.installVersion}\n`);
    }
    process.stdout.write(
      `  fresh-main: ${this.status.freshMain} (${this.status.freshVersion}) discord=${this.status.freshDiscord}\n`,
    );
    process.stdout.write(
      `  latest precheck: ${this.status.upgradePrecheck} (${this.status.latestInstalledVersion})\n`,
    );
    process.stdout.write(
      `  ${this.upgradeSummaryLabel()}: ${this.status.upgrade} (${this.status.upgradeVersion}) discord=${this.status.upgradeDiscord}\n`,
    );
    process.stdout.write(`  logs: ${this.runDir}\n`);
    process.stdout.write(`  summary: ${summaryPath}\n`);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const options = parseArgs(process.argv.slice(2));
  const runSmoke = () => new MacosSmoke(options).run();
  const runPromise = options.json ? withProgressOnStderr(runSmoke) : runSmoke();
  await runPromise.catch((error: unknown) => {
    die(error instanceof Error ? error.message : String(error));
  });
}
