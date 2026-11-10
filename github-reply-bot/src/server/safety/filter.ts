export interface SanitizeOptions {
  maxChars: number;
  maxMentions?: number;
}

export type SanitizeResult =
  | { ok: true; body: string; warnings: string[] }
  | { ok: false; code: 'empty_reply' | 'blocked_sensitive'; reason: string; match?: string };

interface SensitivePattern {
  name: string;
  pattern: RegExp;
}

/** Hard-coded, cannot be disabled through normal settings. */
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { name: 'private_key_block', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws_access_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'credential_assignment',
    pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/i,
  },
];

export function findSensitive(text: string): { name: string; match: string } | null {
  for (const candidate of SENSITIVE_PATTERNS) {
    const match = candidate.pattern.exec(text);
    if (match) return { name: candidate.name, match: match[0].slice(0, 40) };
  }
  return null;
}

const TRUNCATION_MARKER = '\n\n…（内容已截断 / truncated）';

/**
 * Cleans generated text before it is stored as a draft or published:
 * blocks secret-like strings, removes channel-wide mentions, caps mentions
 * and enforces the configured length limit.
 */
export function sanitizeReply(raw: string, options: SanitizeOptions): SanitizeResult {
  const normalized = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!normalized) {
    return { ok: false, code: 'empty_reply', reason: '回复内容为空，拒绝发布' };
  }
  const sensitive = findSensitive(normalized);
  if (sensitive) {
    return {
      ok: false,
      code: 'blocked_sensitive',
      reason: `检测到疑似密钥内容（${sensitive.name}），已阻止发布`,
      match: sensitive.name,
    };
  }

  const warnings: string[] = [];
  let body = normalized.replace(/@(everyone|channel|here)\b/gi, () => {
    warnings.push('mass_mention_removed');
    return '';
  });

  const maxMentions = options.maxMentions ?? 3;
  const seen = new Set<string>();
  body = body.replace(/@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g, (full, handle: string) => {
    const key = handle.toLowerCase();
    if (seen.has(key) || seen.size >= maxMentions) {
      warnings.push('mention_limit_applied');
      return handle;
    }
    seen.add(key);
    return full;
  });

  body = body.replace(/\n{4,}/g, '\n\n\n').trim();
  const maxChars = Math.max(200, options.maxChars || 2000);
  if (body.length > maxChars) {
    warnings.push('truncated');
    const cutAt = Math.max(0, maxChars - TRUNCATION_MARKER.length);
    body = `${body.slice(0, cutAt).trimEnd()}${TRUNCATION_MARKER}`;
  }
  if (!body) {
    return { ok: false, code: 'empty_reply', reason: '清理后回复内容为空，拒绝发布' };
  }
  return { ok: true, body, warnings };
}
