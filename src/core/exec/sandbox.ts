// Command sandboxing.
//
// Until now `exec` ran with the full authority of the user: an agent-proposed
// command could rewrite anything on the machine. This confines it — on macOS via
// seatbelt (`sandbox-exec`), the same mechanism Codex uses — so a command can
// read the system but only WRITE inside the workspace (plus scratch space), and
// optionally cannot reach the network at all.
//
// Pure module: builds the policy and the argv. The actual spawn lives in the
// main process, so the policy can be tested against real processes.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { randomUUID } from 'node:crypto';

export type SandboxMode = 'off' | 'workspaceWrite';

export interface SandboxOptions {
  mode: SandboxMode;
  /** Absolute, ALREADY REAL (symlink-resolved) paths the command may write to. */
  writableRoots: string[];
  allowNetwork: boolean;
  /** Allow hdiutil to create, attach, and detach disk images on macOS. */
  allowDiskImages?: boolean;
}

/** Seatbelt exists on macOS only; elsewhere commands run unconfined. */
export function sandboxAvailable(platform: string = process.platform): boolean {
  return platform === 'darwin';
}

/**
 * Character devices that shell redirection and ordinary tooling write to. Denying
 * these makes almost every real command fail (`cmd > /dev/null` is everywhere),
 * so they are re-allowed explicitly.
 */
const DEV_WRITE_LITERALS = ['/dev/null', '/dev/zero', '/dev/stdout', '/dev/stderr', '/dev/tty'];

/**
 * Build a seatbelt policy: allow by default (so reads and process execution keep
 * working), then subtract write access and — when asked — the network.
 *
 * A deny-by-default policy would be tighter but breaks essentially every build
 * tool, which in practice means users turn the sandbox off; this is the same
 * trade-off Codex makes.
 */
export function buildSeatbeltProfile(opts: {
  writableRoots: string[];
  allowNetwork: boolean;
  allowDiskImages?: boolean;
}): string {
  const roots = opts.writableRoots
    .filter((p) => typeof p === 'string' && p.startsWith('/'))
    // A trailing slash makes seatbelt's subpath match nothing.
    .map((p) => p.replace(/\/+$/, ''))
    .filter(Boolean);

  const lines: string[] = ['(version 1)', '(allow default)', '', '; --- writes ---', '(deny file-write*)'];

  if (roots.length) {
    lines.push('(allow file-write*');
    for (const root of roots) lines.push(`  (subpath ${quote(root)})`);
    lines.push(')');
  }

  // Redirection targets and the fd/pty families tools allocate.
  lines.push('(allow file-write-data');
  for (const dev of DEV_WRITE_LITERALS) lines.push(`  (literal ${quote(dev)})`);
  lines.push(')');
  lines.push('(allow file-write* (regex #"^/dev/fd/[0-9]+$"))');
  lines.push('(allow file-write* (regex #"^/dev/tty[a-z0-9]*$"))');
  lines.push('(allow file-write* (regex #"^/dev/ptmx$") (regex #"^/dev/pty[a-z0-9]*$"))');
  if (opts.allowDiskImages) {
    // hdiutil and its APFS helpers use these devices while creating or mounting
    // an image. Keep the exception opt-in: ordinary commands must not access raw
    // disk devices.
    lines.push('(allow file-write* (regex #"^/dev/(r?disk[0-9]+.*|dtracehelper)$"))');
  }
  lines.push('(allow file-ioctl)');

  if (!opts.allowNetwork) {
    lines.push('', '; --- network ---', '(deny network*)');
  }

  return lines.join('\n');
}

/** Seatbelt profiles are s-expressions: escape for a double-quoted string. */
function quote(value: string): string {
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
}

/**
 * The argv that runs `command` under the sandbox. The profile is passed as one
 * argv element (never interpolated into a shell string), and the command itself
 * is handed to `/bin/sh -c` so pipes and redirection still work.
 *
 * Returns null when the sandbox is off or unavailable — the caller then runs the
 * command directly and should tell the user it is unconfined.
 */
export function buildSandboxArgv(
  command: string,
  opts: SandboxOptions,
  platform: string = process.platform,
): { file: string; args: string[] } | null {
  if (opts.mode === 'off' || !sandboxAvailable(platform)) return null;
  const profile = buildSeatbeltProfile({
    writableRoots: opts.writableRoots,
    allowNetwork: opts.allowNetwork,
    allowDiskImages: opts.allowDiskImages,
  });
  return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', command] };
}

