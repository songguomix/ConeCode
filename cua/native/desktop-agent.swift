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
    let windowId = int(req, "windowId", 0)
    var args = ["-x", "-t", "png"]
    var logicalWidth = 0.0
    var logicalHeight = 0.0
    var originX = 0.0
    var originY = 0.0
    var scale = 1.0
    if windowId > 0 {
        guard let record = windowRecords(onScreenOnly: false).first(where: { $0.windowId == windowId }) else {
            return fail(id, "TARGET_NOT_FOUND", "window \(windowId) is no longer available")
        }
        // -o drops the window shadow. With the shadow the captured pixels no
        // longer start at the window frame, which would shift every coordinate.
        args.append(contentsOf: ["-o", "-l", String(windowId)])
        logicalWidth = Double(record.bounds.width)
        logicalHeight = Double(record.bounds.height)
        originX = Double(record.bounds.origin.x)
        originY = Double(record.bounds.origin.y)
        scale = record.scale
    } else {
        args.append(contentsOf: ["-m", "-C"])
        let screen = NSScreen.main
        logicalWidth = Double(screen?.frame.width ?? 0)
        logicalHeight = Double(screen?.frame.height ?? 0)
        scale = Double(screen?.backingScaleFactor ?? 1)
    }
    if logicalWidth <= 0 || logicalHeight <= 0 {
        return fail(id, "DRIVER", "could not determine the capture area")
    }
    args.append(path)
    let process = Process()
    process.executableURL = URL(fileURLWithPath: "/usr/sbin/screencapture")
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
    return ok(id, [
        "path": path,
        "width": width.intValue,
        "height": height.intValue,
        "logicalWidth": logicalWidth,
        "logicalHeight": logicalHeight,
        "scaleX": Double(width.intValue) / logicalWidth,
        "scaleY": Double(height.intValue) / logicalHeight,
        "scale": scale,
        "windowId": windowId,
        "origin": ["x": originX, "y": originY],
        "screenRecording": screenAccess(),
    ])
}

// ---------------------------------------------------------------------------
// Window and accessibility-tree observation for single-app computer use.
// ---------------------------------------------------------------------------

struct WindowRecord {
    let windowId: Int
    let pid: Int
    let appName: String
    let bundleId: String
    /// Bundle display name without .app, e.g. "TextEdit" on a Chinese system
    /// where the window owner name is localised ("文本编辑").
    let bundleName: String
    let title: String
    let bounds: CGRect
    let scale: Double
}

func screenFor(rect: CGRect) -> NSScreen? {
    let center = CGPoint(x: rect.midX, y: rect.midY)
    return NSScreen.screens.first { $0.frame.contains(center) } ?? NSScreen.main
}

/// Layer-0 windows in front-to-back order. Callers pick exactly one.
func windowRecords(onScreenOnly: Bool) -> [WindowRecord] {
    var options: CGWindowListOption = [.excludeDesktopElements]
    if onScreenOnly { options.insert(.optionOnScreenOnly) }
    guard let raw = CGWindowListCopyWindowInfo(options, kCGNullWindowID) as? [[String: Any]] else { return [] }
    var seen = Set<Int>()
    var records: [WindowRecord] = []
    for entry in raw {
        guard let number = (entry[kCGWindowNumber as String] as? NSNumber)?.intValue else { continue }
        let layer = (entry[kCGWindowLayer as String] as? NSNumber)?.intValue ?? -1
        if layer != 0 { continue }
        let pid = (entry[kCGWindowOwnerPID as String] as? NSNumber)?.intValue ?? -1
        if pid <= 0 || seen.contains(number) { continue }
        var bounds = CGRect.zero
        if let dict = entry[kCGWindowBounds as String] as? NSDictionary,
           let parsed = CGRect(dictionaryRepresentation: dict as CFDictionary) {
            bounds = parsed
        }
        if bounds.width < 1 || bounds.height < 1 { continue }
        seen.insert(number)
        let appName = entry[kCGWindowOwnerName as String] as? String ?? ""
        let running = NSRunningApplication(processIdentifier: pid_t(pid))
        let bundleId = running?.bundleIdentifier ?? ""
        let bundleName = running?.bundleURL?.deletingPathExtension().lastPathComponent ?? ""
        let title = entry[kCGWindowName as String] as? String ?? ""
        let scale = Double(screenFor(rect: bounds)?.backingScaleFactor ?? 1)
        records.append(WindowRecord(
            windowId: number,
            pid: pid,
            appName: appName,
            bundleId: bundleId,
            bundleName: bundleName,
            title: title,
            bounds: bounds,
            scale: scale
        ))
    }
    return records
}

