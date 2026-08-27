import Foundation
import Testing
@testable import OpenClaw

@MainActor
struct MacOSOnboardingE2ERunnerTests {
    @Test func `runner is disabled unless explicitly requested`() throws {
        #expect(try MacOSOnboardingE2EOptions.parse(arguments: ["OpenClaw"]) == nil)
    }

    @Test func `runner defaults to the existing dev onboarding target`() throws {
        let parsed = try MacOSOnboardingE2EOptions.parse(arguments: [
            "OpenClaw",
            "--onboarding-e2e",
        ])
        let options = try #require(parsed)

        #expect(options.target == .channel(.dev))
        #expect(options.codexCommand == nil)
        #expect(options.resultPath == nil)
    }

    @Test func `runner accepts an exact staged candidate and test Codex command`() throws {
        let parsed = try MacOSOnboardingE2EOptions.parse(arguments: [
            "OpenClaw",
            "--onboarding-e2e",
            "--onboarding-candidate-package",
            "/private/tmp/openclaw-current.tgz",
            "--onboarding-candidate-version",
            "2026.8.1",
            "--onboarding-codex-command",
            "/usr/local/bin/codex",
            "--onboarding-result-path",
            "/private/tmp/onboarding-result.json",
        ])
        let options = try #require(parsed)

        #expect(options.target == .candidate(
            packagePath: "/private/tmp/openclaw-current.tgz",
            expectedVersion: "2026.8.1"))
        #expect(options.codexCommand == "/usr/local/bin/codex")
        #expect(options.resultPath == "/private/tmp/onboarding-result.json")
    }

    @Test func `runner rejects a partial staged candidate`() {
        #expect(throws: (any Error).self) {
            try MacOSOnboardingE2EOptions.parse(arguments: [
                "OpenClaw",
                "--onboarding-e2e",
                "--onboarding-candidate-package",
                "/private/tmp/openclaw-current.tgz",
            ])
        }
    }
}
