import { createHash, timingSafeEqual } from 'node:crypto';

/** Constant-time comparison over fixed-length digests (lengths leak otherwise). */
export function safeEqual(a: string, b: string): boolean {
  const digestA = createHash('sha256').update(a, 'utf8').digest();
  const digestB = createHash('sha256').update(b, 'utf8').digest();
  return timingSafeEqual(digestA, digestB);
}
