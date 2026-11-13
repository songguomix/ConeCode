import { describe, expect, it, vi } from 'vitest';
import {
  checkForUpdate,
  compareVersions,
  buildUpdateUrl,
  formatFileSize,
  isAllowedDownloadUrl,
  parseUpdatePayload,
  resolvePlatform,
  toPlainText,
} from './updateClient';

const payload = {
  status: 'ok',
  update_available: true,
  current_version: '2.4.11',
  latest: {
    version: '2.5.0',
    platform: 'macos',
    fileName: 'ConeCode-2.5.0-arm64.dmg',
    fileSize: 118_111_232,
    summary: 'Faster chat, steadier tools',
    changelog: '- **Queue** messages before sending\n- Fix tunnel reconnect',
    changelog_items: ['**Queue** messages before sending', 'Fix tunnel reconnect'],
    notes_html: '<script>alert(1)</script>',
    publishedAtIso: '2026-11-01T00:00:00.000Z',
    downloadUrl: 'https://agibase.dev/api/download/release-1',
  },
};

describe('compareVersions', () => {
  it('orders numeric segments like semver', () => {
    expect(compareVersions('2.5.0', '2.4.11')).toBe(1);
    expect(compareVersions('2.4.11', '2.5.0')).toBe(-1);
    expect(compareVersions('v2.4.11', '2.4.11')).toBe(0);
    expect(compareVersions('2.4', '2.4.0')).toBe(0);
  });

  it('ranks a release above its pre-release', () => {
    expect(compareVersions('2.5.0', '2.5.0-beta.1')).toBe(1);
    expect(compareVersions('2.5.0-beta.1', '2.5.0')).toBe(-1);
  });
});

describe('resolvePlatform', () => {
  it('maps runtime and release labels', () => {
    expect(resolvePlatform('darwin')).toBe('macos');
    expect(resolvePlatform('MacOS')).toBe('macos');
    expect(resolvePlatform('win32')).toBe('windows');
    expect(resolvePlatform('linux')).toBe('linux');
  });
});

describe('buildUpdateUrl', () => {
  it('targets the agibase json endpoint', () => {
    const url = new URL(buildUpdateUrl({ currentVersion: '2.4.11', platform: 'darwin' }));
    expect(url.origin).toBe('https://agibase.dev');
    expect(url.pathname).toBe('/update');
    expect(url.searchParams.get('product')).toBe('conecode');
    expect(url.searchParams.get('platform')).toBe('macos');
    expect(url.searchParams.get('version')).toBe('2.4.11');
    expect(url.searchParams.get('format')).toBe('json');
  });

  it('honours a custom base url, with or without trailing slash', () => {
    const url = new URL(
      buildUpdateUrl({ baseUrl: 'http://127.0.0.1:4599/', currentVersion: '1.0.0', platform: 'linux' }),
    );
    expect(url.origin).toBe('http://127.0.0.1:4599');
    expect(url.pathname).toBe('/update');
  });
});

