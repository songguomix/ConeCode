import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { X509Certificate, createPrivateKey } from 'crypto';
import { loadRemoteTls } from './tls';

describe('installation-specific remote TLS', () => {
  it('creates matching keys, reuses the identity, and gives different installations different identities', async () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-tls-'));
    try {
      const first = await loadRemoteTls(path.join(directory, 'one'));
      const again = await loadRemoteTls(path.join(directory, 'one'));
      const second = await loadRemoteTls(path.join(directory, 'two'));
      expect(again).toEqual(first);
      expect(second.key).not.toBe(first.key);
      expect(new X509Certificate(first.cert).checkPrivateKey(createPrivateKey(first.key))).toBe(true);
      if (process.platform !== 'win32') {
        expect(fs.statSync(path.join(directory, 'one', 'remote-tls.json')).mode & 0o777).toBe(0o600);
      }
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});
