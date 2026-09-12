// The five panel toggles collapsed into one menu, so the toolbar has room. Only
// one status dot fits on the collapsed trigger, and picking the wrong one hides
// something the user needs to see — a running dev server once masked the fact
// that the agent was holding the real mouse and keyboard.

export type DotKind = 'success' | 'warning-pulse' | 'error' | 'error-pulse';

/** Most urgent first. */
export const DOT_URGENCY: DotKind[] = ['error-pulse', 'error', 'warning-pulse', 'success'];

/** The one dot the collapsed trigger shows: the most urgent live signal, if any. */
export function mostUrgentDot(dots: (DotKind | null | undefined)[]): DotKind | null {
  let best: DotKind | null = null;
  for (const d of dots) {
    if (!d) continue;
    if (best === null || DOT_URGENCY.indexOf(d) < DOT_URGENCY.indexOf(best)) best = d;
  }
  return best;
}
