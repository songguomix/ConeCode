import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';
import { registerUpdateIpc } from './ipc';

const mocks = vi.hoisted(() => ({
  handle: vi.fn(), download: vi.fn(), on: vi.fn(), send: vi.fn(), fromPartition: vi.fn(),
}));

vi.mock('electron', () => ({
  app: { getPath: () => '/downloads' },
  BrowserWindow: { getAllWindows: () => [{ isDestroyed: () => false, webContents: { send: mocks.send } }] },
  ipcMain: { handle: mocks.handle },
  session: { fromPartition: mocks.fromPartition },
  net: {}, shell: {},
}));

vi.mock('node:fs', () => ({ default: { mkdirSync: vi.fn(), existsSync: () => false } }));

function downloadItem(urls: string[]) {
  return Object.assign(new EventEmitter(), {
    getURLChain: () => urls,
    getURL: () => urls[urls.length - 1],
    getTotalBytes: () => 128,
    setSavePath: vi.fn(),
  });
}

describe('update download IPC', () => {
  it('uses an isolated session and only adopts the download that started at the requested URL', async () => {
    mocks.fromPartition.mockReturnValue({ on: mocks.on, downloadURL: mocks.download });
    registerUpdateIpc();
    expect(mocks.fromPartition).toHaveBeenCalledWith('conecode-updates', { cache: false });
    const handleDownload = mocks.handle.mock.calls.find(([channel]) => channel === 'update:download')![1];
    const willDownload = mocks.on.mock.calls.find(([event]) => event === 'will-download')![1];

    const initialUrl = 'https://agibase.dev/api/download/release-1';
    const redirected = 'https://release-assets.githubusercontent.com/conecode.dmg';
    await expect(handleDownload({}, 'https://AGIBASE.dev:443/api/download/release-1#release', 'ConeCode.dmg')).resolves.toEqual({ ok: true });
    expect(mocks.download).toHaveBeenCalledWith(initialUrl);

    // A different original URL is rejected even if it redirects to the pending URL.
    const unrelated = downloadItem(['https://agibase.dev/api/download/other', initialUrl]);
    const unrelatedEvent = { preventDefault: vi.fn() };
    willDownload(unrelatedEvent, unrelated);
    expect(unrelatedEvent.preventDefault).toHaveBeenCalledOnce();
    expect(unrelated.setSavePath).not.toHaveBeenCalled();
    expect(mocks.send).not.toHaveBeenCalled();
    await expect(handleDownload({}, initialUrl)).resolves.toEqual({ ok: false, error: 'busy' });

    const expected = downloadItem([initialUrl, redirected]);
    const expectedEvent = { preventDefault: vi.fn() };
    willDownload(expectedEvent, expected);
    expect(expectedEvent.preventDefault).not.toHaveBeenCalled();
    expect(expected.setSavePath).toHaveBeenCalledOnce();
    expect(mocks.send).toHaveBeenCalledWith('update:download-progress', { state: 'downloading', received: 0, total: 128 });
  });
});
