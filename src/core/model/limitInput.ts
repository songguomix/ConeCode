// Human-friendly model limit input — nobody thinks in raw token counts.
// "128k", "20万", "1m" and "200000" are all valid; K/M presets cover the
// common context windows so most users never type a number at all.

export interface LimitPreset {
  label: string;
  value: number;
}

/** Common context windows, tap-to-fill. */
export const CONTEXT_PRESETS: LimitPreset[] = [
  { label: '8K', value: 8000 },
  { label: '16K', value: 16000 },
  { label: '32K', value: 32000 },
  { label: '64K', value: 64000 },
  { label: '128K', value: 128000 },
  { label: '200K', value: 200000 },
  { label: '256K', value: 256000 },
  { label: '512K', value: 512000 },
  { label: '1M', value: 1000000 },
];

/**
 * Parse a human limit expression into a token count.
 * Accepts a plain number plus an optional unit suffix: k (×1,000),
 * 万/w (×10,000), m (×1,000,000). Case-insensitive; "128 K" and "20万" both
 * work. Returns null when nothing sensible was typed.
 */
export function parseLimitInput(raw: string): number | null {
  const s = String(raw ?? '').trim().toLowerCase();
  if (!s) return null;
  const m = s.match(/^(\d+(?:\.\d+)?)\s*(k|万|w|m)?$/);
  if (!m) return null;
  const n = Number(m[1]);
  if (!Number.isFinite(n) || n <= 0) return null;
  const scale = m[2] === 'k' ? 1e3 : (m[2] === '万' || m[2] === 'w') ? 1e4 : m[2] === 'm' ? 1e6 : 1;
  const value = Math.round(n * scale);
  return value > 0 ? value : null;
}

function trimOneDecimal(x: number): string {
  const s = x.toFixed(1);
  return s.endsWith('.0') ? s.slice(0, -2) : s;
}

/** 128000 → "128K", 1000000 → "1M", 4096 → "4.1K", 999 → "999". */
export function formatLimitTokens(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '—';
  if (n >= 1e6) return `${trimOneDecimal(n / 1e6)}M`;
  if (n >= 1e3) return `${trimOneDecimal(n / 1e3)}K`;
  return String(Math.round(n));
}
