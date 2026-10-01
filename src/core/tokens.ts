/**
 * Lightweight token estimation. We don't ship a real tokenizer, so this is a
 * heuristic that's good enough to drive the context-usage meter: ASCII text is
 * ~4 characters per token, while CJK and other multi-byte characters are far
 * denser (roughly one token each).
 */
export function estimateTokens(text: string | null | undefined): number {
  if (!text) return 0;
  let ascii = 0;
  let dense = 0;
  // Tight loop over the whole string — keep it allocation-free. Called from
  // ContextMeter on streaming buffers, so O(n) per unique content is the budget.
  const len = text.length;
  for (let i = 0; i < len; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else dense++;
  }
  return (ascii >> 2) + dense + (ascii & 3 ? 1 : 0);
}

/**
 * Rough token cost of the static system prompt that chat.store always prepends
 * (the action-protocol instructions + workspace header). It's a fixed block, so
 * a constant keeps the meter from having to re-tokenize it on every render.
 */
export const SYSTEM_PROMPT_TOKENS = 470;
