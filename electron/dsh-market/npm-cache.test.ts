import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { npmCacheDir, npmEnv } from './installer';
import { MarketStateStore } from './state';

const dirs: string[] = [];
function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-npm-cache-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  delete process.env.CONECODE_NPM_CACHE;
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('npm cache isolation', () => {
  it('keeps the npm cache inside the app data directory, not the host ~/.npm', () => {
    const state = new MarketStateStore(tempDir());
    expect(npmCacheDir(state)).toBe(path.join(state.cacheDir(), 'npm'));
    expect(npmCacheDir(state).startsWith(state.root)).toBe(true);
  });

  it('honours CONECODE_NPM_CACHE as an absolute operator override', () => {
    const state = new MarketStateStore(tempDir());
    process.env.CONECODE_NPM_CACHE = 'relative/ops-cache';
    expect(npmCacheDir(state)).toBe(path.resolve('relative/ops-cache'));
    process.env.CONECODE_NPM_CACHE = '   ';
    expect(npmCacheDir(state)).toBe(path.join(state.cacheDir(), 'npm'));
  });

  it('passes the cache to the child npm process and keeps output quiet', () => {
    const cache = path.join(tempDir(), 'npm');
    const env = npmEnv(cache);
    expect(env.npm_config_cache).toBe(cache);
    expect(env.npm_config_update_notifier).toBe('false');
    expect(env.npm_config_fund).toBe('false');
    expect(env.npm_config_audit).toBe('false');
    expect(env.PATH).toBe(process.env.PATH);
  });

  it('omits npm_config_cache when no cache dir is known', () => {
    delete process.env.npm_config_cache;
    expect(npmEnv(undefined).npm_config_cache).toBeUndefined();
  });
});
