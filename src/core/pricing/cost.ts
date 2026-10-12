/**
 * Cost math — pure. Pricing is USD per 1M tokens as read live from the
 * provider; unknown pricing means unknown cost (null, never a guess).
 */

export interface ModelPricing {
  input: number;
  output: number;
}

/** USD cost of one turn, or null when counts or pricing are unknown. */
export function messageCost(
  promptTokens: number | undefined,
  completionTokens: number | undefined,
  pricing: ModelPricing | undefined,
): number | null {
  if (promptTokens == null || completionTokens == null || !pricing) return null;
  if (!(pricing.input >= 0) || !(pricing.output >= 0)) return null;
  return (promptTokens * pricing.input + completionTokens * pricing.output) / 1e6;
}

/** Adaptive dollars: $0.0042 stays readable, $12.40 stays short. */
export function formatUSD(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n === 0) return '$0';
  if (n < 0.01) return `$${n.toFixed(4)}`;
  if (n < 1) return `$${n.toFixed(3)}`;
  if (n < 100) return `$${n.toFixed(2)}`;
  return `$${Math.round(n)}`;
}

/** Compact counts: 1200 → 1.2k, 2_500_000 → 2.5M. */
export function formatCount(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  if (n < 1000) return String(Math.round(n));
  if (n < 1e6) return `${(n / 1000).toFixed(n < 10000 ? 1 : 0)}k`;
  return `${(n / 1e6).toFixed(2)}M`;
}

/** Price tags: 3 → 3, 0.14 → 0.14 (no trailing-zero noise). */
export function formatPrice(n: number): string {
  if (!Number.isFinite(n) || n < 0) return '—';
  return String(Math.round(n * 100) / 100);
}

export interface CostTurn {
  role: string;
  promptTokens?: number;
  completionTokens?: number;
  providerId?: string;
  modelId?: string;
}

/**
 * Tool-result text for `cost_snapshot`: what this conversation burned so far,
 * the per-episode budget, and whether the lock is armed. Unknown pricing is
 * reported as unknown turns — spend is a floor, never a claim.
 */
export function buildCostSnapshot(
  turns: CostTurn[],
  pricingOf: (providerId?: string, modelId?: string) => ModelPricing | undefined,
  budgetUsd: number,
  locked: boolean,
): string {
  let spend = 0;
  let counted = 0;
  let unknown = 0;
  for (const m of turns) {
    if (m.role !== 'assistant') continue;
    const c = messageCost(m.promptTokens, m.completionTokens, pricingOf(m.providerId, m.modelId));
    if (c != null) { spend += c; counted++; }
    else unknown++;
  }
  const lines = [
    'Cost snapshot (this conversation):',
    `- spend so far: ${formatUSD(spend)} across ${counted} priced turns${unknown > 0 ? ` (${unknown} turns have unknown pricing and are NOT included)` : ''}`,
    `- per-episode budget: ${formatUSD(budgetUsd)}${locked ? ' — LOCKED: stop the search rather than exceed twice the budget' : ' (advisory: prefer cheaper paths, report overruns)'}`,
  ];
  if (locked) {
    const remaining = budgetUsd - spend;
    lines.push(
      remaining >= 0
        ? `- remaining under lock: ${formatUSD(remaining)}`
        : `- LOCK TRIPPED: overspent by ${formatUSD(-remaining)} — stop iterating and report`,
    );
  }
  return lines.join('\n');
}
