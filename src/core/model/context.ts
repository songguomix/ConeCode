/**
 * Context budget — pure.
 *
 * Default budget is 256K: enough for most work, cheaper and faster than
 * burning a 1M window on every turn. "Full context" (a Settings switch)
 * lifts the cap to whatever the model itself declares. An explicit per-model
 * limit override always wins over both.
 */

export const DEFAULT_CONTEXT_TOKENS = 256_000;

export function effectiveContextWindow(
  modelWindow: number | undefined | null,
  fullContext: boolean,
): number {
  const w = modelWindow && modelWindow > 0 ? modelWindow : DEFAULT_CONTEXT_TOKENS;
  return fullContext ? w : Math.min(w, DEFAULT_CONTEXT_TOKENS);
}
