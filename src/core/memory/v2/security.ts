// Security boundaries for cloud memory.
//
// The three layers are DIFFERENT things and the UI must not conflate them:
//   1. transport encryption  — TLS in transit (always required for non-loopback)
//   2. server-at-rest        — the server operator encrypts its disks/database
//   3. end-to-end (E2E)      — the client encrypts content; the server cannot read it
//
// Consequence, stated plainly: under E2E the server CANNOT perform plaintext
// full-text or semantic search. So in E2E mode cloud search is disabled and the
// engine searches the locally decrypted cache instead. This module provides the
// AES-GCM envelope used to make that statement true rather than aspirational.

import type { CloudConfig, MemoryRecord } from './types';
import { maskSecret } from './model';

export interface SecuritySummary {
  transport: string;
  serverAtRest: string;
  endToEnd: string;
  cloudSearchAvailable: boolean;
  warnings: string[];
}

export function securitySummary(config: CloudConfig): SecuritySummary {
  const warnings: string[] = [];
  const e2e = config.encryption === 'e2e';
  const drive = config.provider === 'google-drive';
  if (e2e) {
    if (!config.e2ePassphrase) warnings.push('E2E selected but no client passphrase is set — nothing will be encrypted.');
    warnings.push('Under E2E the cloud cannot read memory text; cloud-side full-text/semantic search is disabled and local decrypted search is used instead.');
  }
  if (!config.enabled) warnings.push('Cloud sync is disabled.');
  if (drive) {
    if (!config.googleClientId) warnings.push('Google OAuth client id is not set. Use the deployment environment variables or enter one in Advanced.');
  } else {
    if (!config.baseUrl) warnings.push('No cloud endpoint configured — no connection has been established.');
    if (!config.authToken) warnings.push('No authentication token configured.');
    if (config.tlsOnly && /^http:\/\//i.test(config.baseUrl) && !isLoopback(config.baseUrl)) {
      warnings.push('Plain HTTP to a non-loopback host is refused while TLS-only is on.');
    }
  }
  return {
    transport: drive
      ? 'Google Drive API over HTTPS (OAuth 2.0, loopback PKCE flow)'
      : config.tlsOnly ? 'TLS required (loopback HTTP allowed for local development only)' : 'TLS enforcement OFF — not recommended',
    serverAtRest: drive
      ? 'Google-managed Drive encryption at rest. The client never sees Google’s keys.'
      : 'Not controlled by this client. Must be provided by the server deployment (database/disk encryption).',
    endToEnd: e2e
      ? (config.e2ePassphrase ? 'AES-256-GCM, client-side key derived with PBKDF2; the provider sees ciphertext only' : 'NOT ACTIVE — passphrase missing')
      : drive
        ? 'Disabled. Google Drive can read plaintext stored in the appDataFolder.'
        : 'Disabled. The server can read memory plaintext (needed for server-side search).',
    cloudSearchAvailable: !e2e,
    warnings,
  };
}

export function isLoopback(url: string): boolean {
  try {
    const host = new URL(url).hostname;
    return host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '[::1]';
  } catch { return false; }
}

export function validateCloudTransport(config: CloudConfig): { ok: boolean; error?: string } {
  // Google Drive uses the OAuth/Drive API, not the REST gateway URL.
  if (config.provider === 'google-drive') return { ok: true };
  if (!config.baseUrl) return { ok: false, error: 'Cloud endpoint is not configured' };
  let url: URL;
  try { url = new URL(config.baseUrl); } catch { return { ok: false, error: 'Cloud endpoint is not a valid URL' }; }
  if (url.protocol === 'http:' && config.tlsOnly && !isLoopback(config.baseUrl)) {
    return { ok: false, error: 'TLS-only is on: plain HTTP is refused for non-loopback hosts' };
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    return { ok: false, error: 'Only http(s) endpoints are supported' };
  }
  if (!config.authToken) return { ok: false, error: 'Authentication token is required' };
  if (config.encryption === 'e2e' && !config.e2ePassphrase) {
    return { ok: false, error: 'E2E requires a client-side passphrase' };
  }
  return { ok: true };
}

/** Logs must never contain raw tokens or memory bodies. */
export function safeLog(label: string, config: CloudConfig, detail?: string): string {
  return `[memory2] ${label} endpoint=${config.baseUrl || '(none)'} tenant=${config.tenantId} token=${maskSecret(config.authToken)}${detail ? ` ${detail}` : ''}`;
}

// ---- E2E envelope (Web Crypto; available in Electron renderer and Node 22+) ---

const SALT = new TextEncoder().encode('conecode-memory2-e2e-v1');
const enc = new TextEncoder();
const dec = new TextDecoder();

function toB64(bytes: Uint8Array): string {
  let s = '';
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
}
function fromB64(text: string): Uint8Array {
  const s = atob(text);
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

const keyCache = new Map<string, Promise<CryptoKey>>();

/**
 * PBKDF2 at 120k iterations is deliberately expensive; deriving it once per
 * record would make a 200-change sync unusably slow. Cache the derived key for
 * the process lifetime, keyed by passphrase (never persisted or logged).
 */
function keyFor(passphrase: string): Promise<CryptoKey> {
  const cached = keyCache.get(passphrase);
  if (cached) return cached;
  const derived = (async () => {
    const material = await crypto.subtle.importKey('raw', enc.encode(passphrase), 'PBKDF2', false, ['deriveKey']);
    return crypto.subtle.deriveKey(
      { name: 'PBKDF2', salt: SALT, iterations: 120_000, hash: 'SHA-256' },
      material,
      { name: 'AES-GCM', length: 256 },
      false,
      ['encrypt', 'decrypt'],
    );
  })();
  keyCache.set(passphrase, derived);
  // A failed derivation must not poison the cache forever.
  derived.catch(() => keyCache.delete(passphrase));
  return derived;
}

export async function encryptText(plain: string, passphrase: string): Promise<string> {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, await keyFor(passphrase), enc.encode(plain));
  return `e2e:v1:${toB64(iv)}:${toB64(new Uint8Array(cipher))}`;
}

export async function decryptText(payload: string, passphrase: string): Promise<string> {
  const parts = payload.split(':');
  if (parts.length !== 4 || parts[0] !== 'e2e' || parts[1] !== 'v1') throw new Error('not an E2E payload');
  const plain = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: fromB64(parts[2]) as unknown as BufferSource },
    await keyFor(passphrase),
    fromB64(parts[3]) as unknown as BufferSource,
  );
  return dec.decode(plain);
}

/** Only human-readable fields are encrypted; sync metadata stays readable. */
export async function encryptRecord(record: MemoryRecord, passphrase: string): Promise<MemoryRecord> {
  if (!passphrase) throw new Error('E2E passphrase is missing');
  const payload = JSON.stringify({
    title: record.title, content: record.content, why: record.why, tags: record.tags,
    sourceSessionId: record.sourceSessionId, sourceEventId: record.sourceEventId,
  });
  return {
    ...record,
    title: '[encrypted]',
    content: await encryptText(payload, passphrase),
    why: undefined,
    tags: ['e2e'],
    sourceSessionId: undefined,
    sourceEventId: undefined,
  };
}

export async function decryptRecord(record: MemoryRecord, passphrase: string): Promise<MemoryRecord> {
  if (!record.content.startsWith('e2e:v1:')) return record;
  const payload = JSON.parse(await decryptText(record.content, passphrase));
  return {
    ...record,
    title: payload.title,
    content: payload.content,
    why: payload.why,
    tags: payload.tags,
    sourceSessionId: payload.sourceSessionId,
    sourceEventId: payload.sourceEventId,
  };
}
