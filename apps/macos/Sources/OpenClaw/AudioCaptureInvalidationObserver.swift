import AppKit
@preconcurrency import AVFoundation
import Foundation

final class AudioCaptureInvalidationObserver {
    private let configurationCenter: NotificationCenter
    private let wakeCenter: NotificationCenter
    private let wakeObject: NSObject
    private var configurationObserver: NSObjectProtocol?
    private var wakeObserver: NSObjectProtocol?
    #if DEBUG
    private var testInvalidation: (() -> Void)?
    #endif

    init(
        configurationCenter: NotificationCenter = .default,
        wakeCenter: NotificationCenter = NSWorkspace.shared.notificationCenter,
        wakeObject: NSObject = NSWorkspace.shared)
    {
        self.configurationCenter = configurationCenter
        self.wakeCenter = wakeCenter
        self.wakeObject = wakeObject
    }

    deinit {
        self.stop()
    }

    func start(engine: AVAudioEngine, onInvalidation: @escaping @Sendable () -> Void) {
        self.stop()
        #if DEBUG
        self.testInvalidation = onInvalidation
        #endif
        self.configurationObserver = self.configurationCenter.addObserver(
            forName: .AVAudioEngineConfigurationChange,
            object: engine,
            queue: nil)
        { _ in onInvalidation() }
        self.wakeObserver = self.wakeCenter.addObserver(
            forName: NSWorkspace.didWakeNotification,
            object: self.wakeObject,
            queue: nil)
        { _ in onInvalidation() }
    }

    func stop() {
        if let configurationObserver {
            self.configurationCenter.removeObserver(configurationObserver)
        }
        if let wakeObserver {
            self.wakeCenter.removeObserver(wakeObserver)
        }
        self.configurationObserver = nil
        self.wakeObserver = nil
        #if DEBUG
        self.testInvalidation = nil
        #endif
    }

    #if DEBUG
    func _testInvalidate() {
        self.testInvalidation?()
    }
    #endif
}
