@preconcurrency import AVFoundation
import AudioToolbox
import Darwin
import Foundation
import Security

private let defaultProcessNames = ["avconferenced", "FaceTime", "Phone"]
private let outputSampleRate = 24_000.0
private let allowedSigningIdentifiers: Set<String> = [
  "com.apple.FaceTime",
  "com.apple.avconferenced",
  "com.apple.mobilephone",
]

private enum CaptureError: LocalizedError {
  case audioProcessNotFound([String])
  case ambiguousAudioOwners([String])
  case coreAudio(String, OSStatus)
  case inputRouteMismatch(String, [String])
  case outputRouteMismatch(String, [String])
  case audioOwnerChanged(String)
  case invalidAudioFormat
  case usageDescriptionMissing
  case conversionFailed(String)

  var errorDescription: String? {
    switch self {
    case .audioProcessNotFound(let names):
      return
        "No active Apple-signed FaceTime audio owner was found (looked for: \(names.joined(separator: ", "))). Connect the call before starting the bridge."
    case .ambiguousAudioOwners(let owners):
      return
        "Multiple Apple-signed FaceTime audio owners are active (\(owners.joined(separator: ", "))). Close unrelated calls and retry."
    case .coreAudio(let operation, let status):
      return "\(operation) failed with Core Audio status \(status)."
    case .inputRouteMismatch(let owner, let devices):
      let selected = devices.isEmpty ? "none" : devices.joined(separator: ", ")
      return
        "\(owner) is not routed to OpenClaw-Mic (input devices: \(selected)). Select OpenClaw-Mic in the call app before retrying."
    case .outputRouteMismatch(let owner, let devices):
      let selected = devices.isEmpty ? "none" : devices.joined(separator: ", ")
      return
        "\(owner) is not routed exclusively to physical output devices (output devices: \(selected)). Select speakers or headphones in the call app before retrying."
    case .audioOwnerChanged(let owners):
      return
        "The active FaceTime audio owner changed while the bridge was running (active owners: \(owners)). The call was stopped to avoid capturing or playing the wrong process."
    case .invalidAudioFormat:
      return "Core Audio returned an unsupported audio format."
    case .usageDescriptionMissing:
      return
        "The capture helper is missing its embedded NSAudioCaptureUsageDescription. Restart OpenClaw to rebuild the FaceTime plugin artifact."
    case .conversionFailed(let message):
      return "Audio conversion failed: \(message)"
    }
  }
}

private let captureQueueOverflowError = CaptureError.conversionFailed(
  "bounded capture queue overflow")

private struct Arguments {
  var checkOnly = false
  var listDefaultDevices = false
  var listProcesses = false
  var processNames = defaultProcessNames

  static func parse(_ raw: [String]) throws -> Arguments {
    var result = Arguments()
    var customProcessNames: [String] = []
    var index = 0
    while index < raw.count {
      switch raw[index] {
      case "--check":
        result.checkOnly = true
      case "--default-devices":
        result.listDefaultDevices = true
      case "--list-processes":
        result.listProcesses = true
      case "--process":
        index += 1
        guard index < raw.count, !raw[index].isEmpty else {
          throw CaptureError.audioProcessNotFound(["<missing --process value>"])
        }
        customProcessNames.append(raw[index])
      default:
        fputs("Unknown argument: \(raw[index])\n", stderr)
        exit(2)
      }
      index += 1
    }
    if !customProcessNames.isEmpty {
      result.processNames = customProcessNames
    }
    return result
  }
}

private struct AudioProcess {
  let bundleID: String
  let name: String
  let objectID: AudioObjectID
  let pid: pid_t
  let runningOutput: Bool
  let trustedIdentity: String
}

private struct AudioDeviceDescription: Codable {
  let isAggregate: Bool
  let name: String
  let uid: String
}

private struct DefaultAudioDevices: Codable {
  let input: AudioDeviceDescription
  let output: AudioDeviceDescription
}

extension AudioObjectID {
  fileprivate static var system: AudioObjectID { AudioObjectID(kAudioObjectSystemObject) }

  fileprivate func read<T>(
    _ selector: AudioObjectPropertySelector,
    defaultValue: T,
    qualifierSize: UInt32 = 0,
    qualifier: UnsafeRawPointer? = nil
  ) throws -> T {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(
      self,
      &address,
      qualifierSize,
      qualifier,
      &dataSize)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read property size \(selector)", status)
    }
    var value = defaultValue
    status = withUnsafeMutablePointer(to: &value) { pointer in
      AudioObjectGetPropertyData(
        self,
        &address,
        qualifierSize,
        qualifier,
        &dataSize,
        pointer)
    }
    guard status == noErr else {
      throw CaptureError.coreAudio("Read property \(selector)", status)
    }
    return value
  }

  fileprivate func readProcessList() throws -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
      mSelector: kAudioHardwarePropertyProcessObjectList,
      mScope: kAudioObjectPropertyScopeGlobal,
      mElement: kAudioObjectPropertyElementMain)
    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read audio process list size", status)
    }
    var values = [AudioObjectID](
      repeating: kAudioObjectUnknown,
      count: Int(dataSize) / MemoryLayout<AudioObjectID>.size)
    status = AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, &values)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read audio process list", status)
    }
    return values
  }

  fileprivate func readObjectIDs(
    _ selector: AudioObjectPropertySelector,
    scope: AudioObjectPropertyScope
  ) throws -> [AudioObjectID] {
    var address = AudioObjectPropertyAddress(
      mSelector: selector,
      mScope: scope,
      mElement: kAudioObjectPropertyElementMain)
    var dataSize: UInt32 = 0
    var status = AudioObjectGetPropertyDataSize(self, &address, 0, nil, &dataSize)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read object list size \(selector)", status)
    }
    var values = [AudioObjectID](
      repeating: kAudioObjectUnknown,
      count: Int(dataSize) / MemoryLayout<AudioObjectID>.size)
    status = AudioObjectGetPropertyData(self, &address, 0, nil, &dataSize, &values)
    guard status == noErr else {
      throw CaptureError.coreAudio("Read object list \(selector)", status)
    }
    return values
  }

  fileprivate func readString(_ selector: AudioObjectPropertySelector) throws -> String {
    try read(selector, defaultValue: "" as CFString) as String
  }
}

