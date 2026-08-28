import AppKit
@preconcurrency import AVFoundation
import Foundation
import Testing
@testable import OpenClaw

struct AudioInputDeviceObserverTests {
    @Test func `capture invalidation follows the current engine and system wake`() {
        let configurationCenter = NotificationCenter()
        let wakeCenter = NotificationCenter()
        let wakeObject = NSObject()
        let observer = AudioCaptureInvalidationObserver(
            configurationCenter: configurationCenter,
            wakeCenter: wakeCenter,
            wakeObject: wakeObject)
        let firstEngine = AVAudioEngine()
        let secondEngine = AVAudioEngine()
        let counter = AudioInvalidationCounter()

        observer.start(engine: firstEngine) { counter.increment() }
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: firstEngine)
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: secondEngine)
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: wakeObject)
        #expect(counter.value == 2)

        observer.start(engine: secondEngine) { counter.increment() }
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: firstEngine)
        configurationCenter.post(name: .AVAudioEngineConfigurationChange, object: secondEngine)
        observer.stop()
        wakeCenter.post(name: NSWorkspace.didWakeNotification, object: wakeObject)
        #expect(counter.value == 3)
    }

    @Test func `selected available input wins over system default`() {
        let result = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: "desk-mic",
            availableUIDs: ["desk-mic", "built-in"],
            defaultUID: "built-in")

        #expect(result == AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "desk-mic",
            fellBackToSystemDefault: false))
        #expect(result.shouldBindSelectedDevice)
    }

    @Test func `missing selected input falls back without replacing selection`() {
        let result = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: "desk-mic",
            availableUIDs: ["built-in"],
            defaultUID: "built-in")

        #expect(result == AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "built-in",
            fellBackToSystemDefault: true))
        #expect(!result.shouldBindSelectedDevice)
    }

    @Test func `system default and unavailable states resolve explicitly`() {
        let systemDefault = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: "",
            availableUIDs: ["built-in"],
            defaultUID: "built-in")
        let unavailable = AudioInputDeviceSelectionResolver.resolve(
            selectedUID: nil,
            availableUIDs: [],
            defaultUID: "built-in")

        #expect(systemDefault.resolvedUID == "built-in")
        #expect(systemDefault.selectedUID == nil)
        #expect(unavailable.resolvedUID == nil)
    }

    @Test func `default and fallback follow default changes while selected input does not`() {
        let systemDefault = AudioInputDeviceResolution(
            selectedUID: nil,
            resolvedUID: "built-in",
            fellBackToSystemDefault: false)
        let fallback = AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "built-in",
            fellBackToSystemDefault: true)
        let selected = AudioInputDeviceResolution(
            selectedUID: "desk-mic",
            resolvedUID: "desk-mic",
            fellBackToSystemDefault: false)
        let available = Set(["built-in", "new-default", "desk-mic"])

        #expect(systemDefault.shouldRestart(availableUIDs: available, defaultUID: "new-default"))
        #expect(fallback.shouldRestart(availableUIDs: available, defaultUID: "new-default"))
        #expect(!selected.shouldRestart(availableUIDs: available, defaultUID: "new-default"))
        #expect(selected.shouldRestart(availableUIDs: ["built-in"], defaultUID: "built-in"))
    }

    @Test func `has usable default input device consistent with components`() {
        // When no default UID exists, the method must return false.
        // When a default UID exists, the result must match alive-set membership.
        let uid = AudioInputDeviceObserver.defaultInputDeviceUID()
        let alive = AudioInputDeviceObserver.aliveInputDeviceUIDs()
        let expected = uid.map { alive.contains($0) } ?? false
        #expect(AudioInputDeviceObserver.hasUsableDefaultInputDevice() == expected)
    }
}

private final class AudioInvalidationCounter: @unchecked Sendable {
    private let lock = NSLock()
    private var count = 0

    var value: Int {
        self.lock.withLock { self.count }
    }

    func increment() {
        self.lock.withLock { self.count += 1 }
    }
}
