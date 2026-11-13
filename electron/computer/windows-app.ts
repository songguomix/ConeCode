import { execFile } from 'node:child_process';
import { join } from 'node:path';
import { parseKeyCombo, WINDOWS_VKEYS, type ComputerRequest } from '../../src/core/computer/computer';
import type { NativeWindow } from './app-target';

type Point = { x: number; y: number };
type WindowsInput =
  | { kind: 'type'; text: string }
  | { kind: 'key'; virtualKey: number }
  | { kind: 'pointer'; point: Point; messages: Array<[message: number, wParam: number]>; wheel: boolean };

const POWERSHELL_BOOTSTRAP = Buffer.from(
  '$ErrorActionPreference = "Stop"; & ([ScriptBlock]::Create([Console]::In.ReadToEnd()))',
  'utf16le',
).toString('base64');

function runWindows(command: string, signal?: AbortSignal): Promise<string> {
  const systemRoot = process.env.SystemRoot;
  if (!systemRoot) throw new Error('Windows SystemRoot is unavailable.');
  const powershell = join(systemRoot, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe');
  return new Promise((resolve, reject) => {
    const child = execFile(powershell, ['-NoProfile', '-NonInteractive', '-EncodedCommand', POWERSHELL_BOOTSTRAP], {
      windowsHide: true, timeout: 20_000, maxBuffer: 48 * 1024 * 1024, signal,
    }, (error, stdout, stderr) => {
      if (error) {
        const message = signal?.aborted ? 'Windows app operation stopped.'
          : error.killed ? 'Windows app operation timed out.'
          : stderr.trim() || error.message;
        reject(Object.assign(new Error(message), { cause: error }));
      } else {
        resolve(stdout.trim());
      }
    });
    // The process may have stopped before the script finishes writing.
    child.stdin!.on('error', reject);
    child.stdin!.end(`${PRELUDE}\ntry { ${command} } catch {\n`
      + '[Console]::Error.WriteLine($_.Exception.GetBaseException().Message); exit 1\n}');
  });
}

function nativeArgs(window: NativeWindow): string {
  // Win32 HWNDs fit in the low 32 bits, including in 64-bit processes.
  if (!/^[1-9]\d{0,9}$/.test(window.id) || Number(window.id) >= 0xffffffff
      || !Number.isInteger(window.pid) || window.pid <= 0 || window.pid > 0xffffffff) {
    throw new Error('Invalid Windows app window identity.');
  }
  return `[long]${window.id}, [uint32]${window.pid}`;
}

function nativeFrame(window: NativeWindow): string {
  return `${nativeArgs(window)}, ${window.x}, ${window.y}, ${window.width}, ${window.height}`;
}

export async function listWindows(signal?: AbortSignal): Promise<NativeWindow[]> {
  return JSON.parse(await runWindows('ConvertTo-Json -InputObject ([ScopedApp]::List()) -Compress', signal));
}

export async function activateWindow(window: NativeWindow, signal?: AbortSignal): Promise<void> {
  await runWindows(`[ScopedApp]::Activate(${nativeArgs(window)})`, signal);
}

export async function captureWindow(window: NativeWindow, signal?: AbortSignal): Promise<Buffer> {
  return Buffer.from(await runWindows(`[ScopedApp]::Capture(${nativeFrame(window)})`, signal), 'base64');
}

export async function windowsCursorPoint(signal?: AbortSignal): Promise<Point> {
  return JSON.parse(await runWindows('ConvertTo-Json -InputObject ([ScopedApp]::Cursor()) -Compress', signal));
}

function pointerMessages(action: ComputerRequest['action']): Array<[number, number]> {
  switch (action) {
    case 'mouse_move': return [[0x0200, 0]];
    case 'left_click': return [[0x0201, 1], [0x0202, 0]];
    case 'right_click': return [[0x0204, 2], [0x0205, 0]];
    case 'middle_click': return [[0x0207, 16], [0x0208, 0]];
    case 'double_click': return [[0x0201, 1], [0x0202, 0], [0x0203, 1], [0x0202, 0]];
    default: throw new Error(`"${action}" is not supported in scoped Windows app input.`);
  }
}

function windowsInput(request: ComputerRequest, point?: Point): WindowsInput {
  switch (request.action) {
    case 'type': return { kind: 'type', text: request.text! };
    case 'key': {
      const combo = parseKeyCombo(request.text!);
      if (!combo || combo.modifiers.length || combo.key === 'caps_lock') {
        throw new Error('Scoped Windows app input supports unmodified app keys only.');
      }
      const virtualKey = WINDOWS_VKEYS[combo.key]
        ?? (/^[a-z0-9]$/.test(combo.key) ? combo.key.toUpperCase().charCodeAt(0) : undefined);
      if (virtualKey === undefined) throw new Error('Use the type action to enter this character on Windows.');
      return { kind: 'key', virtualKey };
    }
    case 'scroll': {
      if (!point) throw new Error('Windows app scrolling requires an explicit screenshot coordinate.');
      const direction = request.scroll_direction!;
      const horizontal = direction === 'left' || direction === 'right';
      const clicks = Math.min(50, Math.round(request.scroll_amount ?? 3));
      const delta = (direction === 'up' || direction === 'right' ? 120 : -120) * clicks;
      return { kind: 'pointer', point, wheel: true, messages: [[horizontal ? 0x020e : 0x020a, delta << 16]] };
    }
    default: {
      const messages = pointerMessages(request.action);
      if (!point) throw new Error('Windows app pointer input requires an explicit screenshot coordinate.');
      return { kind: 'pointer', point, messages, wheel: false };
    }
  }
}

export async function performWindowsAction(
  window: NativeWindow, request: ComputerRequest, point?: Point, signal?: AbortSignal,
): Promise<void> {
  const input = windowsInput(request, point);
  const frame = nativeFrame(window);
  switch (input.kind) {
    case 'type': {
      // Keep model-supplied text out of PowerShell syntax and process arguments.
      const value = Buffer.from(input.text, 'utf16le').toString('base64');
      await runWindows(`[ScopedApp]::TypeText(${frame}, [Text.Encoding]::Unicode.GetString([Convert]::FromBase64String('${value}')))`, signal);
      break;
    }
    case 'key':
      await runWindows(`[ScopedApp]::Key(${frame}, ${input.virtualKey})`, signal);
      break;
    case 'pointer': {
      const messages = input.messages.flat().join(',');
      await runWindows(`[ScopedApp]::Pointer(${frame}, ${input.point.x}, ${input.point.y}, $${input.wheel}, [int[]]@(${messages}))`, signal);
      break;
    }
  }
}

const PRELUDE = String.raw`
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
Add-Type -ReferencedAssemblies System.dll,System.Drawing.dll -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.Drawing;
using System.Drawing.Imaging;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class ScopedApp
{
    [StructLayout(LayoutKind.Sequential)] public struct Point { public int x, y; }
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int left, top, right, bottom; }
    [StructLayout(LayoutKind.Sequential)] struct GuiThreadInfo {
        public int size;
        public uint flags;
        public IntPtr active, focus, capture, menuOwner, moveSize, caret;
        public Rect caretRect;
    }
    public sealed class WindowRecord {
        public string id, name, title;
        public uint pid;
        public int x, y, width, height;
    }
    delegate bool EnumWindow(IntPtr window, IntPtr data);
    [DllImport("user32.dll", SetLastError = true)] static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")] static extern IntPtr GetWindowDpiAwarenessContext(IntPtr window);
    [DllImport("user32.dll")] static extern bool PhysicalToLogicalPointForPerMonitorDPI(IntPtr window, ref Point point);
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindow callback, IntPtr data);
    [DllImport("user32.dll")] static extern IntPtr GetShellWindow();
    [DllImport("user32.dll")] static extern IntPtr GetDesktopWindow();
    [DllImport("user32.dll")] static extern bool IsWindow(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsWindowEnabled(IntPtr window);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetAncestor(IntPtr window, uint flag);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr window, out uint pid);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr window, StringBuilder text, int length);
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr window, out uint affinity);
    [DllImport("dwmapi.dll")] static extern int DwmGetWindowAttribute(IntPtr window, int attribute, out int result, int size);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr window);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr window, IntPtr targetDc, uint flags);
    [DllImport("user32.dll")] static extern IntPtr WindowFromPoint(Point point);
    [DllImport("kernel32.dll")] static extern void SetLastError(uint error);
    [DllImport("user32.dll", SetLastError = true)]
    static extern int MapWindowPoints(IntPtr from, IntPtr to, ref Point point, uint count);
    [DllImport("user32.dll")] static extern bool GetCursorPos(out Point point);
    [DllImport("user32.dll")] static extern bool GetGUIThreadInfo(uint thread, ref GuiThreadInfo info);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint code, uint kind);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool PostMessage(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam);
    [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern IntPtr SendMessageTimeout(IntPtr window, uint message, UIntPtr wParam, IntPtr lParam,
        uint flags, uint timeout, out UIntPtr result);

    static void SetDpi() {
        // PER_MONITOR_AWARE_V2: bounds, capture pixels and hit testing use one coordinate space.
        if (SetThreadDpiAwarenessContext(new IntPtr(-4)) == IntPtr.Zero)
            throw new InvalidOperationException("Windows could not establish physical window coordinates.");
    }

    static bool Eligible(IntPtr window) {
        if (window == IntPtr.Zero || window == GetDesktopWindow() || window == GetShellWindow()
            || GetAncestor(window, 2) != window || !IsWindowVisible(window) || IsIconic(window)) return false;
        int cloaked;
        if (DwmGetWindowAttribute(window, 14, out cloaked, sizeof(int)) != 0 || cloaked != 0) return false;
        var name = new StringBuilder(256);
        GetClassName(window, name, name.Capacity);
        switch (name.ToString()) {
            case "Progman": case "WorkerW": case "Shell_TrayWnd": case "Shell_SecondaryTrayWnd":
                return false;
            default: return true;
        }
    }

    public static WindowRecord[] List() {
        SetDpi();
        var items = new List<WindowRecord>();
        if (!EnumWindows((window, _) => {
            if (!Eligible(window)) return true;
            var title = new StringBuilder(2048);
            if (GetWindowText(window, title, title.Capacity) == 0) return true;
            Rect rect;
            uint pid;
            if (!GetWindowRect(window, out rect) || rect.right <= rect.left || rect.bottom <= rect.top
                || GetWindowThreadProcessId(window, out pid) == 0) return true;
            string name;
            try {
                using (var app = Process.GetProcessById((int)pid)) name = app.ProcessName;
            } catch (ArgumentException) { return true; } // The window closed while enumerating.
            items.Add(new WindowRecord {
                id = ((uint)window.ToInt64()).ToString(), pid = pid, name = name, title = title.ToString(),
                x = rect.left, y = rect.top, width = rect.right - rect.left, height = rect.bottom - rect.top
            });
            return true;
        }, IntPtr.Zero)) throw new InvalidOperationException("Windows could not list open app windows.");
        return items.ToArray();
    }

    static IntPtr Target(long id, uint pid) {
        var window = new IntPtr(unchecked((int)id));
        uint actualPid;
        if (!Eligible(window) || GetWindowThreadProcessId(window, out actualPid) == 0 || actualPid != pid)
            throw new InvalidOperationException("The selected Windows app window is no longer available.");
        return window;
    }

    static IntPtr Frame(long id, uint pid, int x, int y, int width, int height) {
        IntPtr window = Target(id, pid);
        Rect rect;
        if (!GetWindowRect(window, out rect) || rect.left != x || rect.top != y
            || rect.right - rect.left != width || rect.bottom - rect.top != height)
            throw new InvalidOperationException("The selected app window moved or resized. Take a new screenshot.");
        return window;
    }

    static void RequireForeground(IntPtr window) {
        if (GetForegroundWindow() != window)
            throw new InvalidOperationException("The selected app window is not in the foreground. Bring it to the front and try again.");
    }

    static void BringToForeground(IntPtr window) {
        if (GetForegroundWindow() != window) SetForegroundWindow(window);
        RequireForeground(window);
    }

    public static void Activate(long id, uint pid) {
        SetDpi();
        BringToForeground(Target(id, pid));
    }

    static void RequireCapturable(IntPtr window) {
        uint affinity;
        if (GetWindowDisplayAffinity(window, out affinity) && affinity != 0)
            throw new InvalidOperationException("This app window is protected from capture.");
    }

    public static string Capture(long id, uint pid, int x, int y, int width, int height) {
        SetDpi();
        IntPtr window = Frame(id, pid, x, y, width, height);
        RequireCapturable(window);
        if ((long)width * height > 32000000)
            throw new InvalidOperationException("This app window is too large to capture. Resize the window first.");
        using (var bitmap = new Bitmap(width, height, PixelFormat.Format24bppRgb)) {
            using (var graphics = Graphics.FromImage(bitmap)) {
                IntPtr dc = graphics.GetHdc();
                try {
                    // PW_RENDERFULLCONTENT, scoped to this HWND. Never read the screen DC.
                    if (!PrintWindow(window, dc, 2))
                        throw new InvalidOperationException("Windows could not capture this app window.");
                } finally { graphics.ReleaseHdc(dc); }
            }
            RequireCapturable(Frame(id, pid, x, y, width, height));
            if (!HasPixels(bitmap))
                throw new InvalidOperationException("This app window did not provide a visible capture.");
            using (var stream = new MemoryStream()) {
                bitmap.Save(stream, ImageFormat.Png);
                return Convert.ToBase64String(stream.ToArray());
            }
        }
    }

    static bool HasPixels(Bitmap bitmap) {
        // Some accelerated/protected apps report success but never paint.
        var data = bitmap.LockBits(new Rectangle(0, 0, bitmap.Width, bitmap.Height),
            ImageLockMode.ReadOnly, PixelFormat.Format24bppRgb);
        try {
            var row = new byte[bitmap.Width * 3];
            for (int y = 0; y < bitmap.Height; ++y) {
                Marshal.Copy(IntPtr.Add(data.Scan0, y * data.Stride), row, 0, row.Length);
                for (int x = 0; x < row.Length; ++x) if (row[x] != 0) return true;
            }
            return false;
        } finally { bitmap.UnlockBits(data); }
    }

    public static Point Cursor() {
        SetDpi();
        Point point;
        if (!GetCursorPos(out point)) throw new InvalidOperationException("Windows could not read the cursor position.");
        return point;
    }

    static void RequireOwner(IntPtr root, IntPtr window, uint pid) {
        uint actualPid;
        if (!IsWindow(window) || !IsWindowEnabled(window) || !IsWindowVisible(window) || GetAncestor(window, 2) != root
            || GetWindowThreadProcessId(window, out actualPid) == 0 || actualPid != pid)
            throw new InvalidOperationException("Input is blocked because the point or focus belongs to another window.");
    }

    static IntPtr PackedPoint(Point point) {
        if (point.x < short.MinValue || point.x > short.MaxValue || point.y < short.MinValue || point.y > short.MaxValue)
            throw new InvalidOperationException("The app coordinates are outside the range Windows input messages support.");
        return new IntPtr((point.x & 65535) | (point.y << 16));
    }

    static IntPtr InputPoint(IntPtr window, Point screen, bool wheel) {
        if (!PhysicalToLogicalPointForPerMonitorDPI(window, ref screen))
            throw new InvalidOperationException("Windows could not map the point to this app's display scaling.");
        IntPtr context = SetThreadDpiAwarenessContext(GetWindowDpiAwarenessContext(window));
        if (context == IntPtr.Zero)
            throw new InvalidOperationException("Windows could not read the selected app's display scaling.");
        try {
            Point client = screen;
            SetLastError(0);
            if (MapWindowPoints(IntPtr.Zero, window, ref client, 1) == 0 && Marshal.GetLastWin32Error() != 0)
                throw new InvalidOperationException("Windows could not map the point into the app's content.");
            Rect rect;
            if (!GetClientRect(window, out rect) || client.x < 0 || client.y < 0 || client.x >= rect.right || client.y >= rect.bottom)
                throw new InvalidOperationException("Scoped input requires a point inside the app content.");
            return PackedPoint(wheel ? screen : client);
        } finally { SetThreadDpiAwarenessContext(context); }
    }

    public static void Pointer(long id, uint pid, int x, int y, int width, int height,
        int px, int py, bool wheel, int[] messages) {
        SetDpi();
        IntPtr root = Frame(id, pid, x, y, width, height);
        if (px < x || px >= x + width || py < y || py >= y + height)
            throw new InvalidOperationException("The point is outside the selected app window.");
        BringToForeground(root);
        Frame(id, pid, x, y, width, height);
        var point = new Point { x = px, y = py };
        IntPtr window = WindowFromPoint(point);
        RequireOwner(root, window, pid);
        IntPtr packed = InputPoint(window, point, wheel);
        for (int i = 0; i < messages.Length; i += 2) {
            RequireForeground(root);
            RequireOwner(root, window, pid);
            if (WindowFromPoint(point) != window)
                throw new InvalidOperationException("The target moved or was covered during the action.");
            if (InputPoint(window, point, wheel) != packed)
                throw new InvalidOperationException("The target moved during the action.");
            Send(window, (uint)messages[i], unchecked((uint)messages[i + 1]), packed);
        }
    }

    static IntPtr Focus(IntPtr root, uint pid) {
        RequireForeground(root);
        uint ignored;
        uint thread = GetWindowThreadProcessId(root, out ignored);
        var info = new GuiThreadInfo { size = Marshal.SizeOf(typeof(GuiThreadInfo)) };
        if (!GetGUIThreadInfo(thread, ref info))
            throw new InvalidOperationException("Windows could not determine the selected app's focused control.");
        RequireOwner(root, info.focus, pid);
        return info.focus;
    }

    public static void TypeText(long id, uint pid, int x, int y, int width, int height, string text) {
        SetDpi();
        IntPtr root = Frame(id, pid, x, y, width, height);
        BringToForeground(root);
        Frame(id, pid, x, y, width, height);
        IntPtr window = Focus(root, pid);
        foreach (char c in text) {
            if (Focus(root, pid) != window)
                throw new InvalidOperationException("The focused control changed while typing.");
            Send(window, 0x0102, c, new IntPtr(1)); // WM_CHAR (one UTF-16 code unit)
        }
    }

    public static void Key(long id, uint pid, int x, int y, int width, int height, uint key) {
        SetDpi();
        IntPtr root = Frame(id, pid, x, y, width, height);
        BringToForeground(root);
        Frame(id, pid, x, y, width, height);
        IntPtr window = Focus(root, pid);
        uint scan = MapVirtualKey(key, 4);
        uint data = 1 | ((scan & 255) << 16) | ((scan & 0xff00) != 0 ? 0x01000000u : 0);
        // Posted key messages go through the target's own TranslateMessage loop.
        if (!PostMessage(window, 0x0100, new UIntPtr(key), new IntPtr((int)data)) ||
            !PostMessage(window, 0x0101, new UIntPtr(key), new IntPtr(unchecked((int)(data | 0xc0000000u)))))
            throw new InvalidOperationException("Windows rejected input to the selected app's focused control.");
    }

    static void Send(IntPtr window, uint message, uint param, IntPtr data) {
        UIntPtr result;
        // SMTO_ABORTIFHUNG | SMTO_ERRORONEXIT, and no broadcast/global input.
        if (SendMessageTimeout(window, message, new UIntPtr(param), data, 0x22, 500, out result) == IntPtr.Zero)
            throw new InvalidOperationException("The selected app refused the input or did not respond.");
    }
}
'@
`.trim();
