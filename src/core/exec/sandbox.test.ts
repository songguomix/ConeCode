import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { exec } from 'node:child_process';
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

afterAll(() => {
  if (workspace) fs.rmSync(workspace, { recursive: true, force: true });
  if (outside && outside !== workspace) fs.rmSync(outside, { recursive: true, force: true });
});

function runSandboxed(command: string, opts: { allowNetwork?: boolean; allowDiskImages?: boolean } = {}) {
  const argv = buildSandboxArgv(command, {
    mode: 'workspaceWrite',
    writableRoots: [workspace, fs.realpathSync(os.tmpdir())],
    allowNetwork: opts.allowNetwork ?? true,
    allowDiskImages: opts.allowDiskImages,
  })!;
  return new Promise<{ code: number; out: string }>((resolve) => {
    const child = spawn(argv.file, argv.args, { cwd: workspace });
    let out = '';
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { out += d.toString(); });
    child.on('close', (code) => resolve({ code: code ?? 1, out }));
    child.on('error', (e) => resolve({ code: 1, out: String(e) }));
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

  it('creates, mounts, and detaches a disk image when explicitly allowed', async () => {
    const image = path.join(workspace, 'probe.dmg');
    const mount = path.join(workspace, 'probe-mount');
    fs.mkdirSync(mount);
    const command = [
      `hdiutil create -ov -size 1m -fs APFS -volname Probe ${shellQuote(image)}`,
      `hdiutil attach -nobrowse -mountpoint ${shellQuote(mount)} ${shellQuote(image)}`,
      `hdiutil detach ${shellQuote(mount)} -force`,
    ].join(' && ');
    const r = await runSandboxed(command, { allowDiskImages: true });
    expect(r.code).toBe(0);
    expect(fs.existsSync(image)).toBe(true);
  });

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
    return new Promise<{ code: number; out: string }>((resolve) => {
      exec(full, { cwd: workspace, encoding: 'utf-8' }, (err: any, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}` });
      });
    });
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
    return new Promise<{ code: number; out: string; sandboxed: boolean }>((resolve) => {
      exec(resolved.command, { cwd: workspace, encoding: 'utf-8' }, (err: any, stdout, stderr) => {
        resolve({ code: err?.code ?? 0, out: `${stdout}${stderr}`, sandboxed: resolved.sandboxed });
      });
    });
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
    const link = path.join(fs.realpathSync(os.tmpdir()), `cc-link-${Date.now()}`);
    fs.symlinkSync(workspace, link);
    try {
      const resolved = resolveSandboxCommand({
        command: 'echo via-symlink > linked.txt && cat linked.txt',
        cwd: link,
        request: { mode: 'workspaceWrite', allowNetwork: true },
        profileDir: workspace,
      });
      const out = await new Promise<string>((res) => {
        exec(resolved.command, { cwd: link, encoding: 'utf-8' }, (_e, so, se) => res(`${so}${se}`));
      });
      expect(out).toContain('via-symlink');
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
