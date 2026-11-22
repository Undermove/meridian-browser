// open_url <pid> <url>: what macOS sends an app when a link is clicked in another app (a GetURL
// Apple event), to exactly that process. `open -a` picks by bundle id, so with the installed
// Meridian running the link would go there.
import Foundation

// 'GURL' 'GURL': kInternetEventClass, kAEGetURL.
let kGetURL: UInt32 = 0x4755_524C

let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]) else {
  FileHandle.standardError.write("usage: open_url <pid> <url>\n".data(using: .utf8)!)
  exit(2)
}
let target = NSAppleEventDescriptor(processIdentifier: pid)
let event = NSAppleEventDescriptor(
    eventClass: kGetURL, eventID: kGetURL,
    targetDescriptor: target, returnID: -1, transactionID: 0)
event.setParam(NSAppleEventDescriptor(string: args[2]), forKeyword: 0x2D2D_2D2D)  // keyDirectObject '----'
do {
  try event.sendEvent(options: NSAppleEventDescriptor.SendOptions.noReply, timeout: 10)
} catch {
  FileHandle.standardError.write("\(error)\n".data(using: .utf8)!)
  exit(1)
}