private func processName(pid: pid_t) -> String {
  var buffer = [CChar](repeating: 0, count: Int(MAXPATHLEN))
  let count = proc_name(pid, &buffer, UInt32(buffer.count))
  guard count > 0 else { return "pid-\(pid)" }
  return String(cString: buffer)
}

private func isAppleSigned(pid: pid_t) -> Bool {
  let attributes = [kSecGuestAttributePid as String: Int(pid)] as CFDictionary
  var code: SecCode?
  guard
    SecCodeCopyGuestWithAttributes(nil, attributes, SecCSFlags(), &code) == errSecSuccess,
    let code
  else {
    return false
  }
  var requirement: SecRequirement?
  guard
    SecRequirementCreateWithString("anchor apple" as CFString, SecCSFlags(), &requirement)
      == errSecSuccess,
    let requirement,
    SecCodeCheckValidity(code, SecCSFlags(), requirement) == errSecSuccess
  else {
    return false
  }
  return true
}

private func readAudioProcesses() throws -> [AudioProcess] {
  try AudioObjectID.system.readProcessList().compactMap { objectID in
    do {
      let pid: pid_t = try objectID.read(kAudioProcessPropertyPID, defaultValue: -1)
      let running: UInt32 = try objectID.read(
        kAudioProcessPropertyIsRunningOutput,
        defaultValue: 0)
      let bundleID = (try? objectID.readString(kAudioProcessPropertyBundleID)) ?? ""
      let executableName = processName(pid: pid)
      guard isAppleSigned(pid: pid) else {
        return nil
      }
      let trustedIdentity =
        bundleID.isEmpty && executableName == "avconferenced"
        ? "com.apple.avconferenced" : bundleID
      let name =
        trustedIdentity == "com.apple.FaceTime"
        ? "FaceTime" : trustedIdentity == "com.apple.mobilephone" ? "Phone" : executableName
      return AudioProcess(
        bundleID: bundleID,
        name: name,
        objectID: objectID,
        pid: pid,
        runningOutput: running != 0,
        trustedIdentity: trustedIdentity)
    } catch {
      return nil
    }
  }
}

private func readDefaultAudioDevice(
  _ selector: AudioObjectPropertySelector
) throws -> AudioDeviceDescription {
  let device: AudioDeviceID = try AudioObjectID.system.read(
    selector,
    defaultValue: AudioDeviceID(kAudioObjectUnknown))
  let objectClass: AudioClassID = try device.read(
    kAudioObjectPropertyClass,
    defaultValue: AudioClassID(0))
  return AudioDeviceDescription(
    isAggregate: objectClass == kAudioAggregateDeviceClassID,
    name: try device.readString(kAudioObjectPropertyName),
    uid: try device.readString(kAudioDevicePropertyDeviceUID))
}

private func readDefaultAudioDevices() throws -> DefaultAudioDevices {
  try DefaultAudioDevices(
    input: readDefaultAudioDevice(kAudioHardwarePropertyDefaultInputDevice),
    output: readDefaultAudioDevice(kAudioHardwarePropertyDefaultOutputDevice))
}

private func inputDeviceNames(_ process: AudioProcess) throws -> [String] {
  let inputDevices = try process.objectID.readObjectIDs(
    kAudioProcessPropertyDevices,
    scope: kAudioObjectPropertyScopeInput)
  return try inputDevices.compactMap { device in
    // The process device list can include its output-only speaker even under
    // input scope during a FaceTime handoff. Only a device with input streams
    // can source microphone audio, so output-only devices are safe to ignore.
    let inputStreams = try device.readObjectIDs(
      kAudioDevicePropertyStreams,
      scope: kAudioDevicePropertyScopeInput)
    guard !inputStreams.isEmpty else {
      return nil
    }
    return try device.readString(kAudioObjectPropertyName)
  }
}

private func outputRouteDevices(_ process: AudioProcess) throws -> [OpenClawOutputRouteDevice] {
  let outputDevices = try process.objectID.readObjectIDs(
    kAudioProcessPropertyDevices,
    scope: kAudioObjectPropertyScopeOutput)
  return try outputDevices.map { device in
    let name = try device.readString(kAudioObjectPropertyName)
    let objectClass: AudioClassID = try device.read(
      kAudioObjectPropertyClass,
      defaultValue: AudioClassID(0))
    let transport: UInt32 = try device.read(
      kAudioDevicePropertyTransportType,
      defaultValue: UInt32(0))
    let physical = objectClass != kAudioAggregateDeviceClassID
      && transport != kAudioDeviceTransportTypeVirtual
      && !name.localizedCaseInsensitiveContains("BlackHole")
      && !name.hasPrefix("OpenClaw-")
    return OpenClawOutputRouteDevice(name: name, physical: physical)
  }
}

