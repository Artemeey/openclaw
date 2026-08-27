#if DEBUG
import Darwin
import Foundation

struct MacOSOnboardingE2EOptions: Equatable {
    let target: CLIInstaller.InstallTarget
    let codexCommand: String?
    let resultPath: String?

    private enum ParseError: LocalizedError {
        case missingValue(String)
        case partialCandidate

        var errorDescription: String? {
            switch self {
            case let .missingValue(flag): "\(flag) requires a value"
            case .partialCandidate:
                "Staged onboarding requires both --onboarding-candidate-package and " +
                    "--onboarding-candidate-version."
            }
        }
    }

    static func parse(arguments: [String]) throws -> Self? {
        guard arguments.contains("--onboarding-e2e") else { return nil }
        var candidatePackage: String?
        var candidateVersion: String?
        var codexCommand: String?
        var resultPath: String?

        func value(after index: Int, flag: String) throws -> String {
            guard arguments.indices.contains(index + 1) else {
                throw ParseError.missingValue(flag)
            }
            let value = arguments[index + 1].trimmingCharacters(in: .whitespacesAndNewlines)
            guard !value.isEmpty, !value.hasPrefix("--") else {
                throw ParseError.missingValue(flag)
            }
            return value
        }

        for (index, argument) in arguments.enumerated() {
            switch argument {
            case "--onboarding-candidate-package":
                candidatePackage = try value(after: index, flag: argument)
            case "--onboarding-candidate-version":
                candidateVersion = try value(after: index, flag: argument)
            case "--onboarding-codex-command":
                codexCommand = try value(after: index, flag: argument)
            case "--onboarding-result-path":
                resultPath = try value(after: index, flag: argument)
            default:
                continue
            }
        }

        let target: CLIInstaller.InstallTarget
        switch (candidatePackage, candidateVersion) {
        case (nil, nil):
            target = .channel(.dev)
        case let (packagePath?, expectedVersion?):
            target = .candidate(packagePath: packagePath, expectedVersion: expectedVersion)
        default:
            throw ParseError.partialCandidate
        }
        return Self(target: target, codexCommand: codexCommand, resultPath: resultPath)
    }
}

@MainActor
enum MacOSOnboardingE2ERunner {
    private static let resultPrefix = "OPENCLAW_ONBOARDING_E2E_RESULT="
    // Codex activation owns a 480-second product timeout. The harness must not
    // preempt that real app-owned decision before it can report its outcome.
    private static let setupTimeout: Duration = .seconds(600)

    private struct Result: Encodable {
        let status: String
        let error: String?
        let installTarget: String
        let installedVersion: String?
        let installMs: Int
        let gatewayMs: Int
        let setupMs: Int
        let totalMs: Int
        let selectedKind: String?
    }

    private enum RunnerError: LocalizedError {
        case installFailed
        case installedVersionUnavailable
        case codexConfigurationFailed(String)
        case gatewayDeferred
        case gatewayFailed(String?)
        case setupFailed(String)
        case setupTimedOut
        case unexpectedSelection(String?)

        var errorDescription: String? {
            switch self {
            case .installFailed:
                "The app-owned CLI installation failed."
            case .installedVersionUnavailable:
                "The app-owned CLI installation could not be version-verified."
            case let .codexConfigurationFailed(detail):
                "The deterministic Codex app-server command could not be configured: \(detail)"
            case .gatewayDeferred:
                "The local Gateway could not start because the app is paused or not in local mode."
            case let .gatewayFailed(reason):
                reason.map { "The local Gateway failed to start: \($0)" }
                    ?? "The local Gateway failed to start."
            case let .setupFailed(reason):
                "AI setup failed: \(reason)"
            case .setupTimedOut:
                "AI setup did not connect before the timeout."
            case let .unexpectedSelection(kind):
                "AI setup selected \(kind ?? "no candidate") instead of codex-cli."
            }
        }
    }