/** Single-quote for /bin/sh so a command with quotes or spaces survives intact. */
export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * The shell command that runs `command` under a policy already written to
 * `profilePath`.
 *
 * A file rather than an inline `-p` profile: the caller runs commands through a
 * shell (for pipes and redirection), and a multi-line s-expression full of quotes
 * does not survive that safely.
 */
export function buildSandboxShellCommand(command: string, profilePath: string): string {
  return `/usr/bin/sandbox-exec -f ${shellQuote(profilePath)} /bin/sh -c ${shellQuote(command)}`;
}

/**
 * The whole decision, in one place: resolve the writable roots, write the policy,
 * and return the command to run plus whether it ended up confined.
 *
 * Lives here rather than in the main process so the real behaviour — including
 * the symlink resolution that silently breaks seatbelt when skipped — is covered
 * by tests against real processes.
 */
export function resolveSandboxCommand(opts: {
  command: string;
  cwd?: string;
  request?: {
    mode: SandboxMode;
    allowNetwork?: boolean;
    extraWritableRoots?: string[];
    allowDiskImages?: boolean;
  };
  /** Directory to write the policy file into (the app's userData in production). */
  profileDir: string;
  platform?: string;
}): { command: string; sandboxed: boolean } {
  const { command, cwd, request, profileDir } = opts;
  if (!request || request.mode === 'off' || !sandboxAvailable(opts.platform)) {
    return { command, sandboxed: false };
  }

  // Seatbelt matches REAL paths: on macOS /tmp is a symlink to /private/tmp, and
  // an unresolved subpath matches nothing — which would deny writes to the very
  // directory the command is supposed to work in.
  try {
    // Keep temporary writes in an app-owned directory instead of granting every
    // process write access to the whole system temp tree. TMPDIR is overridden
    // for the command so npm, node and similar tools still have a usable temp
    // area without widening the policy to unrelated applications' temp files.
    const scratchRoot = path.join(profileDir, 'sandbox-tmp');
    fs.mkdirSync(scratchRoot, { recursive: true, mode: 0o700 });
    const commandScratch = fs.mkdtempSync(path.join(scratchRoot, 'run-'));
    const roots = [cwd, commandScratch, ...(request.extraWritableRoots || [])]
      .map(realPathOrNull)
      .filter((p): p is string => !!p);

    if (!roots.length) return { command, sandboxed: false };

    const profile = buildSeatbeltProfile({
      writableRoots: roots,
      allowNetwork: request.allowNetwork !== false,
      allowDiskImages: request.allowDiskImages === true,
    });
    fs.mkdirSync(profileDir, { recursive: true });
    // A unique file prevents concurrent exec calls from replacing each other's
    // policy while their shells are still running.
    const profilePath = path.join(profileDir, `sandbox-${randomUUID()}.sb`);
    fs.writeFileSync(profilePath, profile, { encoding: 'utf-8', mode: 0o600 });
    const wrapped = buildSandboxShellCommand(command, profilePath);
    // The caller runs this through the login shell. Prefixing TMPDIR inside the
    // command keeps the environment scoped to this invocation and avoids an
    // IPC/API change just for sandbox metadata. The EXIT trap removes both
    // per-run files after sandbox-exec exits, including ordinary command errors.
    const tmpPrefix = `TMPDIR=${shellQuote(commandScratch)}; export TMPDIR; `;
    const cleanup = `trap 'rm -f ${shellQuote(profilePath)}; rm -rf ${shellQuote(commandScratch)}' EXIT; `;
    return { command: `${tmpPrefix}${cleanup}${wrapped}`, sandboxed: true };
  } catch {
    // A sandbox problem must never block the command outright; run it unconfined
    // and let the caller report that it was not confined.
    return { command, sandboxed: false };
  }
}

function realPathOrNull(p?: string | null): string | null {
  if (!p) return null;
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}

/**
 * A sandbox denial surfaces as a generic "Operation not permitted", which looks
 * like a broken command rather than a policy decision. Detect it so the agent
 * (and the user) are told what actually happened and how to proceed.
 */
export function looksLikeSandboxDenial(output: string): boolean {
  if (!output) return false;
  return /operation not permitted|sandbox-exec|deny file-write|not permitted by sandbox/i.test(output);
}

export const SANDBOX_DENIAL_HINT =
  'This command was blocked by the sandbox, which only allows writes inside the workspace' +
  ' (and no network access when that is disabled). Disk-image commands also need the' +
  ' explicit allowDiskImages permission. If the command legitimately needs wider access,' +
  ' tell the user what it needs and why — do not try to work around the sandbox.';
