import type { ReasoningEffort } from '../../types';

type Concrete = 'low' | 'medium' | 'high';

// auto sits before low so `indexOf` distance ordering stays intuitive.
const CONCRETE_ORDER: readonly Concrete[] = ['low', 'medium', 'high'];

/**
 * Clamp a concrete effort to the levels a model actually declares. Picks the
 * nearest level by intensity; ties fall to the cheaper one. Levels the model
 * doesn't declare (or an all-`auto` list) leave the value untouched — better
 * to send a level the provider may ignore than one it rejects.
 */
export function clampEffort(resolved: Concrete, allowed?: readonly ReasoningEffort[]): Concrete {
  if (!allowed) return resolved;
  const concrete = allowed
    .filter((e): e is Concrete => e !== 'auto')
    .sort((a, b) => CONCRETE_ORDER.indexOf(a) - CONCRETE_ORDER.indexOf(b));
  if (concrete.length === 0 || concrete.includes(resolved)) return resolved;
  const idx = CONCRETE_ORDER.indexOf(resolved);
  let best = concrete[0];
  let bestDist = Infinity;
  for (const a of concrete) {
    const d = Math.abs(CONCRETE_ORDER.indexOf(a) - idx);
    if (d < bestDist) { bestDist = d; best = a; } // strict < keeps the cheaper level on ties
  }
  return best;
}

/**
 * Resolve Auto → a concrete effort for the provider. Heuristic, not a model
 * call: short asks stay fast, multi-clause or “refactor/analyze/design” push up.
 * `allowed` are the effort levels the selected model declares; the result is
 * clamped to them so the provider never receives a level it doesn't support.
 */
export function resolveEffort(
  value: ReasoningEffort,
  prompt: string,
  allowed?: readonly ReasoningEffort[],
): Concrete {
  let resolved: Concrete;
  if (value !== 'auto') {
    resolved = value;
  } else {
    const text = prompt.trim();
    if (!text) resolved = 'medium';
    else {
      const heavy = /(重构|分析|设计|架构|refactor|architect|design|analyze|debug why|root cause|plan)/i;
      const long = text.length > 400;
      const multi = (text.match(/[,.;。；、\n]/g) || []).length >= 4;
      // Tiny pings stay cheap; a normal one-liner is medium.
      if (heavy.test(text) || long || multi) resolved = 'high';
      else if (text.length < 24) resolved = 'low';
      else resolved = 'medium';
    }
  }
  return clampEffort(resolved, allowed);
}
