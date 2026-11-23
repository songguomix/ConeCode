import { afterAll, describe, expect, it, vi } from 'vitest';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishGithubRelease } from './githubRelease';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-release-'));
const file = path.join(dir, 'installer.exe');
const linux = path.join(dir, 'installer.AppImage');
fs.writeFileSync(file, 'installer bytes');
fs.writeFileSync(linux, 'Installer bytes');
afterAll(() => {
  for (const attachment of [file, linux]) fs.unlinkSync(attachment);
  fs.rmdirSync(dir);
});
const options = { repo: 'o/r', token: 'secret-test-token', tag: 'v2.4.8', target: 'main', files: [file] };
const url = 'https://github.com/o/r/releases/tag/v2.4.8';
const asset = (file: string) => ({
  name: path.basename(file),
  size: fs.statSync(file).size,
  state: 'uploaded',
  digest: `sha256:${createHash('sha256').update(fs.readFileSync(file)).digest('hex')}`,
});
const draft = (assets: object[] = [], fields: object = {}) => JSON.stringify({
  tagName: options.tag, targetCommitish: options.target, isDraft: true, isPrerelease: false, assets, url, ...fields,
});
const commands = (run: ReturnType<typeof vi.fn>) => run.mock.calls.map(([args]) => args[1]);

describe('GitHub release publishing', () => {
  it('creates a draft and verifies the uploaded files before publishing', async () => {
    const run = vi.fn().mockRejectedValueOnce(new Error('release not found'))
      .mockResolvedValueOnce(url).mockResolvedValueOnce(draft()).mockResolvedValueOnce('')
      .mockResolvedValueOnce(draft([asset(file)])).mockResolvedValueOnce(url);
    expect(await publishGithubRelease(options, run, { GH_HOST: 'git.example.test' })).toMatchObject({ ok: true, url });
    expect(commands(run)).toEqual(['view', 'create', 'view', 'upload', 'view', 'edit']);
    for (const [args] of run.mock.calls) expect(args[args.indexOf('--repo') + 1]).toBe('github.com/o/r');
    expect(run.mock.calls[1][0]).toContain('--draft');
    expect(run.mock.calls[3][0]).toContain(file);
    expect(run.mock.calls[5][0]).toContain('--draft=false');
    expect(run.mock.calls[0][1]).toMatchObject({ GH_TOKEN: options.token, GH_PROMPT_DISABLED: '1' });
    expect(run.mock.calls[0][0]).not.toContain(options.token);
  });

  it('resumes a matching draft, skipping previously uploaded attachments', async () => {
    const run = vi.fn().mockResolvedValueOnce(draft([asset(file)])).mockResolvedValueOnce('')
      .mockResolvedValueOnce(draft([asset(file), asset(linux)])).mockResolvedValueOnce(url);
    expect((await publishGithubRelease({ ...options, files: [file, linux] }, run)).ok).toBe(true);
    expect(commands(run)).toEqual(['view', 'upload', 'view', 'edit']);
    expect(run.mock.calls[1][0]).toContain(linux);
    expect(run.mock.calls[1][0]).not.toContain(file);
  });

  it('writes reviewed notes when resuming a draft', async () => {
    const body = '## Fixes\n- Restore release notes';
    const run = vi.fn().mockResolvedValueOnce(draft([asset(file)])).mockResolvedValueOnce(url);
    expect((await publishGithubRelease({ ...options, body }, run)).ok).toBe(true);
    expect(commands(run)).toEqual(['view', 'edit']);
    expect(run.mock.calls[1][0]).toContain(`--notes=${body}`);
  });

  it('retains a draft after failed upload and redacts credentials', async () => {
    const run = vi.fn().mockResolvedValueOnce(draft()).mockRejectedValueOnce(new Error(`denied ${options.token}`));
    const result = await publishGithubRelease(options, run);
    expect(result).toMatchObject({ ok: false, url });
    expect(result.message).toContain('draft was retained');
    expect(result.message).not.toContain(options.token);
    expect(commands(run)).toEqual(['view', 'upload']);
  });

  it('does not mistake authentication failures for an absent release', async () => {
    const run = vi.fn().mockRejectedValue(new Error('HTTP 401: Bad credentials'));
    expect(await publishGithubRelease(options, run)).toMatchObject({ ok: false, message: 'HTTP 401: Bad credentials' });
    expect(commands(run)).toEqual(['view']);
  });

  it.each([
    draft([], { targetCommitish: 'other' }),
    draft([], { isDraft: false }),
    draft([{ ...asset(file), size: 1 }]),
  ])('leaves incompatible releases or assets intact', async (metadata) => {
    const run = vi.fn().mockResolvedValue(metadata);
    expect((await publishGithubRelease(options, run)).ok).toBe(false);
    expect(commands(run)).toEqual(['view']);
  });

  it.each([asset(linux).digest, null])('refuses to reuse a same-size asset with digest %s', async (digest) => {
    const run = vi.fn().mockResolvedValueOnce(draft([{ ...asset(file), digest }]));
    expect(await publishGithubRelease(options, run)).toMatchObject({ ok: false, url });
    expect(commands(run)).toEqual(['view']);
  });

  it.each([
    draft(),
    draft([{ ...asset(file), digest: asset(linux).digest }]),
  ])('refuses to publish when GitHub does not confirm the attachment content', async (metadata) => {
    const run = vi.fn().mockResolvedValueOnce(draft()).mockResolvedValueOnce('').mockResolvedValueOnce(metadata);
    expect((await publishGithubRelease(options, run)).ok).toBe(false);
    expect(commands(run)).toEqual(['view', 'upload', 'view']);
  });

  it('rejects invalid attachments and credentials before calling gh', async () => {
    const run = vi.fn();
    for (const patch of [{ token: '' }, { repo: 'bad' }, { files: [] }, { files: [file, file] }]) {
      expect((await publishGithubRelease({ ...options, ...patch }, run)).ok).toBe(false);
    }
    expect(run).not.toHaveBeenCalled();
  });

  it('keeps draft releases private when requested', async () => {
    const run = vi.fn().mockResolvedValue(draft([asset(file)]));
    expect((await publishGithubRelease({ ...options, draft: true }, run)).ok).toBe(true);
    expect(commands(run)).toEqual(['view']);
  });
});
