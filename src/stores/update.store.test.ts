import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateCheckResult, UpdateDownloadProgress } from '../core/updates/updateClient';
import { useUpdateStore } from './update.store';

function okResult(version: string, currentVersion = '2.4.11'): UpdateCheckResult {
  return {
    ok: true,
    status: 'ok',
    updateAvailable: true,
    currentVersion,
    latest: {
      version,
      platform: 'macos',
      fileName: `ConeCode-${version}.dmg`,
      fileSize: 1000,
      fileSizeLabel: '1000 B',
      sha256: null,
      summary: 'Notes',
      changelogItems: ['Fix A'],
      publishedAt: '2026-11-01T00:00:00.000Z',
      downloadUrl: 'https://agibase.dev/api/download/release-1',
    },
  };
}

function noUpdateResult(currentVersion = '2.4.11'): UpdateCheckResult {
  return { ...okResult('2.4.11', currentVersion), status: 'no_update', updateAvailable: false };
}

function installBridge() {
  let progress: ((p: UpdateDownloadProgress) => void) | null = null;
  const bridge = {
    check: vi.fn(async (): Promise<UpdateCheckResult> => noUpdateResult()),
    download: vi.fn(async (_url: string, _fileName?: string) => ({ ok: true }) as { ok: boolean; error?: string }),
    reveal: vi.fn(async (_path: string) => true),
    onProgress: vi.fn((callback: (p: UpdateDownloadProgress) => void) => {
      progress = callback;
      return () => {};
    }),
  };
  (globalThis as unknown as { window: unknown }).window = {
    electronAPI: { update: bridge, app: { getVersion: async () => '2.4.11' } },
  };
  return { bridge, emit: (value: UpdateDownloadProgress) => progress?.(value) };
}

function resetStore() {
  localStorage.clear();
  useUpdateStore.setState({
    initialized: false,
    checking: false,
    appVersion: null,
    result: null,
    errorCode: null,
    detail: null,
    lastCheckedAt: null,
    dialogOpen: false,
    dismissedVersion: null,
    download: null,
    downloadStarting: false,
    downloadError: null,
  });
}

describe('update store', () => {
  beforeEach(() => {
    resetStore();
  });

  it('pops the dialog when a newer release is found', async () => {
    const { bridge } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));

    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(bridge.check).toHaveBeenCalledOnce();
    expect(state.dialogOpen).toBe(true);
    expect(state.result?.latest?.version).toBe('2.5.0');
  });

  it('keeps quiet when the app is up to date', async () => {
    installBridge();
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it('moves a dismissed offer into Settings instead of dropping it', async () => {
    const { bridge } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();

    useUpdateStore.getState().dismissDialog();

    const state = useUpdateStore.getState();
    expect(state.dialogOpen).toBe(false);
    // Settings still shows the pending update…
    expect(state.result?.updateAvailable).toBe(true);
    // …and the same version will not pop up again.
    expect(state.dismissedVersion).toBe('2.5.0');
    expect(localStorage.getItem('conecode.update.dismissedVersion')).toBe('2.5.0');
  });

  it('does not re-open a dismissed version after a restart', async () => {
    const { bridge } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();
    useUpdateStore.getState().dismissDialog();

    // Simulate a fresh launch: state resets, localStorage (dismissal) survives.
    const dismissed = localStorage.getItem('conecode.update.dismissedVersion');
    useUpdateStore.setState({
      initialized: false,
      result: null,
      dialogOpen: false,
      dismissedVersion: dismissed,
      lastCheckedAt: null,
    });

    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().dialogOpen).toBe(false);
  });

  it('pops again when an even newer version ships', async () => {
    const { bridge } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();
    useUpdateStore.getState().dismissDialog();

    bridge.check.mockResolvedValueOnce(okResult('2.6.0'));
    await useUpdateStore.getState().check();
    expect(useUpdateStore.getState().dialogOpen).toBe(true);
  });

  it('surfaces check failures without opening the dialog', async () => {
    const { bridge } = installBridge();
    bridge.check.mockResolvedValueOnce({
      ok: false,
      status: 'error',
      updateAvailable: false,
      currentVersion: '2.4.11',
      latest: null,
      errorCode: 'http',
      detail: 'HTTP 502',
    });

    await useUpdateStore.getState().check();

    const state = useUpdateStore.getState();
    expect(state.dialogOpen).toBe(false);
    expect(state.errorCode).toBe('http');
    expect(state.checking).toBe(false);
  });

  it('throttles automatic checks but not manual ones', async () => {
    const { bridge } = installBridge();
    await useUpdateStore.getState().check({ auto: true });
    await useUpdateStore.getState().check({ auto: true });
    expect(bridge.check).toHaveBeenCalledTimes(1);

    await useUpdateStore.getState().check();
    expect(bridge.check).toHaveBeenCalledTimes(2);
  });

  it('downloads the installer and tracks progress', async () => {
    const { bridge, emit } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();

    await useUpdateStore.getState().startDownload();
    expect(bridge.download).toHaveBeenCalledWith(
      'https://agibase.dev/api/download/release-1',
      'ConeCode-2.5.0.dmg',
    );

    emit({ state: 'downloading', received: 50, total: 100 });
    expect(useUpdateStore.getState().download).toEqual({ state: 'downloading', received: 50, total: 100 });

    emit({ state: 'completed', received: 100, total: 100, path: '/tmp/ConeCode-2.5.0.dmg' });
    expect(useUpdateStore.getState().download).toEqual({
      state: 'completed',
      received: 100,
      total: 100,
      path: '/tmp/ConeCode-2.5.0.dmg',
    });

    await useUpdateStore.getState().reveal();
    expect(bridge.reveal).toHaveBeenCalledWith('/tmp/ConeCode-2.5.0.dmg');
  });

  it('reports blocked downloads', async () => {
    const { bridge } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();
    bridge.download.mockResolvedValueOnce({ ok: false, error: 'blocked' });

    await useUpdateStore.getState().startDownload();
    expect(useUpdateStore.getState().downloadError).toBe('blocked');
    expect(useUpdateStore.getState().downloadStarting).toBe(false);
  });

  it('does not carry download progress onto a newer release', async () => {
    const { bridge, emit } = installBridge();
    bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
    await useUpdateStore.getState().check();
    await useUpdateStore.getState().startDownload();
    emit({ state: 'completed', received: 1000, total: 1000, path: '/tmp/ConeCode-2.5.0.dmg' });
    expect(useUpdateStore.getState().download?.state).toBe('completed');

    bridge.check.mockResolvedValueOnce(okResult('2.6.0'));
    await useUpdateStore.getState().check();

    expect(useUpdateStore.getState().download).toBeNull();
    expect(useUpdateStore.getState().result?.latest?.version).toBe('2.6.0');
  });

  it('fails visibly when Chromium never starts the transfer', async () => {
    vi.useFakeTimers();
    try {
      const { bridge } = installBridge();
      bridge.check.mockResolvedValueOnce(okResult('2.5.0'));
      await useUpdateStore.getState().check();
      await useUpdateStore.getState().startDownload();
      expect(useUpdateStore.getState().download?.state).toBe('downloading');

      await vi.advanceTimersByTimeAsync(26_000);

      const state = useUpdateStore.getState();
      expect(state.download).toBeNull();
      expect(state.downloadError).toBe('failed');
      expect(state.downloadStarting).toBe(false);
    } finally {
      vi.useRealTimers();
    }
  });
});
