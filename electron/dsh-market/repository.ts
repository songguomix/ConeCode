import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import type { MarketPlugin, MarketVersion } from '../../src/core/dsh-market/types';
import {
  loadBundlePatches,
  manifestAuthor,
  manifestRepository,
  readPackageManifest,
  rowsFromPatches,
} from './manifest';
import { assertInside } from './security';

export interface RepositoryInspectionData {
  input: string;
  url: string;
  ref: string;
  commit: string;
  subdir?: string;
  plugin: MarketPlugin;
  version: MarketVersion;
  warnings: string[];
}

const FULL_SHA = /^[0-9a-f]{40}$/;
const REF = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,200}$/;

function fail(message: string): never {
  throw new Error(message);
}

export function normalizeRepositoryInput(input: string, refInput?: string): { url: string; ref: string } {
  let raw = input.trim();
  if (!raw) fail('Repository URL is required.');
  if (raw.startsWith('github:')) raw = `https://github.com/${raw.slice('github:'.length)}`;
  raw = raw.replace(/^git\+/, '');
  let urlPart = raw;
  let ref = refInput?.trim() || '';
  const hash = raw.indexOf('#');
  if (hash >= 0) {
    if (!ref) ref = raw.slice(hash + 1);
    urlPart = raw.slice(0, hash);
  }
  let url: URL;
  try {
    url = new URL(urlPart);
  } catch {
    fail('Use https://host/owner/repo or github:owner/repo.');
  }
  if (url.protocol !== 'https:') fail('Repository imports require https:// (SSH and local git URLs are not accepted).');
  if (url.username || url.password || url.search || url.hash) fail('Repository URL must not contain credentials, a query or a fragment.');
  urlPart = url.toString().replace(/\.git$/, '').replace(/\/$/, '');
  if (!url.pathname || url.pathname === '/') fail('Repository URL must include an owner/repository path.');
  ref = ref || 'HEAD';
  if (ref.startsWith('-') || !REF.test(ref) || ref.includes('..')) fail('Invalid git ref.');
  return { url: urlPart, ref };
}