private func requireExpectedActiveOwner(
  _ expected: AudioProcess,
  requestedNames: Set<String>
) throws {
  let current = try resolveActiveOwner(requestedNames: requestedNames)
  guard current.pid == expected.pid, current.objectID == expected.objectID else {
    throw CaptureError.audioOwnerChanged("\(current.name) pid=\(current.pid)")
  }
}

private func selectActiveOwner(_ active: [AudioProcess]) -> AudioProcess? {
  if active.count == 1 {
    return active[0]
  }
  let mediaOwners = active.filter { $0.trustedIdentity == "com.apple.avconferenced" }
  if mediaOwners.count == 1 {
    // FaceTime and Phone are UI companions for the same call while
    // avconferenced owns its media. Prefer the media process instead of
    // treating the normal companion pair as two unrelated calls.
    return mediaOwners[0]
  }
  return nil
}

private func resolveActiveOwner(requestedNames: Set<String>) throws -> AudioProcess {
  let active = try readAudioProcesses().filter {
    $0.runningOutput
      && requestedNames.contains($0.name.lowercased())
      && allowedSigningIdentifiers.contains($0.trustedIdentity)
  }
  guard let selected = selectActiveOwner(active) else {
    let description = active.isEmpty
      ? "none" : active.map { "\($0.name) pid=\($0.pid)" }.joined(separator: ", ")
    throw CaptureError.audioOwnerChanged(description)
  }
  return selected
}

private func waitForActiveOwner(
  requestedNames: Set<String>,
  processNames: [String],
  timeout: Duration
) async throws -> AudioProcess {
  let deadline = ContinuousClock.now + timeout
  var active: [AudioProcess] = []
  while ContinuousClock.now < deadline {
    active = try readAudioProcesses().filter {
      $0.runningOutput
        && requestedNames.contains($0.name.lowercased())
        && allowedSigningIdentifiers.contains($0.trustedIdentity)
    }
    if let selected = selectActiveOwner(active) {
      return selected
    }
    // FaceTime and avconferenced briefly overlap while an answered call moves
    // to its steady audio owner. Wait through that handoff, but retain the
    // fail-closed ambiguity check if more than one owner remains active.
    try await Task.sleep(for: .milliseconds(100))
  }
  if active.count > 1 {
    throw CaptureError.ambiguousAudioOwners(
      active.map { "\($0.name) pid=\($0.pid)" })
  }
  throw CaptureError.audioProcessNotFound(processNames)
}

private func waitForOpenClawRoutes(
  _ process: AudioProcess,
  requestedNames: Set<String>,
  phase: OpenClawInputRoutePhase
) async throws {
  let deadline = ContinuousClock.now + .seconds(10)
  var inputNames: [String] = []
  var outputDecision = OpenClawOutputRouteDecision.retry
  while ContinuousClock.now < deadline {
    try requireExpectedActiveOwner(process, requestedNames: requestedNames)
    outputDecision = decideOpenClawOutputRoute(try outputRouteDevices(process))
    switch outputDecision {
    case .ready, .retry:
      break
    case .fail(let names):
      throw CaptureError.outputRouteMismatch(
        "\(process.name) pid=\(process.pid)", names)
    }
    inputNames = (try? inputDeviceNames(process)) ?? []
    switch decideOpenClawInputRoute(inputNames, phase: phase) {
    case .ready:
      if outputDecision == .ready {
        return
      }
    case .retry:
      break
    case .fail(let failedNames):
      throw CaptureError.inputRouteMismatch(
        "\(process.name) pid=\(process.pid)", failedNames)
    }
    try await Task.sleep(for: .milliseconds(100))
  }
  if outputDecision == .retry {
    throw CaptureError.outputRouteMismatch("\(process.name) pid=\(process.pid)", [])
  }
  throw CaptureError.inputRouteMismatch(
    "\(process.name) pid=\(process.pid)", inputNames)
}

private final class ConverterInput: @unchecked Sendable {
  var buffer: AVAudioPCMBuffer?

  init(_ buffer: AVAudioPCMBuffer) {
    self.buffer = buffer
  }
}

