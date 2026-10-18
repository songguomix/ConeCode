import { EventEmitter } from 'node:events';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  spawn: vi.fn(),
  existsSync: vi.fn(),
}));
vi.mock('child_process', () => ({ spawn: mocks.spawn }));
vi.mock('electron', () => ({
  app: { isPackaged: true, getPath: () => '/test/userData', getAppPath: () => '/test/app' },
}));
vi.mock('fs', () => ({
  default: { existsSync: mocks.existsSync, chmodSync: vi.fn(), writeFileSync: vi.fn(), appendFileSync: vi.fn() },
}));
import { startTunnel, stopTunnel } from './tunnel';

afterEach(() => {
  stopTunnel();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.clearAllMocks();
});

describe('packaged cloudflared selection', () => {
  it.each([
    ['darwin', 'arm64', 'cloudflared-darwin-arm64'],
    ['win32', 'x64', 'cloudflared-win-x64.exe'],
    ['linux', 'x64', 'cloudflared-linux-x64'],
  ])('launches the bundled resource on %s %s', (platform, arch, filename) => {
    vi.useFakeTimers();
    vi.stubGlobal('process', { ...process, platform, arch, resourcesPath: '/test/resources' });
    const binary = path.join('/test/resources', 'bin', filename);
    mocks.existsSync.mockImplementation((file: string) => file === binary);
    const child = Object.assign(new EventEmitter(), {
      stdout: new EventEmitter(), stderr: new EventEmitter(), kill: vi.fn(),
    });
    mocks.spawn.mockReturnValue(child);

    void startTunnel(3210, {});

    expect(mocks.spawn).toHaveBeenCalledWith(binary, expect.arrayContaining([
      '--url', 'https://localhost:3210',
    ]), expect.any(Object));
  });
});
