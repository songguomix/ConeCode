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
  if (![promptTokens, completionTokens, pricing.input, pricing.output].every((n) => Number.isFinite(n) && n >= 0)) return null;
  const cost = (promptTokens * pricing.input + completionTokens * pricing.output) / 1e6;
  return Number.isFinite(cost) ? cost : null;
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

export interface CostSnapshotOptions {
  /** Priced conversation spend captured when this execution/episode began. */
  startSpendUsd?: number;
}

/**
 * Tool-result text for `cost_snapshot`: what this conversation burned so far,
 * the per-episode budget, and whether the lock is armed. A captured execution
 * baseline scopes the lock to newly incurred spend. Unknown pricing is
 * reported as unknown turns — spend is a floor, never a claim.
 */
export function buildCostSnapshot(
  turns: CostTurn[],
  pricingOf: (providerId?: string, modelId?: string) => ModelPricing | undefined,
  budgetUsd: number,
  locked: boolean,
  options: CostSnapshotOptions = {},
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
  const baseline = options.startSpendUsd;
  const scoped = baseline !== undefined;
  // A repriced/truncated ledger can fall below the captured baseline. It is
  // not evidence of a free run: keep the uncertainty visible to the caller.
  const executionSpend = scoped
    ? Number.isFinite(baseline) && baseline >= 0 && baseline <= spend ? spend - baseline : null
    : spend;
  if (scoped) lines.push(executionSpend == null
    ? '- execution spend: unknown — the starting spend baseline is invalid or exceeds the current priced ledger'
    : `- execution spend since baseline: ${formatUSD(executionSpend)} (starting spend ${formatUSD(baseline)})`);
  if (locked) {
    const limit = 2 * budgetUsd;
    if (executionSpend == null || !Number.isFinite(executionSpend) || !Number.isFinite(limit) || budgetUsd < 0) {
      lines.push('- lock assessment unavailable: a valid budget and spend baseline are required');
    } else {
      const remaining = limit - executionSpend;
      // Subtracting a conversation baseline can introduce a few ulps (e.g.
      // 2.02 - 2 > 0.02). Do not trip at exactly twice the configured budget.
      const rounding = Number.EPSILON * Math.max(1, spend, baseline ?? 0, limit) * 4;
      lines.push(remaining >= -rounding
        ? `- remaining under lock (2× budget${scoped ? ', this execution' : ''}): ${formatUSD(Math.max(0, remaining))}`
        : `- LOCK TRIPPED: exceeded 2× budget${scoped ? ' in this execution' : ''} by ${formatUSD(-remaining)} — stop iterating and report`);
    }
  }
  return lines.join('\n');
}
