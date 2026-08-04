import Foundation

@main
private struct FixedSlotRingChecks {
  static func main() {
    let ring = FixedSlotRing(capacity: 3)
    precondition(ring.append(1))
    precondition(ring.append(2))
    precondition(ring.append(3))
    precondition(!ring.append(4), "a full capture ring must reject instead of growing")
    precondition(ring.removeFirst() == 1)
    precondition(ring.append(4), "a released capture slot must be reusable")
    precondition(ring.removeFirst() == 2)
    precondition(ring.removeFirst() == 3)
    precondition(ring.removeFirst() == 4)
    precondition(ring.removeFirst() == nil)
  }
}
