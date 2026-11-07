import AppKit
import ApplicationServices
import CoreGraphics
import Foundation
import ImageIO

// A small JSON-lines executor for the macOS desktop driver. It is deliberately
// dumb: coordinate conversion, authorization and logging live in TypeScript.
// The helper reports permission denial instead of pretending input succeeded.

func emit(_ object: [String: Any]) {
    guard let data = try? JSONSerialization.data(withJSONObject: object, options: []),
          let line = String(data: data, encoding: .utf8) else {
        print("{\"ok\":false,\"error\":\"serialization failure\"}")
        fflush(stdout)
        return
    }
    print(line)
    fflush(stdout)
}

func fail(_ id: String, _ code: String, _ message: String) -> [String: Any] {
    return ["id": id, "ok": false, "code": code, "error": message]
}

func ok(_ id: String, _ result: [String: Any]) -> [String: Any] {
    return ["id": id, "ok": true, "result": result]
}

func double(_ req: [String: Any], _ key: String, _ fallback: Double = 0) -> Double {
    if let n = req[key] as? NSNumber { return n.doubleValue }
    return fallback
}

func int(_ req: [String: Any], _ key: String, _ fallback: Int = 0) -> Int {
    if let n = req[key] as? NSNumber { return n.intValue }
    return fallback
}

func string(_ req: [String: Any], _ key: String, _ fallback: String = "") -> String {
    return (req[key] as? String) ?? fallback
}

func accessibilityTrusted() -> Bool {
    return AXIsProcessTrusted()
}

func eventAccess() -> Bool {
    if #available(macOS 10.15, *) {
        return CGPreflightPostEventAccess()
    }
    return accessibilityTrusted()
}

func screenAccess() -> Bool {
    if #available(macOS 10.15, *) {
        return CGPreflightScreenCaptureAccess()
    }
    return true
}

func screenInfo() -> [[String: Any]] {
    return NSScreen.screens.enumerated().map { index, screen in
        let frame = screen.frame
        return [
            "displayId": String(index),
            "x": frame.origin.x,
            "y": frame.origin.y,
            "width": frame.size.width,
            "height": frame.size.height,
            "scale": screen.backingScaleFactor,
            "name": screen.localizedName,
        ]
    }
}