func windows(_ id: String, _ req: [String: Any]) -> [String: Any] {
    let pid = int(req, "pid", 0)
    let appFilter = string(req, "appName").lowercased()
    let bundleFilter = string(req, "bundleId").lowercased()
    let limit = max(1, min(200, int(req, "limit", 60)))
    var list: [[String: Any]] = []
    for record in windowRecords(onScreenOnly: true) {
        if pid > 0 && record.pid != pid { continue }
        let name = record.appName.lowercased()
        let bundle = record.bundleId.lowercased()
        let bundleName = record.bundleName.lowercased()
        if !appFilter.isEmpty && !name.contains(appFilter) && !bundle.contains(appFilter) && !bundleName.contains(appFilter) { continue }
        if !bundleFilter.isEmpty && !bundle.contains(bundleFilter) && !name.contains(bundleFilter) && !bundleName.contains(bundleFilter) { continue }
        if list.count >= limit { break }
        list.append([
            "windowId": record.windowId,
            "pid": record.pid,
            "appName": record.appName,
            "bundleId": record.bundleId,
            "bundleName": record.bundleName,
            "title": record.title,
            "bounds": [
                "x": Double(record.bounds.origin.x),
                "y": Double(record.bounds.origin.y),
                "width": Double(record.bounds.size.width),
                "height": Double(record.bounds.size.height),
            ],
            "scale": record.scale,
        ])
    }
    return ok(id, ["count": list.count, "windows": list])
}

func axAttributes(_ element: AXUIElement, _ names: [String]) -> [String: Any] {
    var values: CFArray?
    let status = AXUIElementCopyMultipleAttributeValues(
        element,
        names as CFArray,
        AXCopyMultipleAttributeOptions(rawValue: 0),
        &values
    )
    guard status == .success, let array = values as? [Any] else { return [:] }
    var result: [String: Any] = [:]
    for (index, value) in array.enumerated() where index < names.count {
        if let text = value as? String {
            result[names[index]] = text
        } else if let number = value as? NSNumber {
            result[names[index]] = number
        }
    }
    return result
}

func axAttribute(_ element: AXUIElement, _ name: String) -> String {
    guard let value = axAttributes(element, [name])[name] as? String else { return "" }
    return value
}

func axFrame(_ element: AXUIElement) -> CGRect? {
    var positionRef: CFTypeRef?
    var sizeRef: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXPositionAttribute as CFString, &positionRef) == .success,
          AXUIElementCopyAttributeValue(element, kAXSizeAttribute as CFString, &sizeRef) == .success,
          let positionValue = positionRef, let sizeValue = sizeRef,
          CFGetTypeID(positionValue) == AXValueGetTypeID(),
          CFGetTypeID(sizeValue) == AXValueGetTypeID() else { return nil }
    var origin = CGPoint.zero
    var size = CGSize.zero
    guard AXValueGetValue(unsafeBitCast(positionValue, to: AXValue.self), .cgPoint, &origin),
          AXValueGetValue(unsafeBitCast(sizeValue, to: AXValue.self), .cgSize, &size) else { return nil }
    return CGRect(origin: origin, size: size)
}

