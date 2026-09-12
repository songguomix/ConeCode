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
  for (let i = 0; i < text.length; i++) {
    if (text.charCodeAt(i) < 128) ascii++;
    else dense++;
  }
  return Math.ceil(ascii / 4 + dense);
}

/**
 * Rough token cost of the static system prompt that chat.store always prepends
 * (the action-protocol instructions + workspace header). It's a fixed block, so
 * a constant keeps the meter from having to re-tokenize it on every render.
 */
export const SYSTEM_PROMPT_TOKENS = 470;
