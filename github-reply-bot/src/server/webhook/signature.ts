import { createHmac } from 'node:crypto';
import { safeEqual } from '../util/crypto';

export function computeSignature(secret: string, rawBody: Buffer | string): string {
  return `sha256=${createHmac('sha256', secret).update(rawBody).digest('hex')}`;
}

/** GitHub sends `X-Hub-Signature-256: sha256=<hex hmac>`. */
export function verifySignature(
  secret: string | null | undefined,
  rawBody: Buffer | string | undefined,
  signature: string | string[] | undefined
): boolean {
  if (!secret || !rawBody) return false;
  const header = Array.isArray(signature) ? signature[0] : signature;
  if (!header || typeof header !== 'string') return false;
  const trimmed = header.trim();
  if (!/^sha256=[0-9a-f]{64}$/i.test(trimmed)) return false;
  return safeEqual(trimmed.toLowerCase(), computeSignature(secret, rawBody));
}
