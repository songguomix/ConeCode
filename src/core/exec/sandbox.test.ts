import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import {
  buildSeatbeltProfile,
  buildSandboxArgv,
  buildSandboxShellCommand,
  resolveSandboxCommand,
  shellQuote,
  sandboxAvailable,
  looksLikeSandboxDenial,
} from './sandbox';

// These run REAL commands under the REAL sandbox. A policy that only passes a
// unit test is worthless — the thing that matters is whether ordinary build
// commands still work while writes outside the workspace are actually stopped.

const onMac = process.platform === 'darwin' && fs.existsSync('/usr/bin/sandbox-exec');
let canRunRealSandboxTests = onMac;
if (onMac) {
  try {
    execFileSync('/usr/bin/sandbox-exec', ['-p', '(version 1) (allow default)', '/bin/sh', '-c', 'true'], {
      stdio: 'ignore',
    });
  } catch {
    canRunRealSandboxTests = false;
  }
}

let workspace: string;
let outside: string;

// These tests run a real sandbox + shell + toolchain, and one of them creates and
// mounts a real disk image (~1.7s idle, far more on a loaded machine). Vitest's
// 5s default fired in the middle of `hdiutil attach`, which on its own is only a
// slow test — the actual flake was what happened next: nothing ever killed the
// child, so `hdiutil` kept mounting while afterAll deleted the workspace beneath
// it, producing "ENOTEMPTY: directory not empty" teardown failures and stale
// mounts. Hence: every run gets a deadline AND every child is killable.
const COMMAND_TIMEOUT_MS = 60_000;
const TEARDOWN_TIMEOUT_MS = 30_000;

// Children are spawned detached so each one leads its own process group: a
// negative-pid signal then reaches sandbox-exec, the shell AND the tool under it.
const liveChildren = new Set<ChildProcess>();

function track(child: ChildProcess): ChildProcess {
  liveChildren.add(child);
  const forget = () => liveChildren.delete(child);
  child.once('close', forget);
  child.once('error', forget);
  return child;
}

function killTree(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    liveChildren.delete(child);
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    let done = false;
    const settle = () => {
      if (done) return;
      done = true;
      liveChildren.delete(child);
      resolve();
    };
    child.once('close', settle);
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch {
      // No such group (already reaped): fall back to the process itself.
      try { child.kill('SIGKILL'); } catch { /* already gone */ }
    }
    // Teardown must not hang on a child that refuses to reap.
    setTimeout(settle, 2000).unref();
  });
}

function killEverything(): void {
  for (const child of liveChildren) {
    try {
      if (child.pid) process.kill(-child.pid, 'SIGKILL');
      else child.kill('SIGKILL');
    } catch { /* already gone */ }
  }
  liveChildren.clear();
}

// A worker killed outright never reaches afterAll; detached groups would outlive
// it, so the exit hook is the last line of defence.
process.on('exit', killEverything);

