import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGithubReleaseStore } from './githubRelease.store';
import { useMarketStore } from './market.store';
import { usePluginStore } from './plugin.store';
import { useWorkspaceStore } from './workspace.store';
import { runGithubReleaseText, pickInstallerFiles } from './chat.store';

const TOKEN_KEY = 'conecode.pluginToken';

beforeEach(() => {
  vi.restoreAllMocks();
  useGithubReleaseStore.getState().cancel();
  useMarketStore.setState({ repo: 'owner/repo' });
  usePluginStore.setState({ disabled: [] });
  useWorkspaceStore.setState({ rootPath: '/proj' });
  localStorage.setItem(TOKEN_KEY, 'tok-123');
  delete (globalThis as any).window?.electronAPI;
});

describe('pickInstallerFiles', () => {
  const entry = (name: string) => ({ name, path: `/proj/release/${name}`, isDirectory: false });

  it('keeps only installer archives and sorts newest name first', () => {
    const picked = pickInstallerFiles([
      { name: 'win-unpacked', path: '/proj/release/win-unpacked', isDirectory: true },
      entry('latest.yml'),
      entry('ConeCode-2.4.10-arm64.dmg'),
      entry('ConeCode-2.4.10-arm64.dmg.blockmap'),
      entry('ConeCode-2.4.8.exe'),
      entry('ConeCode-2.4.10-x64.AppImage'),
    ]);
    expect(picked).toEqual([
      '/proj/release/ConeCode-2.4.8.exe',
      '/proj/release/ConeCode-2.4.10-x64.AppImage',
      '/proj/release/ConeCode-2.4.10-arm64.dmg',
    ]);
  });
});

describe('runGithubReleaseText', () => {
  it('refuses when the GitHub plugin is disabled', async () => {
    usePluginStore.setState({ disabled: ['github-sync'] });
    const text = await runGithubReleaseText({ tag: 'v1.0.0' });
    expect(text).toContain('plugin is disabled');
    expect(useGithubReleaseStore.getState().pending).toBeNull();
  });

  it('refuses without a configured repository', async () => {
    useMarketStore.setState({ repo: '' });
    const text = await runGithubReleaseText({ tag: 'v1.0.0' });
    expect(text).toContain('no GitHub repository');
  });

  it('refuses without a saved token', async () => {
    localStorage.removeItem(TOKEN_KEY);
    const text = await runGithubReleaseText({ tag: 'v1.0.0' });
    expect(text).toContain('no GitHub token');
  });

  it('refuses without a tag', async () => {
    const text = await runGithubReleaseText({});
    expect(text).toContain('release tag is required');
  });

  it('auto-detects installers in the build output and opens the review dialog', async () => {
    (globalThis as any).window = {
      electronAPI: {
        fs: {
          readDir: vi.fn().mockImplementation((dir: string) =>
            dir.endsWith('/dist')
              ? Promise.reject(new Error('missing'))
              : Promise.resolve([
                  { name: 'app-1.0.0.dmg', path: '/proj/release/app-1.0.0.dmg', isDirectory: false },
                  { name: 'builder-debug.yml', path: '/proj/release/builder-debug.yml', isDirectory: false },
                ])),
        },
      },
    };
    const done = runGithubReleaseText({ tag: 'v1.0.0', notes: 'changes' });
    await vi.waitFor(() => expect(useGithubReleaseStore.getState().pending).not.toBeNull());
    expect(useGithubReleaseStore.getState().pending).toMatchObject({
      repo: 'owner/repo',
      tag: 'v1.0.0',
      name: 'v1.0.0',
      target: 'main',
      files: ['/proj/release/app-1.0.0.dmg'],
    });
    useGithubReleaseStore.getState().cancel();
    expect(await done).toContain('cancelled');
  });

  it('reports when no installer can be found', async () => {
    (globalThis as any).window = {
      electronAPI: { fs: { readDir: vi.fn().mockResolvedValue([{ name: 'notes.txt', path: '/x', isDirectory: false }]) } },
    };
    const text = await runGithubReleaseText({ tag: 'v1.0.0' });
    expect(text).toContain('no installer found');
  });
});

describe('useGithubReleaseStore confirmation', () => {
  it('uploads only after the user confirms, with the saved token', async () => {
    const publish = vi.fn().mockResolvedValue({ ok: true, message: 'Release published: v1.0.0 (1 attachments).', url: 'https://github.com/owner/repo/releases/tag/v1.0.0' });
    (globalThis as any).window = { electronAPI: { git: { publishRelease: publish } } };

    const done = useGithubReleaseStore.getState().request({
      repo: 'owner/repo', tag: 'v1.0.0', name: 'First', notes: 'n', target: 'main', files: ['/p/app.dmg'],
    });
    await vi.waitFor(() => expect(useGithubReleaseStore.getState().pending).not.toBeNull());
    expect(publish).not.toHaveBeenCalled();

    useGithubReleaseStore.getState().confirm();
    const outcome = await done;
    expect(outcome.ok).toBe(true);
    expect(publish).toHaveBeenCalledWith(expect.objectContaining({
      repo: 'owner/repo', tag: 'v1.0.0', token: 'tok-123', files: ['/p/app.dmg'],
    }));
    expect(useGithubReleaseStore.getState().pending).toBeNull();
  });

  it('resolves a token error without calling the API', async () => {
    const publish = vi.fn();
    (globalThis as any).window = { electronAPI: { git: { publishRelease: publish } } };
    localStorage.removeItem(TOKEN_KEY);

    const done = useGithubReleaseStore.getState().request({
      repo: 'owner/repo', tag: 'v1.0.0', files: ['/p/app.dmg'],
    });
    await vi.waitFor(() => expect(useGithubReleaseStore.getState().pending).not.toBeNull());
    useGithubReleaseStore.getState().confirm();
    const outcome = await done;
    expect(outcome.ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('does not publish on cancellation', async () => {
    const publish = vi.fn();
    (globalThis as any).window = { electronAPI: { git: { publishRelease: publish } } };
    const done = useGithubReleaseStore.getState().request({
      repo: 'owner/repo', tag: 'v1.0.0', files: ['/p/app.dmg'],
    });
    await vi.waitFor(() => expect(useGithubReleaseStore.getState().pending).not.toBeNull());
    useGithubReleaseStore.getState().cancel();
    const outcome = await done;
    expect(outcome.ok).toBe(false);
    expect(publish).not.toHaveBeenCalled();
  });

  it('rejects a second request while one is pending', async () => {
    useGithubReleaseStore.setState({
      pending: { repo: 'o/r', tag: 'v1', name: 'v1', notes: '', target: 'main', files: [], draft: false, prerelease: false },
    });
    const outcome = await useGithubReleaseStore.getState().request({
      repo: 'o/r', tag: 'v2', files: [],
    });
    expect(outcome.ok).toBe(false);
    expect(outcome.message).toContain('awaiting confirmation');
  });
});
