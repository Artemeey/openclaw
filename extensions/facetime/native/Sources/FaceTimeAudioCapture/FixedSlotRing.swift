import Foundation

final class FixedSlotRing: @unchecked Sendable {
  private var storage: [Int]
  private var head = 0
  private var count = 0

  init(capacity: Int) {
    precondition(capacity > 0)
    self.storage = [Int](repeating: 0, count: capacity)
  }

  func append(_ value: Int) -> Bool {
    guard self.count < self.storage.count else { return false }
    self.storage[(self.head + self.count) % self.storage.count] = value
    self.count += 1
    return true
  }

  func removeFirst() -> Int? {
    guard self.count > 0 else { return nil }
    let value = self.storage[self.head]
    self.head = (self.head + 1) % self.storage.count
    self.count -= 1
    return value
  }
}