function mountPointsUnder(root: string): string[] {
  // Workspace is unset when the suite bailed out before beforeAll finished.
  if (!root) return [];
  try {
    return execFileSync('/sbin/mount', { encoding: 'utf-8' })
      .split('\n')
      .map((line) => / on (.+?) \(/.exec(line)?.[1])
      .filter((point): point is string => !!point && (point === root || point.startsWith(root + path.sep)));
  } catch {
    return [];
  }
}

async function detachMountsUnder(root: string): Promise<void> {
  for (const point of mountPointsUnder(root)) {
    for (let attempt = 0; attempt < 5; attempt++) {
      try {
        execFileSync('/usr/bin/hdiutil', ['detach', point, '-force'], { stdio: 'ignore' });
        break;
      } catch {
        // The volume may still be flushing after its process was killed; give the
        // kernel a moment before asking again.
        await new Promise((r) => setTimeout(r, 200));
      }
    }
  }
}

const TRANSIENT_RM_CODES = new Set(['EBUSY', 'ENOTEMPTY', 'EPERM', 'EACCES']);

async function removeTree(target: string | undefined, label: string): Promise<void> {
  if (!target) return;
  const deadline = Date.now() + 10_000;
  for (;;) {
    try {
      await fs.promises.rm(target, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
      return;
    } catch (err: any) {
      // A volume killed mid-attach only loses its mount point once the kernel
      // finishes unmounting; a dying child has the same effect on a directory.
      // Wait that out instead of turning a transient race into a red suite.
      if (Date.now() < deadline && TRANSIENT_RM_CODES.has(err?.code)) {
        await new Promise((r) => setTimeout(r, 200));
        continue;
      }
      throw new Error(`could not remove ${label} (${target}): ${err?.code ?? err}`);
    }
  }
}

beforeAll(() => {
  // Skipped real-process tests must also initialize safely in restricted runners.
  if (!onMac) {
    workspace = fs.mkdtempSync(path.join(process.cwd(), '.cc-sandbox-ws-'));
    outside = workspace;
    return;
  }

  // realpathSync matters: /tmp is a symlink to /private/tmp on macOS, and a
  // seatbelt subpath built from the unresolved path matches nothing — which
  // silently denies writes to the workspace itself.
  const base = fs.realpathSync(os.tmpdir());
  workspace = fs.mkdtempSync(path.join(base, 'cc-sandbox-ws-'));
  // Must be outside EVERY writable root. TMPDIR is deliberately writable (build
  // tools need it), so a dir under it would not test anything — the first run of
  // this test "passed" a write it should have blocked for exactly that reason.
  try {
    outside = fs.mkdtempSync(path.join(fs.realpathSync(os.homedir()), '.cc-sandbox-out-'));
  } catch {
    // Some CI runners expose macOS APIs but prohibit writes outside the repo.
    canRunRealSandboxTests = false;
    outside = workspace;
  }
});

afterAll(async () => {
  // Kill first, tear down second: while a child is alive it can still be
  // creating files (or mounting a volume) inside the workspace, which is exactly
  // what made the old synchronous teardown fail intermittently.
  await Promise.all([...liveChildren].map((child) => killTree(child)));
  await detachMountsUnder(workspace);
  await removeTree(workspace, 'the sandbox workspace');
  if (outside !== workspace) await removeTree(outside, 'the outside-workspace probe dir');
}, TEARDOWN_TIMEOUT_MS);

function runSandboxed(
  command: string,
  opts: { allowNetwork?: boolean; allowDiskImages?: boolean } = {},
  timeoutMs = COMMAND_TIMEOUT_MS,
) {
  const argv = buildSandboxArgv(command, {
    mode: 'workspaceWrite',
    writableRoots: [workspace, fs.realpathSync(os.tmpdir())],
    allowNetwork: opts.allowNetwork ?? true,
    allowDiskImages: opts.allowDiskImages,
  })!;
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = track(spawn(argv.file, argv.args, { cwd: workspace, detached: true }));
    let out = '';
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (result: { code: number; out: string }) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve(result);
    };
    deadline = setTimeout(() => {
      void killTree(child);
      finish({
        code: 124,
        out: `${out}\n[sandbox test harness] command still running after ${timeoutMs}ms; process group killed`,
      });
    }, timeoutMs);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => finish({ code: code ?? 1, out }));
    child.on('error', (e) => finish({ code: 1, out: `${out}${e}` }));
  });
}

// The shell/profile-file path used by the tests below, with the same deadline and
// the same killable process group as runSandboxed.
function runShell(full: string, cwd: string): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    // spawn rather than exec: ExecOptions has no `detached`, and a process group
    // is what makes the kill below reach the whole chain.
    const child = track(spawn('/bin/sh', ['-c', full], { cwd, detached: true }));
    let out = '';
    let settled = false;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    const finish = (code: number) => {
      if (settled) return;
      settled = true;
      if (deadline) clearTimeout(deadline);
      resolve({ code, out });
    };
    deadline = setTimeout(() => {
      void killTree(child);
      out += `\n[sandbox test harness] command timed out after ${COMMAND_TIMEOUT_MS}ms`;
      finish(124);
    }, COMMAND_TIMEOUT_MS);
    child.stdout?.on('data', (d) => { out += d.toString(); });
    child.stderr?.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => finish(code ?? 1));
    child.on('error', (e) => { out += String(e); finish(1); });
  });
}