private final class PCMWriter: @unchecked Sendable {
  private static let slotCount = 8
  private static let slotFrames: AVAudioFrameCount = 8192
  private let targetFormat = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: outputSampleRate,
    channels: 1,
    interleaved: true)!
  private let sourceFormat: AVAudioFormat
  private let converter: AVAudioConverter
  private let slots: [AVAudioPCMBuffer]
  private let available = DispatchSemaphore(value: PCMWriter.slotCount)
  private let pendingLock = NSLock()
  private let worker = DispatchQueue(label: "ai.openclaw.facetime-capture-writer")
  private let pending = FixedSlotRing(capacity: PCMWriter.slotCount)
  private var nextSlot = 0
  private let onFailure: @Sendable (Error) -> Void
  private lazy var workerSignal: DispatchSourceUserDataAdd = {
    let source = DispatchSource.makeUserDataAddSource(queue: self.worker)
    source.setEventHandler { [weak self] in self?.drainPending() }
    source.resume()
    return source
  }()

  init(
    streamDescription: AudioStreamBasicDescription,
    onFailure: @escaping @Sendable (Error) -> Void
  ) throws {
    var description = streamDescription
    guard let sourceFormat = AVAudioFormat(streamDescription: &description),
      let converter = AVAudioConverter(from: sourceFormat, to: self.targetFormat)
    else {
      throw CaptureError.invalidAudioFormat
    }
    self.sourceFormat = sourceFormat
    self.converter = converter
    self.onFailure = onFailure
    self.slots = try (0..<Self.slotCount).map { _ in
      guard let buffer = AVAudioPCMBuffer(
        pcmFormat: sourceFormat,
        frameCapacity: Self.slotFrames)
      else { throw CaptureError.invalidAudioFormat }
      return buffer
    }
    _ = self.workerSignal
  }

  func enqueue(_ audioBufferList: UnsafePointer<AudioBufferList>) -> Bool {
    guard self.available.wait(timeout: .now()) == .success, self.pendingLock.try() else {
      return false
    }
    let slotIndex = self.nextSlot
    self.nextSlot = (self.nextSlot + 1) % Self.slotCount
    let source = UnsafeMutableAudioBufferListPointer(
      UnsafeMutablePointer(mutating: audioBufferList))
    let target = UnsafeMutableAudioBufferListPointer(self.slots[slotIndex].mutableAudioBufferList)
    guard source.count == target.count else {
      self.pendingLock.unlock()
      self.available.signal()
      return false
    }
    let bytesPerFrame = max(Int(self.sourceFormat.streamDescription.pointee.mBytesPerFrame), 1)
    var frameLength = Int.max
    for index in 0..<source.count {
      let byteCount = Int(source[index].mDataByteSize)
      guard byteCount <= Int(target[index].mDataByteSize),
        let sourceData = source[index].mData,
        let targetData = target[index].mData
      else {
        self.pendingLock.unlock()
        self.available.signal()
        return false
      }
      memcpy(targetData, sourceData, byteCount)
      target[index].mDataByteSize = UInt32(byteCount)
      frameLength = min(frameLength, byteCount / bytesPerFrame)
    }
    guard frameLength >= 0, frameLength <= Int(Self.slotFrames) else {
      self.pendingLock.unlock()
      self.available.signal()
      return false
    }
    self.slots[slotIndex].frameLength = AVAudioFrameCount(frameLength)
    guard self.pending.append(slotIndex) else {
      self.pendingLock.unlock()
      self.available.signal()
      return false
    }
    self.pendingLock.unlock()
    self.workerSignal.add(data: 1)
    return true
  }

  private func drainPending() {
    while true {
      self.pendingLock.lock()
      guard let slotIndex = self.pending.removeFirst() else {
        self.pendingLock.unlock()
        return
      }
      self.pendingLock.unlock()
      do {
        try self.convertAndWrite(self.slots[slotIndex])
      } catch {
        self.onFailure(error)
      }
      self.available.signal()
    }
  }

  private func convertAndWrite(_ sourceBuffer: AVAudioPCMBuffer) throws {
    let ratio = self.targetFormat.sampleRate / self.sourceFormat.sampleRate
    let capacity = AVAudioFrameCount(ceil(Double(sourceBuffer.frameLength) * ratio)) + 1
    guard
      let outputBuffer = AVAudioPCMBuffer(
        pcmFormat: self.targetFormat,
        frameCapacity: capacity)
    else {
      throw CaptureError.invalidAudioFormat
    }

    let input = ConverterInput(sourceBuffer)
    var conversionError: NSError?
    let status = self.converter.convert(to: outputBuffer, error: &conversionError) { _, status in
      guard let buffer = input.buffer else {
        status.pointee = .noDataNow
        return nil
      }
      input.buffer = nil
      status.pointee = .haveData
      return buffer
    }
    if status == .error {
      throw CaptureError.conversionFailed(
        conversionError?.localizedDescription ?? "unknown converter error")
    }
    guard outputBuffer.frameLength > 0,
      let samples = outputBuffer.int16ChannelData?[0]
    else {
      return
    }
    let byteCount = Int(outputBuffer.frameLength) * MemoryLayout<Int16>.size
    FileHandle.standardOutput.write(Data(bytes: samples, count: byteCount))
  }
}

private final class CaptureLifecycle: @unchecked Sendable {
  private let lock = NSLock()
  private let failureQueue = DispatchQueue(label: "ai.openclaw.facetime-capture-failure")
  private var failure: Error?
  private var stopping = false
  private lazy var captureOverflowSignal: DispatchSourceUserDataAdd = {
    let source = DispatchSource.makeUserDataAddSource(queue: self.failureQueue)
    source.setEventHandler { [weak self] in
      _ = self?.fail(captureQueueOverflowError)
    }
    source.resume()
    return source
  }()

  init() {
    _ = self.captureOverflowSignal
  }

  func fail(_ error: Error) -> Bool {
    self.lock.lock()
    defer { self.lock.unlock() }
    guard self.failure == nil else { return false }
    self.failure = error
    return true
  }

  func signalCaptureOverflow() {
    self.captureOverflowSignal.add(data: 1)
  }

  func requestStop() {
    self.lock.lock()
    self.stopping = true
    self.lock.unlock()
  }

  func state() -> (failure: Error?, stopping: Bool) {
    self.lock.lock()
    defer { self.lock.unlock() }
    return (self.failure, self.stopping)
  }
}

