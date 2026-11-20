import { execFile, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createGithubBranch,
  listGithubBranches,
  listGithubRemoteBranches,
  pushGithubProject,
  type GithubGitRunner,
} from './githubProject';

let fixture: string;
let workspace: string;
let remote: string;
let env: NodeJS.ProcessEnv;

function git(args: string[], cwd = workspace): string {
  return execFileSync('git', args, { cwd, env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

const runGit: GithubGitRunner = (args, cwd, overrides) => new Promise((resolve) => {
  execFile('git', args, { cwd, env: { ...env, ...overrides } }, (error, stdout, stderr) => {
    resolve({ code: !error ? 0 : typeof error.code === 'number' ? error.code : 1, stdout, stderr });
  });
});

function initRemote(path: string): void {
  mkdirSync(path);
  git(['init', '--quiet', '--bare'], path);
}

beforeEach(() => {
  fixture = mkdtempSync(join(tmpdir(), 'conecode-github-'));
  workspace = join(fixture, 'worktree');
  remote = join(fixture, 'origin');
  env = { ...process.env, GIT_CONFIG_GLOBAL: join(fixture, 'global-gitconfig'), GIT_CONFIG_NOSYSTEM: '1' };
  mkdirSync(workspace);
  git(['init', '--quiet', '--initial-branch=main']);
  git(['config', 'user.name', 'Test User']);
  git(['config', 'user.email', 'test@example.test']);
  initRemote(remote);
  git(['remote', 'add', 'origin', remote]);
});

afterEach(() => rmSync(fixture, { recursive: true, force: true }));

function commit(content = 'initial'): string {
  writeFileSync(join(workspace, 'notes.txt'), content);
  git(['add', 'notes.txt']);
  git(['commit', '--quiet', '-m', content]);
  return git(['rev-parse', 'HEAD']);
}

describe('GitHub plugin branch operations', () => {
  it('lists the checked-out unborn branch and regular local refs without ambiguous short names', async () => {
    await expect(listGithubBranches(runGit, workspace)).resolves.toMatchObject({ ok: true, branches: ['main'], current: 'main' });
    commit();
    git(['tag', 'main']);
    git(['branch', 'feature/sidebar', 'HEAD']);
    await expect(listGithubBranches(runGit, workspace)).resolves.toMatchObject({
      ok: true, branches: ['feature/sidebar', 'main'], current: 'main',
    });
    git(['switch', '--detach', 'HEAD']);
    await expect(listGithubBranches(runGit, workspace)).resolves.toMatchObject({
      ok: true, branches: ['feature/sidebar', 'main'], current: null,
    });
  });

  it('creates from a chosen local ref, with optional safe checkout', async () => {
    const initial = commit();
    git(['branch', 'base']);
    commit('latest');

    await expect(createGithubBranch(runGit, { cwd: workspace, name: 'feature/new', base: 'base' })).resolves.toMatchObject({ ok: true });
    expect(git(['rev-parse', 'refs/heads/feature/new'])).toBe(initial);
    expect(git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    await expect(createGithubBranch(runGit, { cwd: workspace, name: 'feature/new' })).resolves.toMatchObject({ ok: false });
    await expect(createGithubBranch(runGit, { cwd: workspace, name: '@{-1}' })).resolves.toMatchObject({ ok: false });

    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');
    await expect(createGithubBranch(runGit, { cwd: workspace, name: 'feature/conflicting', base: 'base', checkout: true }))
      .resolves.toMatchObject({ ok: false });
    expect(git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
    expect(git(['branch', '--list', 'feature/conflicting'])).toBe('');
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');

    await expect(createGithubBranch(runGit, { cwd: workspace, name: 'feature/checkout', checkout: true })).resolves.toMatchObject({ ok: true });
    expect(git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/feature/checkout');
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
  });

  it('uses the configured push URL for both remote branch discovery and pushes', async () => {
    const pushRemote = join(fixture, 'push-origin');
    initRemote(pushRemote);
    git(['remote', 'set-url', '--push', 'origin', pushRemote]);
    commit();
    writeFileSync(join(workspace, 'notes.txt'), 'published edit');

    await expect(listGithubBranches(runGit, workspace)).resolves.toMatchObject({ pushUrl: pushRemote });
    const runner = vi.fn(runGit);
    await expect(pushGithubProject(runner, { cwd: workspace, token: 'not-for-file-remote', targetBranch: 'release/next' }))
      .resolves.toMatchObject({ ok: true, message: expect.stringContaining('Committed') });
    const pushCall = runner.mock.calls.find(([args]) => args[0] === 'push');
    expect(pushCall?.[2]).toEqual({ GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' });
    expect(git(['show', 'refs/heads/release/next:notes.txt'], pushRemote)).toBe('published edit');
    expect(git(['for-each-ref', 'refs/heads'], remote)).toBe('');
    await expect(listGithubRemoteBranches(runGit, { cwd: workspace })).resolves.toEqual({ ok: true, branches: ['release/next'] });
  });

  it('pushes the committed tip of another branch without touching the working tree', async () => {
    const initial = commit();
    git(['branch', 'feature']);
    const latest = commit('latest');
    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');

    await expect(pushGithubProject(runGit, { cwd: workspace, sourceBranch: 'feature', targetBranch: 'release' })).resolves.toMatchObject({ ok: true });
    expect(git(['rev-parse', 'refs/heads/release'], remote)).toBe(initial);
    expect(git(['rev-parse', 'HEAD'])).toBe(latest);
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
    expect(git(['symbolic-ref', 'HEAD'])).toBe('refs/heads/main');
  });

  it('never overwrites a remote branch with an older commit', async () => {
    commit();
    git(['branch', 'older']);
    const newer = commit('newer');
    git(['push', 'origin', 'main']);

    await expect(pushGithubProject(runGit, { cwd: workspace, sourceBranch: 'older', targetBranch: 'main' }))
      .resolves.toMatchObject({ ok: false });
    expect(git(['rev-parse', 'refs/heads/main'], remote)).toBe(newer);
  });

  it('publishes without committing when the user chose committed changes only', async () => {
    const initial = commit();
    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');

    await expect(pushGithubProject(runGit, { cwd: workspace, sourceBranch: 'main', commitChanges: false })).resolves.toMatchObject({ ok: true });
    expect(git(['rev-parse', 'refs/heads/main'], remote)).toBe(initial);
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
    expect(git(['rev-parse', '--abbrev-ref', 'main@{upstream}'])).toBe('origin/main');
  });

  it('refuses to commit if the checked-out source branch changed after confirmation', async () => {
    commit();
    git(['branch', 'feature']);
    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');

    await expect(pushGithubProject(runGit, { cwd: workspace, sourceBranch: 'feature', commitChanges: true })).resolves.toMatchObject({ ok: false });
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
    expect(git(['for-each-ref', 'refs/heads'], remote)).toBe('');
  });

  it('creates remote branches and rejects attempts against an existing branch at the same commit', async () => {
    const initial = commit();
    const options = { cwd: workspace, targetBranch: 'release/new', createTarget: true };

    await expect(pushGithubProject(runGit, options)).resolves.toMatchObject({ ok: true });
    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');
    await expect(pushGithubProject(runGit, options)).resolves.toMatchObject({ ok: false, message: expect.stringContaining('already exists') });
    expect(git(['rev-parse', 'refs/heads/release/new'], remote)).toBe(initial);
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
  });

  it('rejects a ref created by another client between checking and pushing', async () => {
    const initial = commit();
    git(['push', 'origin', 'main']);
    const runner: GithubGitRunner = (args, cwd, overrides) => {
      if (args[0] === 'push') git(['update-ref', args[args.length - 1].split(':')[1], initial], remote);
      return runGit(args, cwd, overrides);
    };
    await expect(pushGithubProject(runner, { cwd: workspace, targetBranch: 'race', createTarget: true })).resolves.toMatchObject({ ok: false });
    expect(git(['rev-parse', 'refs/heads/race'], remote)).toBe(initial);
    commit('newer');
    await expect(pushGithubProject(runner, { cwd: workspace, targetBranch: 'race-2', createTarget: true })).resolves.toMatchObject({ ok: false });
    expect(git(['rev-parse', 'refs/heads/race-2'], remote)).toBe(initial);
  });

  it('keeps the push target pinned on authentication failure and redacts token values', async () => {
    commit();
    const pat = 'secret-test-token';
    const encoded = Buffer.from(`x-access-token:${pat}`).toString('base64');
    const chosen = 'https://github.com/owner/repo.git';
    const runner = vi.fn<GithubGitRunner>((args, cwd, overrides) => {
      if (args[0] === 'push') return Promise.resolve({ code: 1, stdout: '', stderr: `Rejected ${pat} via ${encoded}` });
      return runGit(args, cwd, overrides);
    });

    const result = await pushGithubProject(runner, { cwd: workspace, repo: 'owner/repo', token: pat });
    expect(result).toEqual({ ok: false, message: 'Rejected [redacted] via [redacted]' });
    const pushes = runner.mock.calls.filter(([args]) => args[0] === 'push');
    expect(pushes).toHaveLength(1);
    expect(pushes[0][0]).not.toContain('origin');
    expect(pushes[0][0].join(' ')).not.toContain(pat);
    expect(pushes[0][0].join(' ')).not.toContain(encoded);
    expect(Object.values(pushes[0][2] || {}).filter((value) => value === chosen)).toHaveLength(2);
    expect(Object.values(pushes[0][2] || {})).toContain(`AUTHORIZATION: basic ${encoded}`);
    expect(git(['for-each-ref', 'refs/heads'], remote)).toBe('');
  });

  it('blocks explicit GitHub URL rewrites and ambiguous origin push URLs before changing files', async () => {
    commit();
    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');
    git(['config', '--add', `url.${remote}.insteadOf`, 'https://github.com/owner/repo.git']);
    await expect(pushGithubProject(runGit, { cwd: workspace, repo: 'owner/repo' })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('rewrites') });
    git(['remote', 'set-url', '--push', 'origin', remote]);
    git(['remote', 'set-url', '--push', '--add', 'origin', `${remote}-second`]);
    await expect(pushGithubProject(runGit, { cwd: workspace })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('multiple') });
    expect(git(['for-each-ref', 'refs/heads'], remote)).toBe('');
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
  });

  it('invalidates confirmation when the actual origin push URL changes', async () => {
    commit();
    writeFileSync(join(workspace, 'notes.txt'), 'uncommitted');
    const { originKey } = await listGithubBranches(runGit, workspace);
    const other = join(fixture, 'other');
    initRemote(other);
    git(['remote', 'set-url', '--push', 'origin', other]);
    await expect(pushGithubProject(runGit, { cwd: workspace, originKey })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('changed') });

    const runner: GithubGitRunner = (args, cwd, overrides) => {
      if (args[0] === 'rev-parse' && args[1] === '--verify') git(['remote', 'set-url', '--push', 'origin', remote]);
      return runGit(args, cwd, overrides);
    };
    await expect(pushGithubProject(runner, { cwd: workspace, commitChanges: false })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('changed') });
    expect(git(['for-each-ref', 'refs/heads'], other)).toBe('');
    expect(git(['for-each-ref', 'refs/heads'], remote)).toBe('');
    expect(git(['status', '--porcelain'])).toBe('M notes.txt');
  });
});
