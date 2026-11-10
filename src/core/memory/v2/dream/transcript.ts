import type { DreamSession } from './types';
import { redactSecrets } from './wiki';

const MAX_MESSAGE_CHARS = 4000;
const MAX_TRANSCRIPT_CHARS = 24000;

/** Mirrors the cookbook's plain-text session export, bounded for cost control. */
export function formatTranscript(session: DreamSession, maxChars = MAX_TRANSCRIPT_CHARS): string {
  const header = [
    `=== SESSION ${session.id} ===`,
    `Title: ${redactSecrets(session.title || '(untitled)')}`,
    `Updated: ${new Date(session.updatedAt).toISOString()}`,
    '',
  ].join('\n');
  const parts = [header];
  let used = header.length;

  for (const message of session.messages) {
    if (message.role === 'system') continue;
    const content = redactSecrets(String(message.content ?? '').trim());
    if (!content) continue;
    const label =
      message.role === 'tool'
        ? `[tool${message.toolName ? `:${message.toolName}` : ''}]`
        : `[${message.role}]`;
    const calls =
      message.toolCalls && message.toolCalls.length > 0
        ? `\n[calls] ${redactSecrets(message.toolCalls.join(' | ')).slice(0, 800)}`
        : '';
    const block = `${label}${calls}\n${content.slice(0, MAX_MESSAGE_CHARS)}\n`;
    if (used + block.length > maxChars) {
      parts.push('[transcript truncated]');
      break;
    }
    parts.push(block);
    used += block.length;
  }
  return parts.join('\n');
}

/** Only idle, substantive sessions are worth a dream pass. */
export function isDreamEligible(session: DreamSession, now: number, minIdleMs: number): boolean {
  if (!session.id || !Array.isArray(session.messages)) return false;
  if (now - session.updatedAt < minIdleMs) return false;
  const roles = new Set(session.messages.map((message) => message.role));
  if (!roles.has('user') || !roles.has('assistant')) return false;
  return session.messages.filter((message) => message.role === 'user').length >= 1;
}