private func audioDevice(named expectedName: String) throws -> AudioDeviceID {
  let devices = try AudioObjectID.system.readObjectIDs(
    kAudioHardwarePropertyDevices,
    scope: kAudioObjectPropertyScopeGlobal)
  guard let device = try devices.first(where: {
    try $0.readString(kAudioObjectPropertyName) == expectedName
  }) else {
    throw CaptureError.outputRouteMismatch("native playback", [expectedName])
  }
  return device
}

private final class CarrierOwnerRef: @unchecked Sendable {
  private let lock = NSLock()
  private var owner: AudioProcess

  init(_ owner: AudioProcess) {
    self.owner = owner
  }

  func update(_ owner: AudioProcess) {
    self.lock.lock()
    self.owner = owner
    self.lock.unlock()
  }

  func terminateIfCurrent(requestedNames: Set<String>) {
    self.lock.lock()
    let expected = self.owner
    self.lock.unlock()
    guard
      let current = try? resolveActiveOwner(requestedNames: requestedNames),
      current.pid == expected.pid,
      current.objectID == expected.objectID,
      current.trustedIdentity == expected.trustedIdentity
    else {
      return
    }
    _ = Darwin.kill(current.pid, SIGTERM)
    for _ in 0..<10 {
      if Darwin.kill(current.pid, 0) != 0 {
        return
      }
      usleep(50_000)
    }
    _ = Darwin.kill(current.pid, SIGKILL)
  }
}

private final class NativePlayback: @unchecked Sendable {
  private struct DrainMarker {
    let generation: UInt32
    let targetFrames: UInt64
  }

  private let engine = AVAudioEngine()
  private let player = AVAudioPlayerNode()
  private let queue = DispatchQueue(label: "ai.openclaw.facetime-playback-owner")
  private let format = AVAudioFormat(
    commonFormat: .pcmFormatInt16,
    sampleRate: outputSampleRate,
    channels: 1,
    interleaved: true)!
  private var generation: UInt32 = 1
  private var scheduledFrames: UInt64 = 0
  private var playedFrames: UInt64 = 0
  private var markers: [DrainMarker] = []

  init() throws {
    self.engine.attach(self.player)
    self.engine.connect(self.player, to: self.engine.mainMixerNode, format: self.format)
    var deviceID = try audioDevice(named: "OpenClaw-Feed")
    guard let outputUnit = self.engine.outputNode.audioUnit else {
      throw CaptureError.invalidAudioFormat
    }
    let status = AudioUnitSetProperty(
      outputUnit,
      kAudioOutputUnitProperty_CurrentDevice,
      kAudioUnitScope_Global,
      0,
      &deviceID,
      UInt32(MemoryLayout<AudioDeviceID>.size))
    guard status == noErr else {
      throw CaptureError.coreAudio("Select OpenClaw-Feed output", status)
    }
    try self.engine.start()
    self.player.play()
  }

  private func emit(_ event: String, generation: UInt32, frames: UInt64, message: String? = nil) {
    var payload: [String: Any] = [
      "event": event,
      "generation": generation,
      "frames": frames,
    ]
    if let message {
      payload["message"] = message
    }
    guard let data = try? JSONSerialization.data(withJSONObject: payload),
      let line = String(data: data, encoding: .utf8)
    else {
      return
    }
    FileHandle.standardError.write(Data("facetime-control:\(line)\n".utf8))
  }

  func enqueue(_ data: Data) {
    self.queue.async { [self, data] in
      guard data.count > 0, data.count % MemoryLayout<Int16>.size == 0 else {
        self.emit("overflow", generation: self.generation, frames: self.playedFrames,
                  message: "invalid native playback frame")
        return
      }
      let frames = AVAudioFrameCount(data.count / MemoryLayout<Int16>.size)
      let outstanding = self.scheduledFrames - self.playedFrames
      if outstanding + UInt64(frames) > 1_048_576 {
        self.emit("overflow", generation: self.generation, frames: self.playedFrames,
                  message: "native playback ring overflow")
        return
      }
      guard let buffer = AVAudioPCMBuffer(pcmFormat: self.format, frameCapacity: frames),
        let samples = buffer.int16ChannelData?[0]
      else {
        self.emit("overflow", generation: self.generation, frames: self.playedFrames,
                  message: "native playback allocation failed")
        return
      }
      _ = data.copyBytes(to: UnsafeMutableBufferPointer(start: samples, count: Int(frames)))
      buffer.frameLength = frames
      let ownedGeneration = self.generation
      self.scheduledFrames += UInt64(frames)
      self.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
        self?.complete(frames: UInt64(frames), generation: ownedGeneration)
      }
    }
  }

  private func complete(frames: UInt64, generation: UInt32) {
    self.queue.async {
      guard generation == self.generation else { return }
      self.playedFrames += frames
      self.emit("played", generation: generation, frames: self.playedFrames)
      let drained = self.markers.filter { $0.generation == generation && $0.targetFrames <= self.playedFrames }
      self.markers.removeAll { $0.generation == generation && $0.targetFrames <= self.playedFrames }
      for marker in drained {
        self.emit("drained", generation: marker.generation, frames: self.playedFrames)
      }
    }
  }

  func markDrain(generation: UInt32) {
    self.queue.async {
      guard generation == self.generation else { return }
      let marker = DrainMarker(generation: generation, targetFrames: self.scheduledFrames)
      if marker.targetFrames <= self.playedFrames {
        self.emit("drained", generation: generation, frames: self.playedFrames)
      } else {
        self.markers.append(marker)
      }
    }
  }

  func clear(generation: UInt32) {
    self.queue.sync {
      guard generation > self.generation else { return }
      self.generation = generation
      self.player.stop()
      self.scheduledFrames = 0
      self.playedFrames = 0
      self.markers.removeAll()
      self.player.play()
    }
  }

  func stop() {
    self.queue.sync {
      self.generation &+= 1
      self.player.stop()
      self.engine.stop()
      self.markers.removeAll()
    }
  }
}

