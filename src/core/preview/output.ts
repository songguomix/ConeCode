import type { PreviewLogEntry } from '../../stores/preview.store';

export function outputErrors(logs: PreviewLogEntry[]): string[] {
  return [...new Set(logs.filter((entry) => entry.level === 'error'
    || (entry.level !== 'warn' && /\b(?:error|exception|failed|fatal)\b|报错|错误/i.test(entry.data)))
    .map((entry) => entry.data.replace(/\x1b\[[0-9;]*m/g, '').trim())
    .filter(Boolean))];
}

export function errorPrompt(intro: string, errors: string[], logs: PreviewLogEntry[]): string {
  // Bound diagnostic context so a noisy dev server cannot fill the composer.
  const details = errors.join('\n\n').slice(-6000);
  const context = logs.slice(-30).map((entry) => `[${entry.stream}] ${entry.data}`).join('\n').slice(-6000);
  return `${intro}\n\n${details}\n\n---\n${context}`;
}
