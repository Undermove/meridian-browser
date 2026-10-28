// Prints the on-screen windows of a process as JSON lines: {"layer", "x", "y", "w", "h"}.
// Used by tests to see native bubbles and dialogs (no Screen Recording permission needed:
// only bounds and owner, never titles or pixels).
import CoreGraphics
import Foundation

let pid = Int32(CommandLine.arguments[1])!
let list = CGWindowListCopyWindowInfo([.optionAll], kCGNullWindowID) as! [[String: Any]]
for w in list where (w[kCGWindowIsOnscreen as String] as? Bool ?? false) && (w[kCGWindowOwnerPID as String] as? Int32) == pid {
  let b = w[kCGWindowBounds as String] as! [String: Double]
  let layer = w[kCGWindowLayer as String] as! Int
  print("{\"layer\":\(layer),\"x\":\(Int(b["X"]!)),\"y\":\(Int(b["Y"]!)),\"w\":\(Int(b["Width"]!)),\"h\":\(Int(b["Height"]!))}")
}
