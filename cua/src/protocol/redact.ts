const SECRET_SUFFIXES = [
  'password', 'passwd', 'secret', 'token', 'apikey', 'authorization', 'cookie',
  'sessionid', 'credential', 'privatekey', 'accesskey', 'refreshtoken', 'accesstoken',
];

function isSecretKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[^a-z0-9]/g, '');
  return SECRET_SUFFIXES.some((suffix) => normalized === suffix || normalized.endsWith(suffix));
}
const VALUE_PATTERNS: Array<[RegExp, string]> = [
  [/\bsk-[A-Za-z0-9_-]{16,}\b/g, 'sk-<redacted>'],
  [/\bBearer\s+[A-Za-z0-9._~+\/-]{12,}=*/gi, 'Bearer <redacted>'],
  [/\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, '<github-token-redacted>'],
  [/\bAKIA[0-9A-Z]{16}\b/g, '<aws-key-redacted>'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}\b/g, '<slack-token-redacted>'],
];

const MAX_STRING = 8_000;
const MAX_DEPTH = 8;

/** Remove secrets before events, checkpoints or API payloads are stored. */
export function redact(value: unknown, depth = 0): unknown {
  if (depth > MAX_DEPTH) return '[redacted: depth]';
  if (typeof value === 'string') return redactString(value);
  if (Array.isArray(value)) return value.slice(0, 500).map((v) => redact(v, depth + 1));
  if (value && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (isSecretKey(key)) {
        out[key] = '[redacted]';
      } else {
        out[key] = redact(v, depth + 1);
      }
    }
    return out;
  }
  if (typeof value === 'number' || typeof value === 'boolean' || value === null || value === undefined) {
    return value;
  }
  return String(value);
}

export function redactString(value: string): string {
  let out = value;
  for (const [pattern, replacement] of VALUE_PATTERNS) out = out.replace(pattern, replacement);
  if (out.length > MAX_STRING) out = `${out.slice(0, MAX_STRING)}…[truncated ${out.length - MAX_STRING} chars]`;
  return out;
}

/** Names (not values) of env vars that look sensitive, for diagnostics. */
export function sensitiveEnvNames(env: NodeJS.ProcessEnv = process.env): string[] {
  return Object.keys(env).filter((k) => isSecretKey(k) && typeof env[k] === 'string' && env[k]!.length > 0);
}