func axChildren(_ element: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(element, kAXChildrenAttribute as CFString, &value) == .success,
          let children = value as? [AXUIElement] else { return [] }
    return children
}

func axWindows(_ application: AXUIElement) -> [AXUIElement] {
    var value: CFTypeRef?
    guard AXUIElementCopyAttributeValue(application, kAXWindowsAttribute as CFString, &value) == .success,
          let windows = value as? [AXUIElement] else { return [] }
    return windows
}

func axActions(_ element: AXUIElement) -> [String] {
    var names: CFArray?
    guard AXUIElementCopyActionNames(element, &names) == .success, let list = names as? [String] else { return [] }
    return list
}

func axElement(_ application: AXUIElement, path: String) -> AXUIElement? {
    if path.isEmpty { return application }
    var current = application
    for part in path.split(separator: "/") {
        guard let index = Int(part) else { return nil }
        let children = axChildren(current)
        guard index >= 0 && index < children.count else { return nil }
        current = children[index]
    }
    return current
}

func axTree(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !accessibilityTrusted() {
        return fail(id, "PERMISSION", "Accessibility permission is missing; the app accessibility tree cannot be read.")
    }
    let pid = int(req, "pid", 0)
    if pid <= 0 { return fail(id, "PROTOCOL", "ax_tree requires pid") }
    let maxDepth = max(1, min(20, int(req, "maxDepth", 10)))
    let maxNodes = max(1, min(2_000, int(req, "maxNodes", 320)))
    // When the caller scopes to one window, do not even walk other windows of
    // the same app or its menu bar: the tree stays about the scoped interface.
    let wantedFrame = (req["bounds"] as? [String: Any]).flatMap { rectFrom($0) }
    func windowMatches(_ element: AXUIElement) -> Bool {
        guard let wanted = wantedFrame, let frame = axFrame(element) else { return wantedFrame == nil }
        return abs(frame.origin.x - wanted.origin.x) <= 8 &&
            abs(frame.origin.y - wanted.origin.y) <= 8 &&
            abs(frame.size.width - wanted.size.width) <= 8 &&
            abs(frame.size.height - wanted.size.height) <= 8
    }
    let names = [
        kAXRoleAttribute as String,
        kAXSubroleAttribute as String,
        kAXTitleAttribute as String,
        kAXValueAttribute as String,
        kAXDescriptionAttribute as String,
        kAXIdentifierAttribute as String,
        kAXEnabledAttribute as String,
        kAXFocusedAttribute as String,
        kAXSelectedAttribute as String,
    ]
    let application = AXUIElementCreateApplication(pid_t(pid))
    var nodes: [[String: Any]] = []
    var truncated = false
    func walk(_ element: AXUIElement, _ path: String, _ depth: Int) {
        if nodes.count >= maxNodes { truncated = true; return }
        let values = axAttributes(element, names)
        var node: [String: Any] = ["path": path, "depth": depth]
        node["role"] = (values[kAXRoleAttribute as String] as? String).map { String($0.prefix(200)) } ?? ""
        if let subrole = values[kAXSubroleAttribute as String] as? String, !subrole.isEmpty {
            node["subrole"] = String(subrole.prefix(200))
        }
        if let identifier = values[kAXIdentifierAttribute as String] as? String, !identifier.isEmpty {
            node["identifier"] = String(identifier.prefix(200))
        }
        if let title = values[kAXTitleAttribute as String] as? String, !title.isEmpty {
            node["title"] = String(title.prefix(200))
        }
        if let description = values[kAXDescriptionAttribute as String] as? String, !description.isEmpty {
            node["description"] = String(description.prefix(200))
        }
        if let value = values[kAXValueAttribute as String] as? String, !value.isEmpty {
            node["value"] = String(value.prefix(200))
        }
        if let enabled = values[kAXEnabledAttribute as String] as? NSNumber {
            node["enabled"] = enabled.boolValue
        }
        if let focused = values[kAXFocusedAttribute as String] as? NSNumber {
            node["focused"] = focused.boolValue
        }
        if let selected = values[kAXSelectedAttribute as String] as? NSNumber {
            node["selected"] = selected.boolValue
        }
        if let frame = axFrame(element) {
            node["x"] = Double(frame.origin.x)
            node["y"] = Double(frame.origin.y)
            node["width"] = Double(frame.size.width)
            node["height"] = Double(frame.size.height)
        }
        let actions = axActions(element)
        if !actions.isEmpty { node["actions"] = actions }
        nodes.append(node)
        guard depth < maxDepth else { return }
        let children = axChildren(element)
        for (index, child) in children.enumerated() {
            let childPath = path.isEmpty ? String(index) : "\(path)/\(index)"
            if depth == 0 {
                let role = axAttribute(child, kAXRoleAttribute as String)
                if role == (kAXMenuBarRole as String) { continue }
                if role == "AXMenuBar" || role == "AXWindow" || role == "AXSheet" || role == "AXDialog" {
                    if !windowMatches(child) { continue }
                }
            }
            walk(child, childPath, depth + 1)
            if nodes.count >= maxNodes { truncated = true; break }
        }
    }
    walk(application, "", 0)
    return ok(id, ["pid": pid, "count": nodes.count, "truncated": truncated, "nodes": nodes])
}