    static func runAndExit(options: MacOSOnboardingE2EOptions) async -> Never {
        let totalStart = ContinuousClock.now
        var installMs = 0
        var gatewayMs = 0
        var setupMs = 0
        var installedVersion: String?
        var selectedKind: String?
        var failure: Error?

        do {
            let installStart = ContinuousClock.now
            let installed = await CLIInstaller.install(target: options.target) { status in
                fputs("[onboarding-e2e] \(status)\n", stderr)
            }
            installMs = self.milliseconds(since: installStart)
            guard installed else { throw RunnerError.installFailed }
            installedVersion = try await self.verifyInstalledVersion()

            if let codexCommand = options.codexCommand {
                try await self.configureCodexCommand(codexCommand)
            }

            let state = AppStateStore.shared
            state.connectionMode = .local
            state.isPaused = false

            let gatewayStart = ContinuousClock.now
            switch await CLIInstaller.activateLocalGateway() {
            case .ready:
                break
            case .deferred:
                throw RunnerError.gatewayDeferred
            case let .failed(reason):
                throw RunnerError.gatewayFailed(reason)
            }
            _ = try await GatewayConnection.shared.acquireServerLease()
            gatewayMs = self.milliseconds(since: gatewayStart)

            let setupStart = ContinuousClock.now
            let model = OnboardingAISetupModel()
            model.startIfNeeded()
            try await self.waitForSetup(model)
            setupMs = self.milliseconds(since: setupStart)
            selectedKind = model.selectedKind
            guard selectedKind == "codex-cli" else {
                throw RunnerError.unexpectedSelection(selectedKind)
            }
        } catch {
            failure = error
        }

        let result = Result(
            status: failure == nil ? "passed" : "failed",
            error: failure?.localizedDescription,
            installTarget: options.target.selector,
            installedVersion: installedVersion,
            installMs: installMs,
            gatewayMs: gatewayMs,
            setupMs: setupMs,
            totalMs: self.milliseconds(since: totalStart),
            selectedKind: selectedKind)
        self.emit(result, path: options.resultPath)
        Darwin.exit(failure == nil ? 0 : 1)
    }

    private static func verifyInstalledVersion() async throws -> String {
        let location = CLIInstaller.managedExecutableLocation()
        guard case let .ready(_, version) = await CLIInstaller.status(location: location) else {
            throw RunnerError.installedVersionUnavailable
        }
        return version
    }

    private static func configureCodexCommand(_ codexCommand: String) async throws {
        let executable = CLIInstaller.managedExecutableLocation()
        let command = AppProfile.current.localCLICommand(
            prefix: [executable],
            arguments: [
                "config",
                "set",
                "plugins.entries.codex.config.appServer.command",
                codexCommand,
            ])
        let response = await ShellExecutor.runDetailed(
            command: command,
            cwd: nil,
            env: CLIInstaller.probeEnvironment(location: executable),
            timeout: 30)
        guard response.success else {
            let detail = response.stderr.trimmingCharacters(in: .whitespacesAndNewlines)
            throw RunnerError.codexConfigurationFailed(detail.isEmpty ? "command failed" : detail)
        }
    }

    private static func waitForSetup(_ model: OnboardingAISetupModel) async throws {
        let deadline = ContinuousClock.now.advanced(by: self.setupTimeout)
        while ContinuousClock.now < deadline {
            if model.connected { return }
            if model.phase == .ready, !model.isBusy {
                if let failure = model.detectError {
                    throw RunnerError.setupFailed(failure.detail ?? failure.summary)
                }
                if model.exhaustedAutoCandidates {
                    throw RunnerError.setupFailed("Every automatically detected provider candidate failed.")
                }
            }
            try await Task.sleep(for: .milliseconds(100))
        }
        throw RunnerError.setupTimedOut
    }

    private static func milliseconds(since start: ContinuousClock.Instant) -> Int {
        let components = start.duration(to: .now).components
        let millisecondsFromSeconds = components.seconds * 1000
        let millisecondsFromAttoseconds = components.attoseconds / 1_000_000_000_000_000
        return Int(millisecondsFromSeconds + millisecondsFromAttoseconds)
    }

    private static func emit(_ result: Result, path: String?) {
        guard let data = try? JSONEncoder().encode(result),
              let json = String(data: data, encoding: .utf8)
        else {
            fputs("\(self.resultPrefix){\"status\":\"failed\",\"error\":\"result encoding failed\"}\n", stdout)
            fflush(stdout)
            return
        }
        if let path {
            try? data.write(to: URL(fileURLWithPath: path), options: .atomic)
        }
        fputs("\(self.resultPrefix)\(json)\n", stdout)
        fflush(stdout)
    }
}
#endif
