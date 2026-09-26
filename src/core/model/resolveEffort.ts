import type { ReasoningEffort } from '../../types';

/**
 * Resolve Auto → a concrete effort for the provider. Heuristic, not a model
 * call: short asks stay fast, multi-clause or “refactor/analyze/design” push up.
 */
export function resolveEffort(value: ReasoningEffort, prompt: string): 'low' | 'medium' | 'high' {
  if (value !== 'auto') return value;
  const text = prompt.trim();
  if (!text) return 'medium';
  const heavy = /(重构|分析|设计|架构|refactor|architect|design|analyze|debug why|root cause|plan)/i;
  const long = text.length > 400;
  const multi = (text.match(/[,.;。；、\n]/g) || []).length >= 4;
  if (heavy.test(text) || long || multi) return 'high';
  // Tiny pings stay cheap; a normal one-liner is medium.
  if (text.length < 24) return 'low';
  return 'medium';
}