func axPress(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !accessibilityTrusted() {
        return fail(id, "PERMISSION", "Accessibility permission is missing; no accessibility action was performed.")
    }
    let pid = int(req, "pid", 0)
    if pid <= 0 { return fail(id, "PROTOCOL", "ax_press requires pid") }
    let application = AXUIElementCreateApplication(pid_t(pid))
    var target: AXUIElement?
    let path = string(req, "path")
    if !path.isEmpty {
        guard let resolved = axElement(application, path: path) else {
            return fail(id, "TARGET_NOT_FOUND", "accessibility element \(path) is gone; observe the app again")
        }
        target = resolved
    } else if req["x"] != nil && req["y"] != nil {
        var hit: AXUIElement?
        let status = AXUIElementCopyElementAtPosition(application, Float(double(req, "x")), Float(double(req, "y")), &hit)
        guard status == .success, let resolved = hit else {
            return fail(id, "TARGET_NOT_FOUND", "no accessibility element at that point")
        }
        target = resolved
    } else {
        return fail(id, "PROTOCOL", "ax_press requires path or x/y")
    }
    guard let element = target else { return fail(id, "TARGET_NOT_FOUND", "element could not be resolved") }
    let actions = axActions(element)
    guard let action = [kAXPressAction as String, "AXConfirm", "AXOpen"].first(where: { actions.contains($0) }) else {
        return fail(id, "ACTION_UNSUPPORTED", "element exposes no press-like action (actions: \(actions.joined(separator: ",")))")
    }
    let status = AXUIElementPerformAction(element, action as CFString)
    guard status == .success else {
        return fail(id, "ACTION", "AX action \(action) failed with code \(status.rawValue)")
    }
    let values = axAttributes(element, [
        kAXRoleAttribute as String,
        kAXTitleAttribute as String,
        kAXDescriptionAttribute as String,
        kAXValueAttribute as String,
    ])
    var result: [String: Any] = ["performed": action]
    if let role = values[kAXRoleAttribute as String] as? String, !role.isEmpty { result["role"] = String(role.prefix(200)) }
    if let title = values[kAXTitleAttribute as String] as? String, !title.isEmpty { result["title"] = String(title.prefix(200)) }
    if let description = values[kAXDescriptionAttribute as String] as? String, !description.isEmpty {
        result["description"] = String(description.prefix(200))
    }
    if let value = values[kAXValueAttribute as String] as? String, !value.isEmpty { result["value"] = String(value.prefix(200)) }
    return ok(id, result)
}

