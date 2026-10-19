import fs from 'node:fs';
import path from 'node:path';
import { Readable } from 'node:stream';

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

/** Build a draft first so a failed attachment never exposes an incomplete release. */
export async function publishGithubRelease(options: ReleaseOptions, request: typeof fetch = fetch): Promise<ReleaseResult> {
  let draftUrl: string | undefined;
  const token = options?.token?.trim();
  try {
    if (!/^[\w.-]+\/[\w.-]+$/.test(options?.repo || '')) throw new Error('Invalid GitHub repository: use owner/repo.');
    if (!token) throw new Error('A GitHub token with Contents: read and write permission is required.');
    if (!options.tag?.trim() || /[\s~^:?*\[\\]/.test(options.tag) || options.tag.startsWith('-') || options.tag.includes('..')) throw new Error('Invalid release tag.');
    if (!options.target?.trim()) throw new Error('A target branch or commit is required.');
    if (!Array.isArray(options.files) || !options.files.length) throw new Error('Select at least one release attachment.');
    const names = new Set<string>();
    const files = options.files.map((file) => {
      if (!path.isAbsolute(file)) throw new Error('Attachment paths must be absolute.');
      const stat = fs.statSync(file);
      if (!stat.isFile() || stat.size === 0 || stat.size >= 2 * 1024 ** 3) throw new Error('Each attachment must be a non-empty file smaller than 2 GiB.');
      const name = path.basename(file);
      if (/\.(pem|key|pfx|p12|env)$/i.test(name)) throw new Error('Signing keys and credentials cannot be release attachments.');
      if (names.has(name)) throw new Error(`Duplicate attachment name: ${name}`);
      names.add(name);
      return { file, name, size: stat.size };
    });
    const base = `https://api.github.com/repos/${options.repo}`;
    const headers = { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'ConeCode' };
    const call = async (url: string, init: RequestInit = {}) => {
      const response = await request(url, { ...init, headers: { ...headers, ...init.headers }, signal: AbortSignal.timeout(10 * 60 * 1000) });
      const data = await response.json();
      if (!response.ok) throw new Error(`GitHub HTTP ${response.status}: ${typeof data.message === 'string' ? data.message : 'request failed'}${response.status === 401 || response.status === 403 ? ' Check token permissions and repository access.' : ''}`);
      return data;
    };
    // Never replace an existing release or its assets implicitly.
    const release = await call(`${base}/releases`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ tag_name: options.tag.trim(), target_commitish: options.target.trim(), name: options.name?.trim() || options.tag.trim(), body: options.body || '', draft: true, prerelease: !!options.prerelease }) });
    if (!Number.isInteger(release.id)) throw new Error('GitHub returned an invalid release ID.');
    draftUrl = typeof release.html_url === 'string' ? release.html_url : undefined;
    for (const file of files) {
      // Stream installers instead of loading hundreds of MB into the renderer/main heap.
      const stream = fs.createReadStream(file.file);
      try {
        await call(`https://uploads.github.com/repos/${options.repo}/releases/${release.id}/assets?name=${encodeURIComponent(file.name)}`, {
          method: 'POST', headers: { 'Content-Type': 'application/octet-stream', 'Content-Length': String(file.size) },
          body: Readable.toWeb(stream) as unknown as BodyInit, duplex: 'half',
        } as RequestInit);
      } finally { stream.destroy(); }
    }
    if (!options.draft) await call(`${base}/releases/${release.id}`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ draft: false }) });
    return { ok: true, message: `${options.draft ? 'Draft saved' : 'Release published'}: ${options.tag} (${files.length} attachments).`, url: draftUrl };
  } catch (error) {
    const raw = error instanceof Error ? error.message : String(error);
    const message = token ? raw.split(token).join('[redacted]') : raw;
    return { ok: false, message: `${message}${draftUrl ? ' Upload incomplete; the draft was retained on GitHub. Review it before retrying.' : ''}`, url: draftUrl };
  }
}
