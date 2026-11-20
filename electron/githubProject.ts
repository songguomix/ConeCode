import { createHmac, randomBytes, randomUUID } from 'node:crypto';
import type {
  GithubBranches,
  GithubCreateBranchOptions,
  GithubLocalBranches,
  GithubPushOptions,
  GithubRemoteOptions,
} from '../src/types/github.types';

interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type GithubGitRunner = (args: string[], cwd: string, env?: NodeJS.ProcessEnv) => Promise<GitResult>;

interface OperationResult {
  ok: boolean;
  message: string;
}

interface Destination {
  label: string;
  remote: string;
  url: string;
  config: [string, string][];
  token: string;
  isOrigin: boolean;
}

const HEAD_PREFIX = 'refs/heads/';
const activeWorktrees = new Set<string>();
const originKeySecret = randomBytes(32);

function clean(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function gitError(result: GitResult, fallback: string): string {
  return result.stderr.trim() || result.stdout.trim() || fallback;
}

function redact(message: string, token: string): string {
  const safe = message.replace(/((?:https?|ssh):\/\/)[^\s/]+@/gi, '$1');
  if (!token) return safe;
  const encoded = Buffer.from(`x-access-token:${token}`).toString('base64');
  return safe.split(token).join('[redacted]').split(encoded).join('[redacted]');
}

function displayRemote(url: string): string {
  if (!/^(?:https?|ssh|git|file):\/\//i.test(url)) return url;
  try {
    const parsed = new URL(url);
    parsed.username = '';
    parsed.password = '';
    parsed.search = '';
    parsed.hash = '';
    return parsed.toString();
  } catch {
    return url;
  }
}

function originKey(url: string): string {
  return createHmac('sha256', originKeySecret).update(url).digest('hex');
}

async function worktreeRoot(runGit: GithubGitRunner, cwd: unknown): Promise<string | null> {
  if (typeof cwd !== 'string' || !cwd.trim()) return null;
  const result = await runGit(['rev-parse', '--show-toplevel'], cwd);
  return result.code === 0 ? result.stdout.trim() || null : null;
}

async function editWorktree(
  runGit: GithubGitRunner,
  cwd: unknown,
  edit: (root: string) => Promise<OperationResult>,
): Promise<OperationResult> {
  const root = await worktreeRoot(runGit, cwd);
  if (!root) return { ok: false, message: 'Open a Git project folder first.' };
  if (activeWorktrees.has(root)) return { ok: false, message: 'Another GitHub operation is running for this worktree.' };
  activeWorktrees.add(root);
  try {
    return await edit(root);
  } finally {
    activeWorktrees.delete(root);
  }
}

async function currentBranch(runGit: GithubGitRunner, cwd: string): Promise<string | null> {
  const result = await runGit(['symbolic-ref', '--quiet', 'HEAD'], cwd);
  const ref = result.stdout.trim();
  return result.code === 0 && ref.startsWith(HEAD_PREFIX) ? ref.slice(HEAD_PREFIX.length) : null;
}

async function validBranch(runGit: GithubGitRunner, cwd: string, name: string): Promise<boolean> {
  if (!name || name === 'HEAD' || name.startsWith('-') || name.includes('\0')) return false;
  return (await runGit(['check-ref-format', `${HEAD_PREFIX}${name}`], cwd)).code === 0;
}

async function originPushUrls(runGit: GithubGitRunner, cwd: string): Promise<string[]> {
  const result = await runGit(['remote', 'get-url', '--push', '--all', 'origin'], cwd);
  return result.code === 0 ? [...new Set(result.stdout.split(/\r?\n/).filter(Boolean))] : [];
}

export async function listGithubBranches(
  runGit: GithubGitRunner,
  cwd: string,
): Promise<GithubLocalBranches> {
  const root = await worktreeRoot(runGit, cwd);
  if (!root) return { ok: false, branches: [], current: null, message: 'Open a Git project folder first.' };
  const [current, refs, origins] = await Promise.all([
    currentBranch(runGit, root),
    runGit(['for-each-ref', '--format=%(refname:lstrip=2)', HEAD_PREFIX], root),
    originPushUrls(runGit, root),
  ]);
  if (refs.code !== 0) return { ok: false, branches: [], current, message: gitError(refs, 'Could not list local branches.') };
  const branches = new Set(refs.stdout.trim().split(/\r?\n/).filter(Boolean));
  if (current) branches.add(current);
  const pushUrl = origins.length === 1 ? origins[0] : undefined;
  return {
    ok: true,
    branches: [...branches].sort(),
    current,
    ...(pushUrl ? { pushUrl: displayRemote(pushUrl), originKey: originKey(pushUrl) } : {}),
  };
}

export function createGithubBranch(runGit: GithubGitRunner, options: GithubCreateBranchOptions): Promise<OperationResult> {
  return editWorktree(runGit, options?.cwd, async (cwd) => {
    const name = clean(options.name);
    const base = clean(options.base);
    if (!await validBranch(runGit, cwd, name)) return { ok: false, message: 'Invalid branch name.' };
    if (base && !await validBranch(runGit, cwd, base)) return { ok: false, message: 'Invalid base branch.' };

    const baseArgs = base ? [`${HEAD_PREFIX}${base}`] : [];
    const args = options.checkout
      ? ['switch', '--no-track', '-c', name, '--', ...baseArgs]
      : ['branch', '--no-track', '--', name, ...(base ? baseArgs : ['HEAD'])];
    const result = await runGit(args, cwd);
    if (result.code !== 0) return { ok: false, message: gitError(result, 'Could not create the branch.') };
    return { ok: true, message: options.checkout ? `Created and switched to "${name}".` : `Created branch "${name}".` };
  });
}

function temporaryRemote(url: string): Pick<Destination, 'remote' | 'config'> {
  const remote = `conecode-${randomUUID()}`;
  // An explicit pushurl prevents pushInsteadOf from changing this destination.
  return { remote, config: [[`remote.${remote}.url`, url], [`remote.${remote}.pushurl`, url]] };
}

function httpsGithubToken(url: string, token: string): string {
  try {
    return new URL(url).origin === 'https://github.com' ? token : '';
  } catch {
    return '';
  }
}

async function resolveDestination(
  runGit: GithubGitRunner,
  cwd: string,
  options: GithubRemoteOptions,
): Promise<Destination | string> {
  if (options.repo !== undefined && typeof options.repo !== 'string') return 'Enter a GitHub repository as owner/repo.';
  const repo = clean(options.repo);
  const token = clean(options.token);
  if (repo) {
    const segments = repo.split('/');
    if (segments.length !== 2 || segments.some((segment) => !/^[A-Za-z0-9_.-]+$/.test(segment) || segment === '.' || segment === '..')) {
      return 'Enter a GitHub repository as owner/repo.';
    }
    const url = `https://github.com/${repo}.git`;
    return { ...temporaryRemote(url), url, label: repo, token, isOrigin: false };
  }
  const origins = await originPushUrls(runGit, cwd);
  if (!origins.length) return 'The project has no origin remote. Select a GitHub repository first.';
  if (origins.length > 1) return 'Origin has multiple push URLs. Select a single GitHub repository first.';
  const [url] = origins;
  return { url, remote: 'origin', config: [], label: 'origin', token: httpsGithubToken(url, token), isOrigin: true };
}

async function unchangedUrl(runGit: GithubGitRunner, cwd: string, destination: Destination): Promise<boolean> {
  const result = await runGit(['ls-remote', '--get-url', '--', destination.remote], cwd, gitConfigEnv(destination.config));
  return result.code === 0 && result.stdout.trim() === destination.url;
}

function gitConfigEnv(config: [string, string][]): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  if (!config.length) return env;
  const count = Number(process.env.GIT_CONFIG_COUNT || 0);
  env.GIT_CONFIG_COUNT = String(count + config.length);
  for (const [index, [key, value]] of config.entries()) {
    env[`GIT_CONFIG_KEY_${count + index}`] = key;
    env[`GIT_CONFIG_VALUE_${count + index}`] = value;
  }
  return env;
}

function runRemoteGit(runGit: GithubGitRunner, cwd: string, destination: Destination, args: string[]): Promise<GitResult> {
  const { token } = destination;
  const config = [...destination.config];
  const http = `http.${displayRemote(destination.url)}`;
  if (!destination.isOrigin || token) config.push([`${http}.followRedirects`, 'false']);
  const env: NodeJS.ProcessEnv = { GIT_TERMINAL_PROMPT: '0', GCM_INTERACTIVE: 'Never' };
  if (token) {
    const authorization = Buffer.from(`x-access-token:${token}`).toString('base64');
    config.push([`${http}.sslVerify`, 'true'], [`${http}.extraHeader`, ''], [`${http}.extraHeader`, `AUTHORIZATION: basic ${authorization}`]);
    // Ambient debug and TLS settings must not disclose an account token.
    Object.assign(env, {
      GIT_SSL_NO_VERIFY: undefined, GIT_TRACE: '0', GIT_TRACE_CURL: '0', GIT_TRACE_CURL_COMPONENTS: undefined, GIT_CURL_VERBOSE: '0',
      GIT_TRACE2: '0', GIT_TRACE2_EVENT: '0', GIT_TRACE2_PERF: '0',
    });
  }
  return runGit(args, cwd, { ...gitConfigEnv(config), ...env });
}

async function remoteBranches(
  runGit: GithubGitRunner,
  cwd: string,
  destination: Destination,
  ref?: string,
): Promise<GithubBranches> {
  // An origin's fetch URL may differ from its push URL. Read the push URL.
  const remote = destination.isOrigin ? { ...destination, ...temporaryRemote(destination.url) } : destination;
  if (!await unchangedUrl(runGit, cwd, remote)) {
    return { ok: false, branches: [], message: 'Git configuration rewrites the selected push URL.' };
  }
  const result = await runRemoteGit(runGit, cwd, remote, ['ls-remote', '--heads', '--', remote.remote, ...(ref ? [ref] : [])]);
  if (result.code !== 0) {
    return { ok: false, branches: [], message: redact(gitError(result, 'Could not list remote branches.'), destination.token) };
  }
  const branches = result.stdout.split(/\r?\n/)
    .map((line) => line.split('\t')[1])
    .filter((name) => name?.startsWith(HEAD_PREFIX) && (!ref || name === ref))
    .map((name) => name.slice(HEAD_PREFIX.length));
  return { ok: true, branches: [...new Set(branches)].sort() };
}

export async function listGithubRemoteBranches(runGit: GithubGitRunner, options: GithubRemoteOptions): Promise<GithubBranches> {
  const cwd = await worktreeRoot(runGit, options?.cwd);
  if (!cwd) return { ok: false, branches: [], message: 'Open a Git project folder first.' };
  const destination = await resolveDestination(runGit, cwd, options);
  if (typeof destination === 'string') return { ok: false, branches: [], message: destination };
  return remoteBranches(runGit, cwd, destination);
}

export function pushGithubProject(runGit: GithubGitRunner, options: GithubPushOptions): Promise<OperationResult> {
  return editWorktree(runGit, options?.cwd, async (cwd) => {
    const current = await currentBranch(runGit, cwd);
    const source = clean(options.sourceBranch) || current;
    if (!source) return { ok: false, message: 'Select a local branch to push from detached HEAD.' };
    if (options.commitChanges === true && current !== source) {
      return { ok: false, message: 'The checked-out branch changed before committing.' };
    }
    const target = clean(options.targetBranch) || source;
    if (!await validBranch(runGit, cwd, source) || !await validBranch(runGit, cwd, target)) {
      return { ok: false, message: 'The source or destination branch name is invalid.' };
    }

    const destination = await resolveDestination(runGit, cwd, options);
    if (typeof destination === 'string') return { ok: false, message: destination };
    if (destination.isOrigin && options.originKey !== undefined && options.originKey !== originKey(destination.url)) {
      return { ok: false, message: 'The origin push URL changed. Review and confirm the new destination.' };
    }
    if (!destination.isOrigin && !await unchangedUrl(runGit, cwd, destination)) {
      return { ok: false, message: 'Git configuration rewrites the selected GitHub URL.' };
    }

    const sourceRef = `${HEAD_PREFIX}${source}`;
    const targetRef = `${HEAD_PREFIX}${target}`;
    const targetExists = { ok: false, message: `Remote branch "${target}" already exists.` };
    if (options.createTarget) {
      const remote = await remoteBranches(runGit, cwd, destination, targetRef);
      if (!remote.ok) return { ok: false, message: remote.message || 'Could not check the remote branch.' };
      if (remote.branches.length) return targetExists;
    }

    let committed = false;
    if (options.commitChanges ?? (current === source)) {
      const status = await runGit(['status', '--porcelain'], cwd);
      if (status.code !== 0) return { ok: false, message: gitError(status, 'Could not read Git status.') };
      if (status.stdout.trim()) {
        if (source !== await currentBranch(runGit, cwd)) return { ok: false, message: 'The checked-out branch changed before committing.' };
        const add = await runGit(['add', '-A'], cwd);
        if (add.code !== 0) return { ok: false, message: gitError(add, 'git add failed.') };
        if (source !== await currentBranch(runGit, cwd)) return { ok: false, message: 'The checked-out branch changed after staging.' };
        const commit = await runGit(['commit', '-m', clean(options.message) || 'Update via ConeCode'], cwd);
        if (commit.code !== 0) return { ok: false, message: gitError(commit, 'git commit failed.') };
        committed = true;
      }
    }
    const sourceCommit = await runGit(['rev-parse', '--verify', `${sourceRef}^{commit}`], cwd);
    if (sourceCommit.code !== 0) return { ok: false, message: `Local branch "${source}" has no commit to push.` };

    const args = ['push', '--porcelain', '--no-follow-tags', '--recurse-submodules=no'];
    if (destination.isOrigin && source === target) args.push('--set-upstream');
    // Empty expected value only allows an absent remote ref, including when
    // another client creates it between the preflight read and this push.
    if (options.createTarget) args.push(`--force-with-lease=${targetRef}:`);
    args.push('--', destination.remote, `${sourceRef}:${targetRef}`);
    if (destination.isOrigin) {
      const origins = await originPushUrls(runGit, cwd);
      if (origins.length !== 1 || origins[0] !== destination.url) {
        const message = 'The origin push URL changed. Review and confirm the new destination.';
        return { ok: false, message: committed ? `Committed locally. ${message}` : message };
      }
    }
    const push = await runRemoteGit(runGit, cwd, destination, args);
    if (push.code !== 0) {
      const message = redact(gitError(push, 'git push failed.'), destination.token);
      return { ok: false, message: committed ? `Committed locally. Push failed: ${message}` : message };
    }
    if (options.createTarget && push.stdout.split(/\r?\n/).some((line) => line.startsWith('=\t'))) return targetExists;

    const summary = `branch "${source}" to ${destination.label} → "${target}".`;
    return { ok: true, message: committed ? `Committed and pushed ${summary}` : `Pushed ${summary}` };
  });
}