describe('parseUpdatePayload', () => {
  it('normalizes an update into a safe typed record', () => {
    const result = parseUpdatePayload(payload, '2.4.11');
    expect(result.ok).toBe(true);
    expect(result.status).toBe('ok');
    expect(result.updateAvailable).toBe(true);
    expect(result.latest?.version).toBe('2.5.0');
    expect(result.latest?.downloadUrl).toBe('https://agibase.dev/api/download/release-1');
    expect(result.latest?.fileSizeLabel).toBe('113 MB');
    expect(result.latest?.changelogItems).toEqual(['Queue messages before sending', 'Fix tunnel reconnect']);
    // markdown emphasis must never survive into the renderer
    expect(JSON.stringify(result)).not.toContain('**');
    expect(JSON.stringify(result)).not.toContain('<script>');
  });

  it('reports no_update when the server version is not newer', () => {
    const result = parseUpdatePayload(
      { ...payload, update_available: false, latest: { ...payload.latest, version: '2.4.11' } },
      '2.4.11',
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('no_update');
    expect(result.updateAvailable).toBe(false);
  });

  it('treats a product with no published release as up to date', () => {
    const result = parseUpdatePayload(
      { status: 'no_update', update_available: false, product: { slug: 'conecode' } },
      '2.4.11',
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('no_update');
    expect(result.latest).toBeNull();
  });

  it('never trusts update_available over the version comparison', () => {
    const result = parseUpdatePayload({ ...payload, update_available: true }, '2.6.0');
    expect(result.updateAvailable).toBe(false);
  });

  it('drops download urls from unknown hosts', () => {
    const result = parseUpdatePayload(
      { ...payload, latest: { ...payload.latest, downloadUrl: 'https://evil.example/payload.dmg' } },
      '2.4.11',
    );
    expect(result.latest?.downloadUrl).toBeNull();
  });

  it('prefers the installer for this platform when the server fell back to another OS', () => {
    const result = parseUpdatePayload(
      {
        ...payload,
        latest: { ...payload.latest, platform: 'macos', version: '2.5.0' },
        all_platforms: [
          { platform: 'macos', version: '2.5.0', downloadUrl: 'https://agibase.dev/api/download/mac-1' },
          { platform: 'linux', version: '2.5.1', downloadUrl: 'https://agibase.dev/api/download/linux-1' },
        ],
      },
      '2.4.11',
      'linux',
    );
    expect(result.updateAvailable).toBe(true);
    expect(result.latest?.version).toBe('2.5.1');
    expect(result.latest?.downloadUrl).toBe('https://agibase.dev/api/download/linux-1');
  });

  it('reports up to date when no build exists for this platform', () => {
    const result = parseUpdatePayload(
      {
        ...payload,
        latest: { ...payload.latest, platform: 'macos' },
        all_platforms: [{ platform: 'macos', version: '2.5.0' }],
      },
      '2.4.11',
      'windows',
    );
    expect(result.ok).toBe(true);
    expect(result.status).toBe('no_update');
    expect(result.updateAvailable).toBe(false);
    expect(result.latest).toBeNull();
  });

  it('keeps the release when its platform matches', () => {
    const result = parseUpdatePayload({ ...payload }, '2.4.11', 'macos');
    expect(result.latest?.version).toBe('2.5.0');
    expect(result.updateAvailable).toBe(true);
  });

  it('surfaces server errors', () => {
    const result = parseUpdatePayload({ status: 'error', message: 'database offline' }, '2.4.11');
    expect(result.ok).toBe(false);
    expect(result.status).toBe('error');
    expect(result.errorCode).toBe('server');
    expect(result.detail).toBe('database offline');
  });

  it('rejects payloads without a release', () => {
    expect(parseUpdatePayload(null, '2.4.11').ok).toBe(false);
    expect(parseUpdatePayload({ status: 'ok' }, '2.4.11').ok).toBe(false);
    expect(parseUpdatePayload({ status: 'ok', latest: { version: '' } }, '2.4.11').errorCode).toBe('invalid-json');
  });
});

describe('toPlainText', () => {
  it('strips markup and entities', () => {
    expect(toPlainText('<b>Hello</b> &amp; `world`')).toBe('Hello & world');
    expect(toPlainText('[docs](https://x.dev)')).toBe('docs');
  });
});

describe('formatFileSize / isAllowedDownloadUrl', () => {
  it('formats sizes', () => {
    expect(formatFileSize(512)).toBe('512 B');
    expect(formatFileSize(1024)).toBe('1 KB');
    expect(formatFileSize(1.5 * 1024 * 1024)).toBe('1.5 MB');
    expect(formatFileSize(null)).toBeNull();
  });

  it('only allows https installer hosts', () => {
    expect(isAllowedDownloadUrl('https://agibase.dev/api/download/1')).toBe(true);
    expect(isAllowedDownloadUrl('http://agibase.dev/api/download/1')).toBe(false);
    expect(isAllowedDownloadUrl('https://notagibase.dev/x.dmg')).toBe(false);
    expect(isAllowedDownloadUrl('javascript:alert(1)')).toBe(false);
  });
});

describe('checkForUpdate', () => {
  const base = {
    currentVersion: '2.4.11',
    platform: 'darwin',
    timeoutMs: 50,
  };

  it('returns parsed data on success', async () => {
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify(payload), { status: 200 }));
    const result = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.status).toBe('ok');
    expect(fetchImpl).toHaveBeenCalledOnce();
  });

  it('reports http failures', async () => {
    const fetchImpl = vi.fn(async () => new Response('bad gateway', { status: 502 }));
    const result = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.ok).toBe(false);
    expect(result.errorCode).toBe('http');
    expect(result.detail).toBe('HTTP 502');
  });

  it('reports invalid json without throwing', async () => {
    const fetchImpl = vi.fn(async () => new Response('<html>oops</html>', { status: 200 }));
    const result = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.errorCode).toBe('invalid-json');
  });

  it('reports network errors', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await checkForUpdate({ ...base, fetchImpl: fetchImpl as unknown as typeof fetch });
    expect(result.errorCode).toBe('network');
    expect(result.detail).toBe('fetch failed');
  });

  it('aborts slow requests as timeouts', async () => {
    const fetchImpl = vi.fn(
      (_url: string, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            const error = new Error('aborted');
            error.name = 'AbortError';
            reject(error);
          });
        }),
    );
    const result = await checkForUpdate({
      ...base,
      timeoutMs: 10,
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });
    expect(result.errorCode).toBe('timeout');
  });
});
