/** Only explicit phase markers are evidence of progress. Generic words such as
 * "iteration" or "accept" also occur in plans and must not imply completion. */
export function detectRsiPhase(text: string): number {
  let phase = 0;
  const stages: Record<string, number> = { '0': 1, a: 2, b: 3, c: 3, d: 3, e: 4, f: 4, g: 5, h: 5 };
  const markers = /\bphase\s+([0a-h])\b|\b(?:stage|step)\s+([1-5])\b|第\s*([1-5])\s*阶段/gi;
  for (const match of text.matchAll(markers)) {
    phase = match[1] ? stages[match[1].toLowerCase()] : Number(match[2] ?? match[3]);
  }
  return phase;
}

export function formatRsiDuration(seconds: number): string {
  const total = Number.isFinite(seconds) ? Math.max(0, Math.floor(seconds)) : 0;
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60).toString().padStart(2, '0');
  const s = (total % 60).toString().padStart(2, '0');
  return h > 0 ? `${h}:${m}:${s}` : `${m}:${s}`;
}

export function rsiStatusLabel(status?: string): string {
  if (status === 'running') return 'rsiRunning';
  if (status === 'failed') return 'rsiConvStatusFailed';
  if (status === 'completed') return 'rsiConvStatusCompleted';
  if (status === 'stopped') return 'rsiStopped';
  return 'rsiIdle';
}