describe('seatbelt profile', () => {
  it('re-allows the workspace after denying writes globally', () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/a/ws'], allowNetwork: true });
    expect(profile).toContain('(deny file-write*)');
    expect(profile.indexOf('(deny file-write*)')).toBeLessThan(profile.indexOf('(subpath "/a/ws")'));
    expect(profile).not.toContain('(deny network*)');
  });

  it('denies the network only when asked', () => {
    expect(buildSeatbeltProfile({ writableRoots: [], allowNetwork: false })).toContain('(deny network*)');
  });

  it('allows raw disk devices only when disk-image operations are requested', () => {
    const ordinary = buildSeatbeltProfile({ writableRoots: ['/a/ws'], allowNetwork: true });
    const diskImages = buildSeatbeltProfile({
      writableRoots: ['/a/ws'],
      allowNetwork: true,
      allowDiskImages: true,
    });
    expect(ordinary).not.toContain('/dev/(r?disk');
    expect(diskImages).toContain('/dev/(r?disk[0-9]+.*|dtracehelper)');
  });

  it('strips trailing slashes, which would make a subpath match nothing', () => {
    expect(buildSeatbeltProfile({ writableRoots: ['/a/ws/'], allowNetwork: true })).toContain('(subpath "/a/ws")');
  });

  it('escapes paths into the s-expression safely', () => {
    const profile = buildSeatbeltProfile({ writableRoots: ['/a/we"ird'], allowNetwork: true });
    expect(profile).toContain('(subpath "/a/we\\"ird")');
  });

  it('passes the profile as one argv element, never through a shell', () => {
    const argv = buildSandboxArgv('echo hi', { mode: 'workspaceWrite', writableRoots: ['/a'], allowNetwork: true }, 'darwin')!;
    expect(argv.file).toBe('/usr/bin/sandbox-exec');
    expect(argv.args[0]).toBe('-p');
    expect(argv.args[1]).toContain('(version 1)');
    expect(argv.args.slice(2)).toEqual(['/bin/sh', '-c', 'echo hi']);
  });

  it('opts out where seatbelt does not exist', () => {
    expect(sandboxAvailable('win32')).toBe(false);
    expect(buildSandboxArgv('echo hi', { mode: 'workspaceWrite', writableRoots: ['/a'], allowNetwork: true }, 'win32')).toBeNull();
    expect(buildSandboxArgv('echo hi', { mode: 'off', writableRoots: ['/a'], allowNetwork: true }, 'darwin')).toBeNull();
  });
});