private final class ParentCommandReader: @unchecked Sendable {
  private let playback: NativePlayback
  private let unexpectedEOF: () -> Void
  private var closeSafe = false

  init(playback: NativePlayback, unexpectedEOF: @escaping () -> Void) {
    self.playback = playback
    self.unexpectedEOF = unexpectedEOF
  }

  func start() {
    DispatchQueue.global(qos: .userInitiated).async {
      var buffered = Data()
      while true {
        let chunk = FileHandle.standardInput.availableData
        if chunk.isEmpty {
          if !self.closeSafe {
            self.unexpectedEOF()
          }
          return
        }
        buffered.append(chunk)
        while buffered.count >= 5 {
          let type = buffered[buffered.startIndex]
          let length = buffered.dropFirst().prefix(4).reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
          guard length <= 256 * 1024 else {
            self.unexpectedEOF()
            return
          }
          let frameLength = 5 + Int(length)
          guard buffered.count >= frameLength else { break }
          let payload = buffered.subdata(in: 5..<frameLength)
          buffered.removeSubrange(0..<frameLength)
          if type == 1 {
            self.playback.enqueue(payload)
          } else if payload.count == 4 {
            let generation = payload.reduce(UInt32(0)) { ($0 << 8) | UInt32($1) }
            if type == 2 {
              self.playback.markDrain(generation: generation)
            } else if type == 3 {
              self.playback.clear(generation: generation)
            } else if type == 4 {
              self.closeSafe = true
            }
          }
        }
        if buffered.count > 256 * 1024 + 5 {
          self.unexpectedEOF()
          return
        }
      }
    }
  }
}

private final class ProcessTap: @unchecked Sendable {
  private var aggregateDeviceID = AudioObjectID(kAudioObjectUnknown)
  private var ioProcID: AudioDeviceIOProcID?
  private var tapID = AudioObjectID(kAudioObjectUnknown)
  private let tapDescription: CATapDescription
  private let writer: PCMWriter
  private let lifecycle: CaptureLifecycle

  init(processObjectIDs: [AudioObjectID], lifecycle: CaptureLifecycle) throws {
    self.lifecycle = lifecycle
    self.tapDescription = CATapDescription(stereoMixdownOfProcesses: processObjectIDs)
    self.tapDescription.uuid = UUID()
    // Capture the call owner while suppressing only that process at hardware.
    // This remains effective across default-output and volume changes.
    self.tapDescription.muteBehavior = .muted

    var createdTapID = AudioObjectID(kAudioObjectUnknown)
    var status = AudioHardwareCreateProcessTap(self.tapDescription, &createdTapID)
    guard status == noErr else {
      throw CaptureError.coreAudio("Create FaceTime process tap", status)
    }
    self.tapID = createdTapID
    fputs("facetime-audio-capture: created FaceTime process tap\n", stderr)

    let streamDescription: AudioStreamBasicDescription = try createdTapID.read(
      kAudioTapPropertyFormat,
      defaultValue: AudioStreamBasicDescription())
    self.writer = try PCMWriter(streamDescription: streamDescription) { [lifecycle] error in
      if lifecycle.fail(error) {
        fputs("facetime-audio-capture: fatal: \(error.localizedDescription)\n", stderr)
      }
    }

    // Keep hardware subdevices out of this aggregate. A duplex headset would
    // add unrelated input buffers to the callback, which is tap-format-only.
    let aggregateDescription: [String: Any] = [
      kAudioAggregateDeviceNameKey: "OpenClaw FaceTime Capture",
      kAudioAggregateDeviceUIDKey: "ai.openclaw.facetime-capture.\(UUID().uuidString)",
      kAudioAggregateDeviceIsPrivateKey: true,
      kAudioAggregateDeviceIsStackedKey: false,
      kAudioAggregateDeviceTapAutoStartKey: true,
      kAudioAggregateDeviceTapListKey: [
        [
          kAudioSubTapDriftCompensationKey: true,
          kAudioSubTapUIDKey: self.tapDescription.uuid.uuidString,
        ]
      ],
    ]
    status = AudioHardwareCreateAggregateDevice(
      aggregateDescription as CFDictionary,
      &self.aggregateDeviceID)
    guard status == noErr else {
      self.stop()
      throw CaptureError.coreAudio("Create private aggregate tap device", status)
    }
    fputs("facetime-audio-capture: created private aggregate tap device\n", stderr)
  }

