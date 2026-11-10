import { describe, expect, it } from 'vitest';
import { computeSignature, verifySignature } from '../src/server/webhook/signature';

const secret = 'top-secret';
const body = Buffer.from(JSON.stringify({ hello: 'world' }));

describe('webhook signature', () => {
  it('computes a sha256 HMAC in GitHub header format', () => {
    expect(computeSignature(secret, body)).toMatch(/^sha256=[0-9a-f]{64}$/);
  });

  it('accepts a valid signature', () => {
    expect(verifySignature(secret, body, computeSignature(secret, body))).toBe(true);
  });

  it('rejects a wrong secret', () => {
    const signature = computeSignature('other-secret', body);
    expect(verifySignature(secret, body, signature)).toBe(false);
  });

  it('rejects a tampered body', () => {
    const signature = computeSignature(secret, body);
    expect(verifySignature(secret, Buffer.from('{"hello":"evil"}'), signature)).toBe(false);
  });

  it('rejects missing or malformed signatures', () => {
    expect(verifySignature(secret, body, undefined)).toBe(false);
    expect(verifySignature(secret, body, '')).toBe(false);
    expect(verifySignature(secret, body, 'sha1=abcdef')).toBe(false);
    expect(verifySignature(secret, body, 'sha256=nothex')).toBe(false);
    expect(verifySignature(null, body, computeSignature(secret, body))).toBe(false);
    expect(verifySignature(secret, undefined, computeSignature(secret, body))).toBe(false);
  });
});