describe.skipIf(!canRunRealSandboxTests)('the sandbox against real processes', () => {
  it('allows writing inside the workspace', async () => {
    const r = await runSandboxed('echo hello > out.txt && cat out.txt');
    expect(r.out).toContain('hello');
    expect(r.code).toBe(0);
    expect(fs.existsSync(path.join(workspace, 'out.txt'))).toBe(true);
  });

  it('BLOCKS writing outside the workspace', async () => {
    const target = path.join(outside, 'escaped.txt');
    const r = await runSandboxed(`echo pwned > ${target}`);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
    expect(looksLikeSandboxDenial(r.out)).toBe(true);
  });

  it('BLOCKS deleting a file outside the workspace', async () => {
    const victim = path.join(outside, 'precious.txt');
    fs.writeFileSync(victim, 'do not lose me');
    const r = await runSandboxed(`rm -f ${victim}`);
    expect(r.code).not.toBe(0);
    expect(fs.readFileSync(victim, 'utf-8')).toBe('do not lose me');
  });

  it('still allows reading outside the workspace', async () => {
    const r = await runSandboxed('cat /etc/hosts | head -1');
    expect(r.code).toBe(0);
  });

  // The redirections and pipes that made a naive policy useless.
  it('supports redirection to /dev/null', async () => {
    const r = await runSandboxed('echo noise > /dev/null && echo survived');
    expect(r.out).toContain('survived');
    expect(r.code).toBe(0);
  });

  it('supports pipes and multi-stage shell commands', async () => {
    const r = await runSandboxed('printf "b\\na\\n" | sort | tr -d "\\n"');
    expect(r.out).toContain('ab');
    expect(r.code).toBe(0);
  });

  // Real create + attach + detach, so it gets its own budget instead of the 5s
  // default that used to fire mid-attach on a loaded machine.
  it(
    'creates, mounts, and detaches a disk image when explicitly allowed',
    async () => {
      const image = path.join(workspace, 'probe.dmg');
      const mount = path.join(workspace, 'probe-mount');
      fs.mkdirSync(mount, { recursive: true });
      const command = [
        `hdiutil create -ov -size 1m -fs APFS -volname Probe ${shellQuote(image)}`,
        `hdiutil attach -nobrowse -mountpoint ${shellQuote(mount)} ${shellQuote(image)}`,
        `hdiutil detach ${shellQuote(mount)} -force`,
      ].join(' && ');
      const r = await runSandboxed(command, { allowDiskImages: true });
      // Second argument prints the captured output on failure, so a killed
      // over-budget command says why instead of just "expected 124 to be 0".
      expect(r.code, r.out).toBe(0);
      expect(fs.existsSync(image)).toBe(true);
      // Anything left mounted here would make afterAll inherit a directory it
      // cannot delete — the teardown half of this flake.
      expect(mountPointsUnder(workspace)).toEqual([]);
    },
    120_000,
  );

  it('runs a real toolchain: node writes into the workspace', async () => {
    const r = await runSandboxed(`node -e "require('fs').writeFileSync('via-node.txt','ok')" && cat via-node.txt`);
    expect(r.out).toContain('ok');
    expect(r.code).toBe(0);
  });

  it('runs git inside the workspace', async () => {
    const r = await runSandboxed('git init -q . && git status --porcelain >/dev/null && echo git-ok');
    expect(r.out).toContain('git-ok');
    expect(r.code).toBe(0);
  });

  it('can block the network while still allowing local work', async () => {
    const denied = await runSandboxed('curl -s -m 5 https://example.com -o page.html', { allowNetwork: false });
    expect(denied.code).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, 'page.html'))).toBe(false);

    const local = await runSandboxed('echo still-works', { allowNetwork: false });
    expect(local.out).toContain('still-works');
  });

  // Regression: the harness used to have no deadline and no way to kill a child,
  // so an overrunning command (in practice `hdiutil attach`) kept working on the
  // workspace after its test ended and fought afterAll's teardown.
  it('kills an overrunning command instead of leaking it into teardown', async () => {
    const marker = `cc-overrun-${process.pid}-${Date.now()}`;
    const started = Date.now();
    const r = await runSandboxed(`echo started > leak.txt && sleep 30 # ${marker}`, {}, 400);
    expect(r.code).toBe(124);
    expect(r.out).toContain('process group killed');
    expect(Date.now() - started).toBeLessThan(10_000);
    // It really was running (not rejected by the policy) when the deadline hit.
    expect(fs.readFileSync(path.join(workspace, 'leak.txt'), 'utf-8')).toBe('started\n');

    const groupGone = () => {
      try {
        execFileSync('/usr/bin/pgrep', ['-f', marker], { stdio: 'ignore' });
        return false;
      } catch {
        return true;
      }
    };
    let gone = false;
    for (let attempt = 0; attempt < 40 && !gone; attempt++) {
      gone = groupGone();
      if (!gone) await new Promise((res) => setTimeout(res, 50));
    }
    expect(gone, `a process from "${marker}" outlived the deadline`).toBe(true);
  });
});

describe('looksLikeSandboxDenial', () => {
  it('recognises a denial', () => {
    expect(looksLikeSandboxDenial('sh: /x/y: Operation not permitted')).toBe(true);
  });

  it('does not mistake an ordinary failure for one', () => {
    expect(looksLikeSandboxDenial('npm ERR! missing script: buld')).toBe(false);
    expect(looksLikeSandboxDenial('')).toBe(false);
  });
});


