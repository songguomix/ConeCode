import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../stores/theme.store', () => ({ useThemeStore: vi.fn() }));

vi.mock('../../stores', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores')>();
  // SSR uses Zustand's initial snapshot. Read the arranged state directly so
  // these render regressions exercise the real selectors without a browser.
  const snapshot = (store: any) =>
    Object.assign(
      ((selector?: any) => (selector ? selector(store.getState()) : store.getState())) as any,
      store,
    );
  return {
    ...actual,
    useLanguageStore: snapshot(actual.useLanguageStore),
    useUpdateStore: snapshot(actual.useUpdateStore),
  };
});

import UpdateDialog from './UpdateDialog';
import { useLanguageStore, useUpdateStore } from '../../stores';
import type { UpdateCheckResult } from '../../core/updates/updateClient';

function pendingUpdate(overrides: Partial<NonNullable<UpdateCheckResult['latest']>> = {}): UpdateCheckResult {
  return {
    ok: true,
    status: 'ok',
    updateAvailable: true,
    currentVersion: '2.4.11',
    latest: {
      version: '2.5.0',
      platform: 'macos',
      fileName: 'ConeCode-2.5.0.dmg',
      fileSize: 1024 * 1024,
      fileSizeLabel: '1 MB',
      sha256: null,
      summary: 'Faster chat',
      changelogItems: ['Queue messages before sending', 'Fix tunnel reconnect'],
      publishedAt: '2026-11-01T00:00:00.000Z',
      downloadUrl: 'https://agibase.dev/api/download/release-1',
      ...overrides,
    },
  };
}

function arrange(result: UpdateCheckResult | null, dialogOpen = true) {
  useLanguageStore.getState().setLocale('en');
  useUpdateStore.setState({ result, dialogOpen, download: null, downloadStarting: false, downloadError: null });
}

describe('UpdateDialog', () => {
  afterEach(() => {
    useUpdateStore.setState({ result: null, dialogOpen: false, download: null, downloadError: null });
  });

  it('renders the new version, current version and release notes', () => {
    arrange(pendingUpdate());
    const html = renderToStaticMarkup(<UpdateDialog />);

    expect(html).toContain('New version available');
    expect(html).toContain('2.5.0');
    expect(html).toContain('2.4.11');
    expect(html).toContain('Queue messages before sending');
    expect(html).toContain('Download update');
    expect(html).toContain('Later');
    // offer moves to Settings when closed
    expect(html.toLowerCase()).not.toContain('<script');
  });

  it('stays hidden while closed', () => {
    arrange(pendingUpdate(), false);
    expect(renderToStaticMarkup(<UpdateDialog />)).toBe('');
  });

  it('renders nothing without a release', () => {
    arrange(null);
    expect(renderToStaticMarkup(<UpdateDialog />)).toBe('');
  });

  it('shows download progress instead of a second download button', () => {
    arrange(pendingUpdate());
    useUpdateStore.setState({ download: { state: 'downloading', received: 512 * 1024, total: 1024 * 1024 } });
    const html = renderToStaticMarkup(<UpdateDialog />);

    expect(html).toContain('role="progressbar"');
    expect(html).toContain('50%');
    expect(html).toContain('disabled');
  });

  it('offers to reveal the installer once downloaded', () => {
    arrange(pendingUpdate());
    useUpdateStore.setState({
      download: { state: 'completed', received: 1024 * 1024, total: 1024 * 1024, path: '/tmp/ConeCode-2.5.0.dmg' },
    });
    const html = renderToStaticMarkup(<UpdateDialog />);

    expect(html).toContain('Show in folder');
    expect(html).toContain('Download complete');
  });

  it('surfaces download failures', () => {
    arrange(pendingUpdate());
    useUpdateStore.setState({ downloadError: 'blocked' });
    const html = renderToStaticMarkup(<UpdateDialog />);

    expect(html).toContain('not trusted');
  });
});