  func start() throws {
    let queue = DispatchQueue(label: "ai.openclaw.facetime-core-audio-tap")
    var createdIOProcID: AudioDeviceIOProcID?
    var status = AudioDeviceCreateIOProcIDWithBlock(
      &createdIOProcID,
      self.aggregateDeviceID,
      queue
    ) { [writer = self.writer, lifecycle = self.lifecycle] _, inputData, _, _, _ in
      if !writer.enqueue(inputData) {
        lifecycle.signalCaptureOverflow()
      }
    }
    guard status == noErr, let createdIOProcID else {
      throw CaptureError.coreAudio("Create tap I/O callback", status)
    }
    self.ioProcID = createdIOProcID
    status = AudioDeviceStart(self.aggregateDeviceID, createdIOProcID)
    guard status == noErr else {
      throw CaptureError.coreAudio("Start FaceTime process tap", status)
    }
    fputs("facetime-audio-capture: started FaceTime process tap\n", stderr)
  }

  func stop() {
    if self.aggregateDeviceID != kAudioObjectUnknown {
      if let ioProcID = self.ioProcID {
        _ = AudioDeviceStop(self.aggregateDeviceID, ioProcID)
        _ = AudioDeviceDestroyIOProcID(self.aggregateDeviceID, ioProcID)
        self.ioProcID = nil
      }
      _ = AudioHardwareDestroyAggregateDevice(self.aggregateDeviceID)
      self.aggregateDeviceID = kAudioObjectUnknown
    }
    if self.tapID != kAudioObjectUnknown {
      _ = AudioHardwareDestroyProcessTap(self.tapID)
      self.tapID = kAudioObjectUnknown
    }
  }

  deinit {
    self.stop()
  }
}

private func waitForTerminationSignal(
  _ lifecycle: CaptureLifecycle,
  process: AudioProcess,
  requestedNames: Set<String>,
  taps initialTaps: [ProcessTap],
  ownerRef: CarrierOwnerRef
) async throws {
  signal(SIGINT, SIG_IGN)
  signal(SIGTERM, SIG_IGN)
  let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .main)
  let terminate = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .main)
  interrupt.setEventHandler { lifecycle.requestStop() }
  terminate.setEventHandler { lifecycle.requestStop() }
  interrupt.resume()
  terminate.resume()
  defer {
    interrupt.cancel()
    terminate.cancel()
  }
  var currentProcess = process
  var taps = initialTaps
  var reportedFailure = false
  defer {
    for tap in taps {
      tap.stop()
    }
  }
  var nextRouteCheck = ContinuousClock.now
  while true {
    let state = lifecycle.state()
    if state.stopping {
      return
    }
    if let failure = state.failure, !reportedFailure {
      reportedFailure = true
      fputs("facetime-audio-capture: fatal-safety-retained: \(failure.localizedDescription)\n", stderr)
    }
    if state.failure == nil && ContinuousClock.now >= nextRouteCheck {
      do {
        let activeProcess: AudioProcess
        do {
          activeProcess = try resolveActiveOwner(requestedNames: requestedNames)
        } catch CaptureError.audioOwnerChanged {
          // FaceTime can briefly stop both candidate processes while moving
          // the live call between FaceTime and avconferenced. Retain the
          // existing muted tap while the legitimate owner settles.
          activeProcess = try await waitForActiveOwner(
            requestedNames: requestedNames,
            processNames: requestedNames.sorted(),
            timeout: .seconds(3))
        }
        if activeProcess.pid != currentProcess.pid
          || activeProcess.objectID != currentProcess.objectID
        {
          // Start the replacement tap before releasing any prior tap so a
          // legitimate Apple audio-owner handoff has no audible gap.
          let replacement = try ProcessTap(
            processObjectIDs: [activeProcess.objectID], lifecycle: lifecycle)
          try replacement.start()
          taps.append(replacement)
          try await waitForOpenClawRoutes(
            activeProcess,
            requestedNames: requestedNames,
            phase: .steadyState)
          // The new owner is fully routed before the prior muted tap is
          // released, so handoff is gapless without retaining stale capture.
          for obsoleteTap in taps.dropLast() {
            obsoleteTap.stop()
          }
          taps = [replacement]
          currentProcess = activeProcess
          ownerRef.update(activeProcess)
          fputs(
            "facetime-audio-capture: rebound process tap to \(activeProcess.name) pid=\(activeProcess.pid)\n",
            stderr)
        }
        let outputDecision = decideOpenClawOutputRoute(try outputRouteDevices(currentProcess))
        switch outputDecision {
        case .ready, .retry:
          break
        case .fail(let names):
          throw CaptureError.outputRouteMismatch(
            "\(currentProcess.name) pid=\(currentProcess.pid)", names)
        }
        let inputNames = (try? inputDeviceNames(currentProcess)) ?? []
        let inputDecision = decideOpenClawInputRoute(inputNames, phase: .steadyState)
        switch inputDecision {
        case .ready:
          break
        case .retry:
          break
        case .fail(let names):
          throw CaptureError.inputRouteMismatch(
            "\(currentProcess.name) pid=\(currentProcess.pid)", names)
        }
        if inputDecision == .retry || outputDecision == .retry {
          // Applying transmission state can briefly clear either process
          // device list. Retain the muted tap while both expected routes return.
          try await waitForOpenClawRoutes(
            currentProcess,
            requestedNames: requestedNames,
            phase: .steadyState)
        }
      } catch {
        if lifecycle.fail(error) {
          fputs("facetime-audio-capture: fatal-safety-retained: \(error.localizedDescription)\n", stderr)
        }
      }
      nextRouteCheck = ContinuousClock.now + .milliseconds(250)
    }
    try await Task.sleep(for: .milliseconds(50))
  }
}