// The production path (electron/main.ts) writes the policy to a file and runs it
// THROUGH A SHELL so pipes and redirection keep working. That is a different code
// path from the argv form above, so it gets its own real-process coverage.
describe.skipIf(!canRunRealSandboxTests)('the shell/profile-file path used in production', () => {
  function runViaShell(command: string, opts: { allowNetwork?: boolean } = {}) {
    const profile = buildSeatbeltProfile({
      writableRoots: [workspace, fs.realpathSync(os.tmpdir())],
      allowNetwork: opts.allowNetwork ?? true,
    });
    const profilePath = path.join(workspace, '.policy.sb');
    fs.writeFileSync(profilePath, profile);
    const full = buildSandboxShellCommand(command, profilePath);
    return runShell(full, workspace);
  }

  it('confines writes when invoked through a shell', async () => {
    const target = path.join(outside, 'via-shell.txt');
    const r = await runViaShell(`echo pwned > ${target}`);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('still allows the workspace, redirection and pipes', async () => {
    const r = await runViaShell('echo ok > shell-out.txt && cat shell-out.txt | tr -d "\n" && echo " " > /dev/null');
    expect(r.out).toContain('ok');
    expect(r.code).toBe(0);
  });

  it('survives a command containing single quotes', async () => {
    // The command is embedded in a single-quoted shell word; unescaped quotes
    // here would corrupt the command or the policy path.
    const r = await runViaShell(`node -e 'console.log("it'"'"'s fine")'`);
    expect(r.out).toContain("it's fine");
    expect(r.code).toBe(0);
  });

  it('escapes a quote-bearing path in the built command', () => {
    expect(shellQuote(`/a/b'c`)).toBe(`'/a/b'\\''c'`);
    const cmd = buildSandboxShellCommand('echo hi', `/tmp/we'ird.sb`);
    expect(cmd.startsWith('/usr/bin/sandbox-exec -f ')).toBe(true);
    expect(cmd).toContain('/bin/sh -c ');
  });
});


// The exact function electron/main.ts calls, run end to end against real
// processes: nothing between the setting and the confined command is untested.
describe.skipIf(!canRunRealSandboxTests)('resolveSandboxCommand (the production entry point)', () => {
  function runResolved(command: string, request: any) {
    const resolved = resolveSandboxCommand({
      command,
      cwd: workspace,
      request,
      profileDir: workspace,
    });
    return runShell(resolved.command, workspace).then((r) => ({ ...r, sandboxed: resolved.sandboxed }));
  }

  it('confines a write outside the workspace end to end', async () => {
    const target = path.join(outside, 'e2e.txt');
    const r = await runResolved(`echo pwned > ${target}`, { mode: 'workspaceWrite', allowNetwork: true });
    expect(r.sandboxed).toBe(true);
    expect(r.code).not.toBe(0);
    expect(fs.existsSync(target)).toBe(false);
  });

  it('lets the same command through when the sandbox is off', async () => {
    const target = path.join(outside, 'allowed.txt');
    const r = await runResolved(`echo fine > ${target}`, { mode: 'off' });
    expect(r.sandboxed).toBe(false);
    expect(r.code).toBe(0);
    expect(fs.existsSync(target)).toBe(true);
    fs.rmSync(target, { force: true });
  });

  it('resolves the workspace through symlinks', async () => {
    // A symlinked cwd is the case that silently denies everything if the policy
    // is built from the unresolved path.
    // Kept inside the dir afterAll already owns, so a timeout cannot strand a
    // dangling symlink in the shared temp dir.
    const link = path.join(outside, `cc-link-${Date.now()}`);
    fs.symlinkSync(workspace, link);
    try {
      const resolved = resolveSandboxCommand({
        command: 'echo via-symlink > linked.txt && cat linked.txt',
        cwd: link,
        request: { mode: 'workspaceWrite', allowNetwork: true },
        profileDir: workspace,
      });
      const out = await runShell(resolved.command, link);
      expect(out.out).toContain('via-symlink');
    } finally {
      fs.rmSync(link, { force: true });
    }
  });

  it('honours the network switch', async () => {
    const blocked = await runResolved('curl -s -m 5 https://example.com -o net.html', {
      mode: 'workspaceWrite', allowNetwork: false,
    });
    expect(blocked.code).not.toBe(0);
    expect(fs.existsSync(path.join(workspace, 'net.html'))).toBe(false);
  });

  it('reports unconfined rather than failing where seatbelt is absent', () => {
    const r = resolveSandboxCommand({
      command: 'echo hi', cwd: workspace, profileDir: workspace,
      request: { mode: 'workspaceWrite' }, platform: 'win32',
    });
    expect(r).toEqual({ command: 'echo hi', sandboxed: false });
  });

  it('uses an isolated scratch directory and unique policy per run', () => {
    const first = resolveSandboxCommand({
      command: 'echo one', cwd: workspace, profileDir: workspace,
      request: { mode: 'workspaceWrite' }, platform: 'darwin',
    });
    const second = resolveSandboxCommand({
      command: 'echo two', cwd: workspace, profileDir: workspace,
      request: { mode: 'workspaceWrite' }, platform: 'darwin',
    });

    expect(first.sandboxed).toBe(true);
    expect(second.sandboxed).toBe(true);
    expect(first.command).toContain('TMPDIR=');
    expect(first.command).toContain('/sandbox-tmp/run-');
    expect(first.command).toContain('trap ');
    expect(second.command).not.toBe(first.command);

    const policies = fs.readdirSync(workspace).filter((name) => /^sandbox-.*\.sb$/.test(name));
    expect(policies).toHaveLength(2);
    for (const policy of policies) fs.rmSync(path.join(workspace, policy), { force: true });
    fs.rmSync(path.join(workspace, 'sandbox-tmp'), { recursive: true, force: true });
  });
});