function sanitizeSubdir(subdir?: string): string | undefined {
  if (!subdir?.trim()) return undefined;
  const normalized = subdir.trim().replace(/\\/g, '/').replace(/^\.\//, '');
  if (path.isAbsolute(normalized) || normalized.split('/').includes('..')) fail('Package subdirectory must stay inside the repository.');
  return normalized;
}

class GitClient {
  async run(args: string[], cwd?: string, timeoutMs = 60_000): Promise<string> {
    const child = spawn('git', args, {
      cwd,
      shell: false,
      windowsHide: true,
      env: {
        ...process.env,
        GIT_TERMINAL_PROMPT: '0',
        GIT_OPTIONAL_LOCKS: '0',
        GIT_CONFIG_NOSYSTEM: '1',
        GIT_CONFIG_GLOBAL: process.platform === 'win32' ? 'NUL' : '/dev/null',
        GIT_LFS_SKIP_SMUDGE: '1',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => { stdout += data.toString(); });
    child.stderr.on('data', (data) => { stderr += data.toString(); });
    const timer = setTimeout(() => {
      if (!child.killed) child.kill('SIGTERM');
    }, timeoutMs);
    try {
      const [code] = await once(child, 'close') as [number, NodeJS.Signals | null];
      if (code !== 0) {
        throw new Error(`git ${args[0]} failed (exit ${code}): ${(stderr || stdout).trim().slice(-700)}`);
      }
      return stdout;
    } finally {
      clearTimeout(timer);
    }
  }
}

const git = new GitClient();

export async function resolveRepositoryCommit(url: string, ref: string): Promise<string> {
  if (FULL_SHA.test(ref)) return ref;
  let output = '';
  try {
    output = await git.run(['ls-remote', url, ref], undefined, 25_000);
  } catch (error) {
    throw new Error(`Could not reach repository: ${error instanceof Error ? error.message : String(error)}`);
  }
  const rows = output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).map((line) => {
    const [sha, name] = line.split(/\s+/);
    return { sha, name };
  });
  if (!rows.length) {
    // HEAD is advertised as a symbolic ref; ask for it explicitly.
    if (ref === 'HEAD') {
      output = await git.run(['ls-remote', url, 'HEAD'], undefined, 25_000);
      const line = output.split(/\r?\n/).find(Boolean);
      const sha = line?.split(/\s+/)[0];
      if (sha && FULL_SHA.test(sha)) return sha;
    }
    throw new Error(`Ref ${JSON.stringify(ref)} was not found in ${url}.`);
  }
  const candidates = [ref, `refs/heads/${ref}`, `refs/tags/${ref}`, `refs/tags/${ref}^{}`];
  for (const candidate of candidates) {
    const peeled = rows.find((row) => row.name === `${candidate}^{}`) || rows.find((row) => row.name === candidate);
    if (peeled && FULL_SHA.test(peeled.sha)) return peeled.sha;
  }
  const first = rows.find((row) => FULL_SHA.test(row.sha));
  if (first) return first.sha;
  fail(`Ref ${JSON.stringify(ref)} did not resolve to a commit.`);
}

export async function materializeRepository(
  url: string,
  commit: string,
  workRoot: string,
): Promise<string> {
  fs.mkdirSync(workRoot, { recursive: true });
  const id = crypto.createHash('sha256').update(`${url}\0${commit}`).digest('hex').slice(0, 16);
  const dir = assertInside(workRoot, path.join(workRoot, `repo-${id}`), 'repository cache');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  try {
    await git.run(['init', '-q', dir]);
    await git.run(['remote', 'add', 'origin', url], dir);
    try {
      await git.run(['fetch', '--depth', '1', '--no-tags', 'origin', commit], dir, 120_000);
    } catch (error) {
      throw new Error(`Could not fetch pinned commit ${commit}: ${error instanceof Error ? error.message : String(error)}`);
    }
    await git.run(['checkout', '-q', '--detach', 'FETCH_HEAD'], dir);
    const head = (await git.run(['rev-parse', 'HEAD'], dir)).trim();
    if (head !== commit) throw new Error(`Fetched commit resolved to ${head}, expected ${commit}.`);
    return dir;
  } catch (error) {
    fs.rmSync(dir, { recursive: true, force: true });
    throw error;
  }
}

function categoryFor(manifest: Record<string, any>): MarketPlugin['category'] {
  if (manifest.dsh?.client) return 'interface';
  if (manifest.dsh?.profile) return 'integrations';
  return 'tools';
}

export async function inspectRepositoryDirectory(
  input: string,
  repoDir: string,
  url: string,
  ref: string,
  commit: string,
  subdir?: string,
): Promise<RepositoryInspectionData> {
  const cleanSubdir = sanitizeSubdir(subdir);
  const packageDir = cleanSubdir ? assertInside(repoDir, path.join(repoDir, cleanSubdir), 'package subdirectory') : repoDir;
  if (!fs.existsSync(path.join(packageDir, 'package.json'))) {
    throw new Error('The repository has no package.json at that path.');
  }
  if (fs.existsSync(path.join(packageDir, 'conecode.plugin.json'))) {
    throw new Error('This is a ConeCode-native plugin repository. Use Sources → Import local folder for native plugins.');
  }
  const manifest = readPackageManifest(packageDir);
  if (!manifest.dsh || typeof manifest.dsh !== 'object') {
    throw new Error('The package does not declare dsh.bundle; this is not an installable DSH plugin.');
  }
  const patches = loadBundlePatches(packageDir, manifest);
  const rows = rowsFromPatches(packageDir, manifest.name!, patches);
  if (!rows.length) throw new Error('The bundle patch inserts no mountable plugin rows.');
  const version: MarketVersion = {
    version: manifest.version!,
    publishedAt: new Date().toISOString(),
    source: { type: 'git', url, commit, ...(cleanSubdir ? { subdir: cleanSubdir } : {}) },
    engines: {
      ...(typeof manifest.engines?.dsh === 'string' ? { dsh: manifest.engines.dsh } : {}),
      ...(typeof manifest.engines?.node === 'string' ? { node: manifest.engines.node } : {}),
    },
    peerDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
    dependencies: Object.fromEntries(Object.entries(manifest.dependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
    license: typeof manifest.license === 'string' ? manifest.license : undefined,
  };
  const readmeFile = ['README.md', 'readme.md', 'Readme.md'].map((name) => path.join(packageDir, name)).find((file) => fs.existsSync(file));
  const readme = readmeFile ? fs.readFileSync(readmeFile, 'utf8').slice(0, 512 * 1024) : undefined;
  const plugin: MarketPlugin = {
    id: manifest.name!,
    name: manifest.name!,
    format: 'dsh',
    title: typeof manifest.description === 'string' && manifest.description.length < 90 ? manifest.description : manifest.name!,
    description: typeof manifest.description === 'string' ? manifest.description : '',
    author: manifestAuthor(manifest),
    homepage: manifest.homepage,
    repository: { url, ...(cleanSubdir ? { directory: cleanSubdir } : {}) },
    license: typeof manifest.license === 'string' ? manifest.license : undefined,
    category: categoryFor(manifest as Record<string, any>),
    labels: ['git', 'repository-import'],
    keywords: Array.isArray(manifest.keywords) ? manifest.keywords.filter((item): item is string => typeof item === 'string') : [],
    dsh: manifest.dsh,
    declared: {
      engines: Object.fromEntries(Object.entries(manifest.engines || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
      peerDependencies: Object.fromEntries(Object.entries(manifest.peerDependencies || {}).filter(([, value]) => typeof value === 'string')) as Record<string, string>,
      dsh: manifest.dsh,
    },
    versions: [version],
    sourceId: 'repository-import',
    ...(readme ? { readme } : {}),
  };
  return {
    input,
    url,
    ref,
    commit,
    ...(cleanSubdir ? { subdir: cleanSubdir } : {}),
    plugin,
    version,
    warnings: patches.warnings,
  };
}

/** Resolve, pin, shallow-fetch and inspect a remote DSH plugin repository. */
export async function inspectRemoteRepository(
  input: string,
  refInput: string | undefined,
  subdir: string | undefined,
  workRoot: string,
): Promise<RepositoryInspectionData> {
  const { url, ref } = normalizeRepositoryInput(input, refInput);
  const commit = await resolveRepositoryCommit(url, ref);
  const dir = await materializeRepository(url, commit, workRoot);
  try {
    return await inspectRepositoryDirectory(input, dir, url, ref, commit, subdir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
