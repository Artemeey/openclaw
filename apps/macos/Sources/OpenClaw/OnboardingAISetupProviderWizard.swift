import Foundation
import OpenClawChatUI
import OpenClawProtocol

extension OnboardingAISetupModel {
    func startProviderWizard(_ option: AuthOption, kind: ProviderWizardKind) {
        guard !self.isBusy, self.activeAuthOption == nil, let serverLease else { return }
        self.activeAuthOption = option
        self.providerWizardKind = kind
        self.authStep = nil
        self.authError = nil
        self.authText = ""
        self.authBusy = true
        self.providerAuthReconciliationPending = false
        let token = self.attemptToken
        let authAttemptID = UUID()
        let authSessionID = UUID().uuidString
        self.authAttemptID = authAttemptID
        self.authSessionID = authSessionID
        Task {
            do {
                let data = try await self.gateway.request(
                    method: kind.startMethod,
                    params: [
                        "sessionId": AnyCodable(authSessionID),
                        "authChoice": AnyCodable(option.id),
                    ],
                    timeoutMs: 600_000,
                    ifCurrentServerLease: serverLease)
                let result = try JSONDecoder().decode(WizardStartResult.self, from: data)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else {
                    // A route reset can race the start response. Cancel the
                    // decoded server session so the discarded flow cannot commit.
                    await self.gateway.cancelWizardSession(result.sessionid, on: serverLease)
                    return
                }
                if let cancellationSessionID = Self.providerAuthCancellationSessionID(
                    requested: authSessionID,
                    returned: result.sessionid)
                {
                    // The returned id owns the live server session. Cancel that
                    // session even when the Gateway violated the echo contract.
                    self.authSessionID = cancellationSessionID
                    self.cancelProviderAuth()
                    return
                }
                if !result.done, result.step == nil, wizardStatusString(result.status) == "running" {
                    self.advanceProviderAuth(stepID: nil, value: nil)
                    return
                }
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error,
                    preparedModelRef: result.preparedmodelref)
            } catch {
                if Self.setupAdmissionIsBusy(error) {
                    guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                    // No session was admitted; cancelling or reconciling could adopt another operation.
                    self.applyAuthWizardResult(
                        done: true,
                        step: nil,
                        status: "error",
                        error: error.localizedDescription,
                        preparedModelRef: nil)
                    return
                }
                // The Gateway session survives socket loss; cancel by its known
                // id before reporting failure so it cannot persist config later.
                let cancellation = await self.gateway.cancelWizardSession(
                    authSessionID,
                    on: serverLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: serverLease)
                {
                    return
                }
                if cancellation != .unresolved {
                    self.authSessionID = nil
                }
                self.authBusy = false
                self.authError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    func cancelProviderAuth() {
        let sessionID = self.authSessionID
        let authServerLease = self.serverLease
        guard let sessionID, let authServerLease else {
            self.authAttemptID = UUID()
            self.providerAuthReconciliationPending = false
            self.clearProviderAuth()
            return
        }
        let authAttemptID = self.authAttemptID
        let token = self.attemptToken
        let activationState = self.lastDetectedActivationState
        self.authBusy = true
        Task {
            let cancellation = await self.gateway.cancelWizardSession(
                sessionID,
                on: authServerLease)
            // The wizard may finish while cancellation is in flight; keep its terminal outcome.
            guard authAttemptID == self.authAttemptID, self.authSessionID == sessionID else { return }
            if cancellation == .absent,
               await self.reconcileProviderAuthAfterUnknownOutcome(
                   token: token,
                   before: activationState,
                   originalServerLease: authServerLease)
            {
                return
            }
            if cancellation == .unresolved {
                self.authError = Failure(
                    summary: "OpenClaw couldn’t confirm cancellation. Setup may still be running. Try Cancel again.",
                    detail: nil)
            } else {
                self.authAttemptID = UUID()
                self.providerAuthReconciliationPending = false
                self.clearProviderAuth()
            }
        }
    }

    func advanceProviderAuth(stepID: String?, value: AnyCodable?) {
        guard let sessionID = authSessionID, let serverLease else { return }
        self.authBusy = true
        self.authError = nil
        var params: [String: AnyCodable] = ["sessionId": AnyCodable(sessionID)]
        if let stepID {
            var answer: [String: AnyCodable] = ["stepId": AnyCodable(stepID)]
            if let value {
                answer["value"] = value
            }
            params["answer"] = AnyCodable(answer)
        }
        let token = self.attemptToken
        let authAttemptID = self.authAttemptID
        Task {
            var requestLease = serverLease
            do {
                let data: Data
                do {
                    data = try await self.gateway.request(
                        method: "wizard.next",
                        params: params,
                        timeoutMs: Self.providerAuthRequestTimeoutMs,
                        ifCurrentServerLease: requestLease)
                } catch OpenClawChatTransportSendError.notDispatched {
                    guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                    // Only this error proves the callback never reached the Gateway.
                    // Keep the wizard identity and retry once on the same route.
                    let replacementLease = try await self.gateway.acquireServerLease(
                        ifSameRouteAs: requestLease,
                        timeoutMs: 5000)
                    guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                    requestLease = replacementLease
                    self.serverLease = requestLease
                    data = try await self.gateway.request(
                        method: "wizard.next",
                        params: params,
                        timeoutMs: Self.providerAuthRequestTimeoutMs,
                        ifCurrentServerLease: requestLease)
                }
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                let result = try JSONDecoder().decode(WizardNextResult.self, from: data)
                self.applyAuthWizardResult(
                    done: result.done,
                    step: result.step,
                    status: wizardStatusString(result.status),
                    error: result.error,
                    preparedModelRef: result.preparedmodelref)
            } catch {
                let cancellation = await self.gateway.cancelWizardSession(sessionID, on: requestLease)
                guard token == self.attemptToken, authAttemptID == self.authAttemptID else { return }
                if cancellation != .cancelled,
                   await self.reconcileProviderAuthAfterUnknownOutcome(
                       token: token,
                       before: self.lastDetectedActivationState,
                       originalServerLease: requestLease)
                {
                    return
                }
                if cancellation != .unresolved {
                    self.authSessionID = nil
                }
                self.authBusy = false
                self.authError = Self.transportFailure(error.localizedDescription)
            }
        }
    }

    private func applyAuthWizardResult(
        done: Bool,
        step: WizardStep?,
        status: String?,
        error: String?,
        preparedModelRef: String?)
    {
        self.authBusy = false
        let validationError = !done && status == "running" && error?.isEmpty == false
        let preserveEnteredValue = validationError && self.authStep?.id == step?.id
        if status == "error" || (done && error != nil) {
            // Terminal sessions are removed by the Gateway. Drop the local id
            // so Cancel dismisses the preserved, copyable error immediately.
            self.authSessionID = nil
            self.authStep = nil
            self.authError = Self.failure(
                label: self.activeAuthOption?.label ?? "Provider login",
                status: "unavailable",
                error: error)
            return
        }
        if status == "cancelled" {
            self.clearProviderAuth()
            return
        }
        if done || status == "done" {
            let preparedProvider = self.providerWizardKind == .prepare
                ? self.activeAuthOption.map { (id: $0.id, label: $0.label) }
                : nil
            let preparedModel = preparedModelRef?
                .trimmingCharacters(in: .whitespacesAndNewlines)
            self.providerAuthReconciliationPending = self.providerWizardKind == .auth
            self.clearProviderAuth()
            if let preparedProvider,
               let preparedModel,
               !preparedModel.isEmpty
            {
                guard let context = self.captureAttemptContext() else {
                    self.failDetectionForMissingRoute()
                    return
                }
                let kind = Self.providerAutoSetupKind(choiceID: preparedProvider.id)
                self.statuses[kind] = .untried
                Task {
                    await self.activate(
                        kind: kind,
                        modelRef: preparedModel,
                        label: preparedProvider.label,
                        tryNextCandidateOnFailure: false,
                        context: context)
                }
                return
            }
            self.scheduleDetection(
                preparedChoiceID: preparedProvider?.id,
                preparedProviderLabel: preparedProvider?.label)
            return
        }
        self.authStep = step
        if validationError {
            self.authError = Self.failure(
                label: self.activeAuthOption?.label ?? "Provider login",
                status: "format",
                error: error)
        }
        if !preserveEnteredValue {
            self.authText = anyCodableString(step?.initialvalue)
        }
        self.authConfirmation = anyCodableBool(step?.initialvalue)
        let options = parseWizardOptions(step?.options)
        self.authSelection = max(0, options.firstIndex {
            anyCodableEqual($0.value, step?.initialvalue)
        } ?? 0)
        // Gateway-executed steps render progress and expose no input control, so
        // no user action would ever ask for the next frame. Keep polling; the
        // session long-polls until the next update or the terminal result, so a
        // download reports live instead of freezing on its first frame.
        if let step, wizardStepExecutor(step) == "gateway" {
            self.advanceProviderAuth(stepID: nil, value: nil)
        }
    }

    private func reconcileProviderAuthAfterUnknownOutcome(
        token: UUID,
        before: PersistedActivationState?,
        originalServerLease: GatewayConnection.ServerLease) async -> Bool
    {
        guard let before else { return false }
        let lease: GatewayConnection.ServerLease
        if await self.gateway.isCurrentServerLease(originalServerLease) {
            lease = originalServerLease
        } else {
            guard let replacement = try? await gateway.acquireServerLease(
                ifSameRouteAs: originalServerLease,
                timeoutMs: 5000)
            else { return false }
            lease = replacement
        }
        guard let data = try? await gateway.request(
            method: "openclaw.setup.detect",
            params: [:],
            timeoutMs: Double(Self.setupDetectionRequestTimeoutMs),
            ifCurrentServerLease: lease),
            token == attemptToken,
            let result = try? JSONDecoder().decode(DetectResult.self, from: data),
            let configuredModel = result.configuredModel,
            Self.activationTransitionWasPersisted(
                expectedModel: configuredModel,
                before: before,
                after: result.persistedActivationState)
        else { return false }
        self.serverLease = lease
        self.clearProviderAuth()
        finishConnected(kind: "provider-auth")
        return true
    }

    private func clearProviderAuth() {
        self.activeAuthOption = nil
        self.providerWizardKind = nil
        self.authSessionID = nil
        self.authStep = nil
        self.authError = nil
        self.authBusy = false
        self.authText = ""
    }

    #if DEBUG
    func _test_setProviderAuth(option: AuthOption, sessionID: String) {
        self.activeAuthOption = option
        self.authSessionID = sessionID
        self.authBusy = true
    }

    func _test_applyAuthWizardResult(
        done: Bool,
        status: String?,
        error: String?,
        preparedModelRef: String? = nil)
    {
        self.applyAuthWizardResult(
            done: done,
            step: nil,
            status: status,
            error: error,
            preparedModelRef: preparedModelRef)
    }

    var _test_authSessionID: String? {
        self.authSessionID
    }
    #endif
}