func frontmostInfo() -> [String: Any] {
    var result: [String: Any] = [:]
    if let app = NSWorkspace.shared.frontmostApplication {
        result["appName"] = app.localizedName ?? ""
        result["bundleId"] = app.bundleIdentifier ?? ""
        result["pid"] = Int(app.processIdentifier)
    }
    let options: CGWindowListOption = [.optionOnScreenOnly, .excludeDesktopElements]
    if let windows = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]],
       let app = NSWorkspace.shared.frontmostApplication {
        let pid = Int(app.processIdentifier)
        let matches = windows.filter { window in
            let owner = (window[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? -1
            let layer = (window[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
            return owner == pid && layer == 0
        }
        if let first = matches.first {
            result["windowTitle"] = first[kCGWindowName as String] as? String ?? ""
            result["windowId"] = (first[kCGWindowNumber as String] as? NSNumber)?.intValue ?? 0
            if let bounds = first[kCGWindowBounds as String] as? [String: Any] {
                result["windowBounds"] = bounds
            }
        }
    }
    return result
}

func status(_ id: String) -> [String: Any] {
    return ok(id, [
        "platform": "darwin",
        "accessibility": accessibilityTrusted(),
        "eventAccess": eventAccess(),
        "screenRecording": screenAccess(),
        "screens": screenInfo(),
        "frontmost": frontmostInfo(),
        "macOS": ProcessInfo.processInfo.operatingSystemVersionString,
    ])
}

func screenshot(_ id: String, _ req: [String: Any]) -> [String: Any] {
    let path = string(req, "path")
    if path.isEmpty { return fail(id, "PROTOCOL", "screenshot requires path") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
    var args = ["-x", "-m", "-C", "-t", "png"]
    if let windowId = req["windowId"] as? NSNumber {
        args.append(contentsOf: ["-l", String(windowId.intValue)])
    }
    args.append(path)
    process.arguments = args
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return fail(id, "DRIVER", "screencapture failed: \(error.localizedDescription)")
    }
    if process.terminationStatus != 0 {
        return fail(id, "PERMISSION", "screencapture exited with \(process.terminationStatus); Screen Recording permission may be missing")
    }
    guard let source = CGImageSourceCreateWithURL(URL(fileURLWithPath: path) as CFURL, nil),
          let props = CGImageSourceCopyPropertiesAtIndex(source, 0, nil) as? [String: Any],
          let width = props[kCGImagePropertyPixelWidth as String] as? NSNumber,
          let height = props[kCGImagePropertyPixelHeight as String] as? NSNumber else {
        return fail(id, "DRIVER", "could not read screenshot dimensions")
    }
    let screen = NSScreen.main
    let logicalWidth = screen?.frame.width ?? 0
    let logicalHeight = screen?.frame.height ?? 0
    return ok(id, [
        "path": path,
        "width": width.intValue,
        "height": height.intValue,
        "logicalWidth": logicalWidth,
        "logicalHeight": logicalHeight,
        "scaleX": logicalWidth > 0 ? Double(width.intValue) / logicalWidth : 1,
        "scaleY": logicalHeight > 0 ? Double(height.intValue) / logicalHeight : 1,
        "scale": screen?.backingScaleFactor ?? 1,
        "screenRecording": screenAccess(),
    ])
}

enum MouseButton {
    case left, right, middle
    var down: CGEventType {
        switch self {
        case .left: return .leftMouseDown
        case .right: return .rightMouseDown
        case .middle: return .otherMouseDown
        }
    }
    var up: CGEventType {
        switch self {
        case .left: return .leftMouseUp
        case .right: return .rightMouseUp
        case .middle: return .otherMouseUp
        }
    }
    var cg: CGMouseButton {
        switch self {
        case .left: return .left
        case .right: return .right
        case .middle: return .center
        }
    }
}

func mouseButton(_ req: [String: Any]) -> MouseButton {
    switch string(req, "button", "left") {
    case "right": return .right
    case "middle": return .middle
    default: return .left
    }
}

func moveMouse(to point: CGPoint) {
    let event = CGEvent(mouseEventSource: nil, mouseType: .mouseMoved, mouseCursorPosition: point, mouseButton: .left)
    event?.post(tap: .cghidEventTap)
}

func clickEvent(at point: CGPoint, button: MouseButton, count: Int64) {
    let down = CGEvent(mouseEventSource: nil, mouseType: button.down, mouseCursorPosition: point, mouseButton: button.cg)
    let up = CGEvent(mouseEventSource: nil, mouseType: button.up, mouseCursorPosition: point, mouseButton: button.cg)
    down?.setIntegerValueField(.mouseEventClickState, value: count)
    up?.setIntegerValueField(.mouseEventClickState, value: count)
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
}

func click(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !eventAccess() {
        return fail(id, "PERMISSION", "Accessibility/Input Monitoring permission is missing; synthetic clicks are silently discarded by macOS. Ask the user to grant Accessibility permission and restart the driver.")
    }
    let point = CGPoint(x: double(req, "x"), y: double(req, "y"))
    let button = mouseButton(req)
    let count = max(1, int(req, "count", 1))
    moveMouse(to: point)
    usleep(30_000)
    for index in 0..<count {
        clickEvent(at: point, button: button, count: Int64(index + 1))
        usleep(60_000)
    }
    let after = CGEvent(source: nil)?.location ?? .zero
    let moved = abs(after.x - point.x) < 2 && abs(after.y - point.y) < 2
    if !moved {
        return fail(id, "PERMISSION", "The cursor did not move to the requested point; macOS suppressed the synthetic event (Accessibility permission).")
    }
    return ok(id, ["x": point.x, "y": point.y, "count": count, "cursor": ["x": after.x, "y": after.y]])
}

func move(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !eventAccess() {
        return fail(id, "PERMISSION", "Accessibility/Input Monitoring permission is missing.")
    }
    let point = CGPoint(x: double(req, "x"), y: double(req, "y"))
    moveMouse(to: point)
    usleep(30_000)
    let after = CGEvent(source: nil)?.location ?? .zero
    let moved = abs(after.x - point.x) < 2 && abs(after.y - point.y) < 2
    return moved ? ok(id, ["cursor": ["x": after.x, "y": after.y]]) : fail(id, "PERMISSION", "Synthetic pointer move was suppressed by macOS.")
}

func drag(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !eventAccess() {
        return fail(id, "PERMISSION", "Accessibility/Input Monitoring permission is missing.")
    }
    let start = CGPoint(x: double(req, "fromX"), y: double(req, "fromY"))
    let end = CGPoint(x: double(req, "toX"), y: double(req, "toY"))
    let steps = 24
    moveMouse(to: start)
    usleep(40_000)
    let down = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDown, mouseCursorPosition: start, mouseButton: .left)
    down?.post(tap: .cghidEventTap)
    for i in 1...steps {
        let t = Double(i) / Double(steps)
        let p = CGPoint(x: start.x + (end.x - start.x) * t, y: start.y + (end.y - start.y) * t)
        let dragged = CGEvent(mouseEventSource: nil, mouseType: .leftMouseDragged, mouseCursorPosition: p, mouseButton: .left)
        dragged?.post(tap: .cghidEventTap)
        usleep(15_000)
    }
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: end, mouseButton: .left)
    up?.post(tap: .cghidEventTap)
    return ok(id, ["from": ["x": start.x, "y": start.y], "to": ["x": end.x, "y": end.y]])
}

func scroll(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !eventAccess() {
        return fail(id, "PERMISSION", "Accessibility/Input Monitoring permission is missing.")
    }
    if let x = req["x"] as? NSNumber, let y = req["y"] as? NSNumber {
        moveMouse(to: CGPoint(x: x.doubleValue, y: y.doubleValue))
        usleep(30_000)
    }
    let amount = max(1, int(req, "amount", 3))
    let direction = string(req, "direction", "down")
    var vertical = 0
    var horizontal = 0
    switch direction {
    case "up": vertical = amount
    case "down": vertical = -amount
    case "left": horizontal = amount
    case "right": horizontal = -amount
    default: vertical = amount
    }
    let event = CGEvent(scrollWheelEvent2Source: nil, units: .line, wheelCount: 2, wheel1: Int32(vertical), wheel2: Int32(horizontal), wheel3: 0)
    event?.post(tap: .cghidEventTap)
    return ok(id, ["direction": direction, "amount": amount])
}

func key(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !eventAccess() {
        return fail(id, "PERMISSION", "Accessibility/Input Monitoring permission is missing; keystrokes are suppressed.")
    }
    let code = CGKeyCode(int(req, "keyCode", -1))
    if int(req, "keyCode", -1) < 0 {
        return fail(id, "PROTOCOL", "key requires keyCode")
    }
    let flags = CGEventFlags(rawValue: UInt64(int(req, "flags", 0)))
    let down = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: true)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: false)
    down?.flags = flags
    // Release synthetic modifiers with the key. Otherwise a subsequent Unicode
    // event constructed from the combined event state can inherit Command.
    up?.flags = []
    down?.post(tap: .cghidEventTap)
    up?.post(tap: .cghidEventTap)
    return ok(id, ["keyCode": Int(code), "flags": int(req, "flags", 0)])
}

