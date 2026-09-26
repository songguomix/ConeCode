import { describe, expect, it } from 'vitest';
import { generate } from 'selfsigned';
import { certFingerprint } from './tls';

describe('certFingerprint', () => {
  it('is a stable 64-char lowercase SHA-256 hex of the DER', async () => {
    const pems = await generate([{ name: 'commonName', value: 'ConeCode Remote' }], {
      keySize: 2048,
      algorithm: 'sha256',
      notAfterDate: new Date(Date.now() + 86400000),
    });
    const fp = certFingerprint(pems.cert);
    expect(fp).toMatch(/^[0-9a-f]{64}$/);
    expect(certFingerprint(pems.cert)).toBe(fp);
  });

  it('differs for different certificates', async () => {
    const a = await generate([{ name: 'commonName', value: 'A' }], { keySize: 2048, algorithm: 'sha256' });
    const b = await generate([{ name: 'commonName', value: 'B' }], { keySize: 2048, algorithm: 'sha256' });
    expect(certFingerprint(a.cert)).not.toBe(certFingerprint(b.cert));
  });
});
