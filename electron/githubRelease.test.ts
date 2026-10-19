import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { publishGithubRelease } from './githubRelease';
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-release-'));
const file = path.join(dir, 'installer.exe');
fs.writeFileSync(file, 'installer bytes');
afterEach(() => vi.restoreAllMocks());
afterAll(() => { fs.unlinkSync(file); fs.rmdirSync(dir); });
const options = { repo: 'o/r', token: 'secret-test-token', tag: 'v2.4.8', target: 'main', files: [file] };
const response = (data: object, ok = true, status = 200) => ({ ok, status, json: async () => data }) as Response;
describe('GitHub release publishing', () => {
  it('streams attachments and only publishes after upload completes', async () => {
    const calls: any[] = [];
    const request = vi.fn(async (url: any, init: any) => {
      calls.push({ url, init });
      if (String(url).includes('/assets?')) {
        expect(await new Response(init.body).text()).toBe('installer bytes');
        return response({ id: 2 });
      }
      return response({ id: 1, html_url: 'https://github.com/o/r/releases/tag/v2.4.8' });
    });
    expect((await publishGithubRelease(options, request as any)).ok).toBe(true);
    expect(calls).toHaveLength(3);
    expect(JSON.parse(calls[0].init.body).draft).toBe(true);
    expect(calls[1].url).toContain('uploads.github.com/repos/o/r/releases/1/assets?name=installer.exe');
    expect(JSON.parse(calls[2].init.body)).toEqual({ draft: false });
  });
  it('retains a draft after failed upload and does not publish', async () => {
    const request = vi.fn().mockResolvedValueOnce(response({ id: 1, html_url: 'https://github.com/o/r/releases/1' })).mockResolvedValueOnce(response({ message: 'denied' }, false, 403));
    const result = await publishGithubRelease(options, request);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('draft was retained');
    expect(request).toHaveBeenCalledTimes(2);
  });
  it('rejects invalid attachments and credentials before any network operation', async () => {
    const request = vi.fn();
    for (const patch of [{ token: '' }, { repo: 'bad' }, { files: [] }, { files: [file, file] }]) {
      expect((await publishGithubRelease({ ...options, ...patch }, request)).ok).toBe(false);
    }
    expect(request).not.toHaveBeenCalled();
  });
  it('keeps draft releases private when requested', async () => {
    const request = vi.fn(async (_url: any, init: any) => {
      if (typeof init.body !== 'string') await new Response(init.body).text();
      return response({ id: 1 });
    });
    expect((await publishGithubRelease({ ...options, draft: true }, request as any)).ok).toBe(true);
    expect(request).toHaveBeenCalledTimes(2);
  });
});