func typeText(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !eventAccess() {
        return fail(id, "PERMISSION", "Accessibility/Input Monitoring permission is missing; typed text is suppressed.")
    }
    let text = string(req, "text")
    if text.isEmpty { return fail(id, "PROTOCOL", "type requires non-empty text") }
    let utf16 = Array(text.utf16)
    // Chunking avoids oversized event payloads and gives the target application
    // time to process IME/multi-byte input.
    var offset = 0
    while offset < utf16.count {
        var end = min(offset + 40, utf16.count)
        if end < utf16.count && utf16[end - 1] >= 0xD800 && utf16[end - 1] <= 0xDBFF { end -= 1 }
        let chunk = Array(utf16[offset..<end])
        let down = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
        down?.flags = []
        down?.keyboardSetUnicodeString(stringLength: chunk.count, unicodeString: chunk)
        down?.post(tap: .cghidEventTap)
        let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
        up?.flags = []
        up?.post(tap: .cghidEventTap)
        offset = end
        usleep(8_000)
    }
    return ok(id, ["length": utf16.count])
}

func focusApp(_ id: String, _ req: [String: Any]) -> [String: Any] {
    let name = string(req, "appName")
    if name.isEmpty { return fail(id, "PROTOCOL", "focus requires appName") }
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/bin/open")
    process.arguments = ["-a", name]
    do {
        try process.run()
        process.waitUntilExit()
    } catch {
        return fail(id, "DRIVER", "open -a failed: \(error.localizedDescription)")
    }
    if process.terminationStatus != 0 {
        return fail(id, "DRIVER", "open -a \(name) exited with \(process.terminationStatus)")
    }
    return ok(id, ["appName": name])
}

func panic(_ id: String) -> [String: Any] {
    let point = CGEvent(source: nil)?.location ?? .zero
    let up = CGEvent(mouseEventSource: nil, mouseType: .leftMouseUp, mouseCursorPosition: point, mouseButton: .left)
    up?.post(tap: .cghidEventTap)
    return ok(id, ["released": true])
}

while let line = readLine() {
    guard let data = line.data(using: .utf8),
          let request = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else {
        emit(["ok": false, "code": "PROTOCOL", "error": "invalid JSON request"])
        continue
    }
    let id = string(request, "id", "unknown")
    let op = string(request, "op")
    let response: [String: Any]
    switch op {
    case "status": response = status(id)
    case "screenshot": response = screenshot(id, request)
    case "click": response = click(id, request)
    case "move": response = move(id, request)
    case "drag": response = drag(id, request)
    case "scroll": response = scroll(id, request)
    case "key": response = key(id, request)
    case "type": response = typeText(id, request)
    case "focus": response = focusApp(id, request)
    case "panic": response = panic(id)
    default: response = fail(id, "PROTOCOL", "unknown op \(op)")
    }
    emit(response)
}
