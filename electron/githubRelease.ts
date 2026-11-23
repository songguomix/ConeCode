import fs from 'node:fs';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import { promisify } from 'node:util';

export interface ReleaseOptions {
  repo: string;
  token: string;
  tag: string;
  name?: string;
  body?: string;
  target: string;
  files: string[];
  draft?: boolean;
  prerelease?: boolean;
}
export interface ReleaseResult { ok: boolean; message: string; url?: string }

type RunGh = (args: string[], env: NodeJS.ProcessEnv) => Promise<string>;
const exec = promisify(execFile);
const runGh: RunGh = async (args, env) => {
  try {
    const { stdout } = await exec('gh', args, { env, windowsHide: true, timeout: args[1] === 'upload' ? 60 * 60 * 1000 : 60_000, maxBuffer: 8 * 1024 ** 2 });
    return stdout.trim();
  } catch (error) {
    const failure = error as NodeJS.ErrnoException & { stderr?: string; signal?: string };
    if (failure.code === 'ENOENT') throw new Error('GitHub CLI (gh) is not installed or is not on PATH.');
    throw new Error(failure.stderr?.trim() || `gh ${args[1]} failed: ${failure.signal || failure.code || 'unknown error'}`);
  }
};

interface ReleaseAsset { name: string; size: number; state: string; digest?: string | null }

interface ReleaseInfo {
  tagName: string;
  targetCommitish: string;
  isDraft: boolean;
  isPrerelease: boolean;
  url: string;
  assets: ReleaseAsset[];
}

function matchesUpload(asset: ReleaseAsset, file: { size: number; digest: string }): boolean {
  return asset.state === 'uploaded' && asset.size === file.size && asset.digest === file.digest;
}

/** Publish only after every requested attachment is present in the draft. */
export async function publishGithubRelease(
  options: ReleaseOptions,
  run: RunGh = runGh,
  shellEnv = process.env,
): Promise<ReleaseResult> {
  let draftUrl: string | undefined;
  const token = options?.token?.trim();
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options?.repo || '')) throw new Error('Invalid GitHub repository: use owner/repo.');
    if (!token) throw new Error('A GitHub token with Contents: read and write permission is required.');
    if (!options.tag?.trim() || /[\s~^:?*\[\\]/.test(options.tag) || options.tag.startsWith('-') || options.tag.includes('..')) throw new Error('Invalid release tag.');
    if (!options.target?.trim()) throw new Error('A target branch or commit is required.');
    if (!Array.isArray(options.files) || !options.files.length) throw new Error('Select at least one release attachment.');
    const names = new Set<string>();
    const attachments = options.files.map((file) => {
      if (!path.isAbsolute(file)) throw new Error('Attachment paths must be absolute.');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size >= 2 * 1024 ** 3) throw new Error('Each attachment must be a non-empty file smaller than 2 GiB.');
      const name = path.basename(file);
      if (/\.(pem|key|pfx|p12|env)$/i.test(name)) throw new Error('Signing keys and credentials cannot be release attachments.');
      if (file.includes('#')) throw new Error('Attachment paths cannot contain # because GitHub CLI uses it to delimit asset labels.');
      if (names.has(name)) throw new Error(`Duplicate attachment name: ${name}`);
      names.add(name);
      return { file, name, size: stat.size };
    });
    const files = await Promise.all(attachments.map(async (attachment) => {
      const hash = createHash('sha256');
      for await (const chunk of fs.createReadStream(attachment.file)) hash.update(chunk);
      return { ...attachment, digest: `sha256:${hash.digest('hex')}` };
    }));
    const env: NodeJS.ProcessEnv = { ...shellEnv, GH_TOKEN: token, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1', NO_COLOR: '1' };
    delete env.GH_DEBUG;
    delete env.GH_FORCE_TTY;
    const tag = options.tag.trim();
    const target = options.target.trim();
    const gh = (command: string, args: string[]) => run(['release', command, tag, '--repo', `github.com/${options.repo}`, ...args], env);
    const view = async (): Promise<ReleaseInfo> => {
      const release = JSON.parse(await gh('view', ['--json', 'tagName,targetCommitish,isDraft,isPrerelease,url,assets']));
      if (release?.tagName !== tag || typeof release.isDraft !== 'boolean' || typeof release.url !== 'string' || !Array.isArray(release.assets)) {
        throw new Error(`GitHub CLI returned invalid release metadata for ${tag}.`);
      }
      return release;
    };
    let release = await view().catch((error: unknown) => {
      if (error instanceof Error && error.message === 'release not found') return undefined;
      throw error;
    });
    const resuming = !!release;
    if (!release) {
      draftUrl = await gh('create', [
        '--draft', '--target', target, '--title', options.name?.trim() || tag, `--notes=${options.body || ''}`,
        ...(options.prerelease ? ['--prerelease'] : []),
      ]);
      release = await view();
    }
    if (!release.isDraft) throw new Error(`Release ${tag} is already published.`);
    draftUrl = release.url;
    if (release.targetCommitish !== target) throw new Error(`Draft ${tag} targets ${release.targetCommitish}, expected ${target}.`);
    if (release.isPrerelease !== !!options.prerelease) throw new Error(`Draft ${tag} has a different prerelease setting.`);

    const existingAssets = release.assets;
    const missing = files.filter((file) => {
      const asset = existingAssets.find((entry) => entry.name === file.name);
      if (!asset) return true;
      if (matchesUpload(asset, file)) return false;
      throw new Error(`Draft ${tag} has a conflicting attachment: ${file.name}. Review or remove it before retrying.`);
    });
    for (const { file } of missing) await gh('upload', [file]);
    if (missing.length) {
      release = await view();
      if (!release.isDraft || release.targetCommitish !== target || release.isPrerelease !== !!options.prerelease) {
        throw new Error(`Draft ${tag} changed during upload. Review it before publishing.`);
      }
      for (const file of files) {
        if (!release.assets.some((asset) => asset.name === file.name && matchesUpload(asset, file))) {
          throw new Error(`GitHub did not confirm the uploaded attachment: ${file.name}.`);
        }
      }
    }
    const edits: string[] = [];
    if (resuming && options.body !== undefined) edits.push(`--notes=${options.body}`);
    if (!options.draft) edits.push('--draft=false');
    const url = edits.length ? await gh('edit', edits) : release.url;
    return { ok: true, message: `${options.draft ? 'Draft saved' : 'Release published'}: ${tag} (${files.length} attachments).`, url };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = token ? raw.split(token).join('[redacted]') : raw;
    return { ok: false, message: `${message}${draftUrl ? ' The draft was retained on GitHub. Review it before retrying.' : ''}`, url: draftUrl };
  }
}