func axSetValue(_ id: String, _ req: [String: Any]) -> [String: Any] {
    if !accessibilityTrusted() {
        return fail(id, "PERMISSION", "Accessibility permission is missing; no value was written.")
    }
    let pid = int(req, "pid", 0)
    let path = string(req, "path")
    if pid <= 0 || path.isEmpty { return fail(id, "PROTOCOL", "ax_set_value requires pid and path") }
    let application = AXUIElementCreateApplication(pid_t(pid))
    guard let target = axElement(application, path: path) else {
        return fail(id, "TARGET_NOT_FOUND", "accessibility element \(path) is gone; observe the app again")
    }
    var settable = DarwinBoolean(false)
    let settableStatus = AXUIElementIsAttributeSettable(target, kAXValueAttribute as CFString, &settable)
    guard settableStatus == .success, settable.boolValue else {
        return fail(id, "ACTION_UNSUPPORTED", "element does not accept accessibility value writes")
    }
    let text = string(req, "value")
    let status = AXUIElementSetAttributeValue(target, kAXValueAttribute as CFString, text as CFString)
    guard status == .success else {
        return fail(id, "ACTION", "AX value write failed with code \(status.rawValue)")
    }
    let after = axAttribute(target, kAXValueAttribute as String)
    return ok(id, ["value": after, "matches": after == text])
}

func rectFrom(_ dict: [String: Any]) -> CGRect? {
    func number(_ key: String) -> Double? {
        if let value = dict[key] as? NSNumber { return value.doubleValue }
        if let value = dict[key] as? Double { return value }
        if let value = dict[key] as? Int { return Double(value) }
        return nil
    }
    guard let x = number("x"), let y = number("y"),
          let width = number("width"), let height = number("height") else { return nil }
    return CGRect(x: x, y: y, width: width, height: height)
}

/// Bring one app (and, when a frame is supplied, one of its windows) to the
/// front so a scoped input action reaches the window it was planned against.
func activate(_ id: String, _ req: [String: Any]) -> [String: Any] {
    let pid = int(req, "pid", 0)
    if pid <= 0 { return fail(id, "PROTOCOL", "activate requires pid") }
    guard let app = NSRunningApplication(processIdentifier: pid_t(pid)) else {
        return fail(id, "TARGET_NOT_FOUND", "process \(pid) is not running")
    }
    var raised = false
    var matchedTitle = ""
    if accessibilityTrusted(), let dict = req["bounds"] as? [String: Any], let wanted = rectFrom(dict) {
        let application = AXUIElementCreateApplication(pid_t(pid))
        for window in axWindows(application) {
            guard let frame = axFrame(window) else { continue }
            let close = abs(frame.origin.x - wanted.origin.x) <= 2 &&
                abs(frame.origin.y - wanted.origin.y) <= 2 &&
                abs(frame.size.width - wanted.size.width) <= 2 &&
                abs(frame.size.height - wanted.size.height) <= 2
            if close {
                raised = AXUIElementPerformAction(window, kAXRaiseAction as CFString) == .success
                matchedTitle = axAttribute(window, kAXTitleAttribute as String)
                break
            }
        }
    }
    let activated = app.activate(options: [.activateAllWindows])
    var frontmost = false
    for _ in 0..<12 {
        if NSWorkspace.shared.frontmostApplication?.processIdentifier == pid_t(pid) {
            frontmost = true
            break
        }
        usleep(50_000)
    }
    return ok(id, [
        "pid": pid,
        "activated": activated,
        "raised": raised,
        "frontmost": frontmost,
        "title": matchedTitle,
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
    case "windows": response = windows(id, request)
    case "activate": response = activate(id, request)
    case "ax_tree": response = axTree(id, request)
    case "ax_press": response = axPress(id, request)
    case "ax_set_value": response = axSetValue(id, request)
    case "panic": response = panic(id)
    default: response = fail(id, "PROTOCOL", "unknown op \(op)")
    }
    emit(response)
}