@main
private struct FaceTimeAudioCapture {
  static func main() async {
    do {
      let arguments = try Arguments.parse(Array(CommandLine.arguments.dropFirst()))
      guard
        let usageDescription = Bundle.main.object(
          forInfoDictionaryKey: "NSAudioCaptureUsageDescription") as? String,
        !usageDescription.isEmpty
      else {
        throw CaptureError.usageDescriptionMissing
      }
      if arguments.listDefaultDevices {
        let data = try JSONEncoder().encode(readDefaultAudioDevices())
        FileHandle.standardOutput.write(data)
        FileHandle.standardOutput.write(Data("\n".utf8))
        return
      }
      let processes = try readAudioProcesses()
      if arguments.listProcesses {
        for process in processes.sorted(by: { $0.name < $1.name }) {
          let inputs = (try? inputDeviceNames(process))?.joined(separator: ",") ?? "unavailable"
          fputs(
            "\(process.name)\tpid=\(process.pid)\toutput=\(process.runningOutput ? "active" : "idle")\tinputs=\(inputs)\tbundle=\(process.bundleID)\ttrusted=\(process.trustedIdentity)\n",
            stderr)
        }
        return
      }
      let requestedNames = Set(arguments.processNames.map { $0.lowercased() })
      let authorized = processes.filter {
        requestedNames.contains($0.name.lowercased())
          && allowedSigningIdentifiers.contains($0.trustedIdentity)
      }
      let selected: [AudioProcess]
      if arguments.checkOnly {
        let active = authorized.filter(\.runningOutput)
        if let activeOwner = selectActiveOwner(active) {
          selected = [activeOwner]
        } else if active.count > 1 {
          throw CaptureError.ambiguousAudioOwners(
            active.map { "\($0.name) pid=\($0.pid)" })
        } else if let idle = authorized.first {
          selected = [idle]
        } else {
          throw CaptureError.audioProcessNotFound(arguments.processNames)
        }
      } else {
        selected = [
          try await waitForActiveOwner(
            requestedNames: requestedNames,
            processNames: arguments.processNames,
            // The parent gives capture startup 10 seconds; leave room to
            // construct and start the process tap after the owner settles.
            timeout: .seconds(8))
        ]
      }
      let selectedDescription = selected.map { "\($0.name) (pid \($0.pid))" }.joined(
        separator: ", ")
      let lifecycle = CaptureLifecycle()
      let tap = try ProcessTap(
        processObjectIDs: selected.map(\.objectID), lifecycle: lifecycle)
      var taps = [tap]
      defer {
        for tap in taps {
          tap.stop()
        }
      }
      try tap.start()
      if arguments.checkOnly {
        try await Task.sleep(for: .milliseconds(250))
        fputs(
          "facetime-audio-capture: ready; tapped audio owner(s): \(selectedDescription)\n",
          stderr)
        return
      }
      var currentProcess = selected[0]
      let ownerRef = CarrierOwnerRef(currentProcess)
      let playback = try NativePlayback()
      defer { playback.stop() }
      let parentCommands = ParentCommandReader(playback: playback) {
        ownerRef.terminateIfCurrent(requestedNames: requestedNames)
        lifecycle.requestStop()
      }
      parentCommands.start()
      while true {
        do {
          try await waitForOpenClawRoutes(
            currentProcess,
            requestedNames: requestedNames,
            phase: .initialReadiness)
          if taps.count > 1, let activeTap = taps.last {
            for obsoleteTap in taps.dropLast() {
              obsoleteTap.stop()
            }
            taps = [activeTap]
          }
          break
        } catch CaptureError.audioOwnerChanged {
          do {
            currentProcess = try await waitForActiveOwner(
              requestedNames: requestedNames,
              processNames: arguments.processNames,
              timeout: .seconds(3))
            ownerRef.update(currentProcess)
            let replacement = try ProcessTap(
              processObjectIDs: [currentProcess.objectID], lifecycle: lifecycle)
            try replacement.start()
            taps.append(replacement)
          } catch {
            if lifecycle.fail(error) {
              fputs(
                "facetime-audio-capture: fatal-safety-retained: \(error.localizedDescription)\n",
                stderr)
            }
            try await waitForTerminationSignal(
              lifecycle,
              process: currentProcess,
              requestedNames: requestedNames,
              taps: taps,
              ownerRef: ownerRef)
            return
          }
        } catch {
          if lifecycle.fail(error) {
            fputs(
              "facetime-audio-capture: fatal-safety-retained: \(error.localizedDescription)\n",
              stderr)
          }
          try await waitForTerminationSignal(
            lifecycle,
            process: currentProcess,
            requestedNames: requestedNames,
            taps: taps,
            ownerRef: ownerRef)
          return
        }
      }
      fputs(
        "facetime-audio-capture: verified OpenClaw-Mic input route\n",
        stderr)
      fputs(
        "facetime-audio-capture: tapping \(currentProcess.name) (pid \(currentProcess.pid)) as 24 kHz mono PCM16\n",
        stderr)
      try await waitForTerminationSignal(
        lifecycle,
        process: currentProcess,
        requestedNames: requestedNames,
        taps: taps,
        ownerRef: ownerRef)
    } catch {
      fputs("facetime-audio-capture: \(error.localizedDescription)\n", stderr)
      exit(1)
    }
  }
}
