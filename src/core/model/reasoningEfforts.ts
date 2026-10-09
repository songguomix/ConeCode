import type { ReasoningEffort } from '../../types';

/** Canonical order — drives slider layout and nearest-level clamping. */
export const EFFORT_ORDER: readonly ReasoningEffort[] = ['auto', 'low', 'medium', 'high'];

// Providers spell the same four levels many ways (OpenAI `minimal`,
// OpenRouter `xhigh`, Grok's `low/high`, verbose `extra_high`…). Anything
// outside these aliases is deliberately ignored rather than guessed at.
const ALIASES: Record<string, ReasoningEffort> = {
  auto: 'auto',
  // low family
  low: 'low', l: 'low', minimal: 'low', minimum: 'low', quick: 'low',
  fast: 'low', short: 'low', lite: 'low',
  // medium family
  medium: 'medium', m: 'medium', moderate: 'medium', balanced: 'medium',
  normal: 'medium', standard: 'medium', default: 'medium',
  // high family
  high: 'high', h: 'high', max: 'high', maximum: 'high', xhigh: 'high',
  'extra-high': 'high', 'extra_high': 'high', 'extra high': 'high',
  extended: 'high', deep: 'high', pro: 'high', ultra: 'high',
};

/**
 * Map one provider spelling of an effort level onto our four-level union.
 * Returns null for anything unrecognized (`none`, numbers, objects), so a
 * value we can't map never silently becomes a level the model doesn't have.
 */
export function normalizeEffort(raw: unknown): ReasoningEffort | null {
  if (typeof raw !== 'string') return null;
  return ALIASES[raw.trim().toLowerCase()] ?? null;
}

/**
 * Read the effort levels a provider declares for a model, from whichever
 * shape it uses:
 *
 *   - `reasoning_efforts: ['low','medium','high']`
 *   - `reasoning: { efforts: ['minimal','high'] }`
 *   - `supported_parameters: ['reasoning_effort:low', …]`
 *
 * Returns the levels in canonical order (deduped), or `undefined` when the
 * metadata says nothing — callers treat `undefined` as "show the full set"
 * rather than "the model has no levels", because most /models endpoints
 * simply omit this field.
 */
export function detectReasoningEfforts(modelData?: any): ReasoningEffort[] | undefined {
  if (!modelData) return undefined;
  const found = new Set<ReasoningEffort>();
  const walk = (v: unknown): void => {
    if (Array.isArray(v)) { v.forEach(walk); return; }
    const n = normalizeEffort(v);
    if (n) found.add(n);
  };

  walk(modelData.reasoning_efforts);
  walk(modelData.reasoningEfforts);
  walk(modelData.supported_efforts);
  walk(modelData.efforts);
  walk(modelData.reasoning?.efforts);
  walk(modelData.reasoning?.supported_efforts);
  walk(modelData.reasoning?.effort_levels);
  walk(modelData.reasoning?.effort);
  walk(modelData.reasoning_effort);
  walk(modelData.reasoning_effort?.enum); // JSON-schema style { enum: [...] }
  walk(modelData.capabilities?.reasoning_efforts);

  // `supported_parameters` entries may carry the levels after a separator:
  // `reasoning_effort:low`, `thinking.effort:low|medium|high`, …
  const params = modelData.supported_parameters;
  if (Array.isArray(params)) {
    for (const p of params) {
      const m = /^(?:reasoning|thinking)[ _.:-]?effort[:=](.+)$/.exec(String(p).toLowerCase());
      if (m) m[1].split(/[:|,/ ]+/).forEach((part) => walk(part));
    }
  }

  if (found.size === 0) return undefined;
  return EFFORT_ORDER.filter((e) => found.has(e));
}
