// Cross-episode verbal reflection for RSI+RL (Reflexion verbal
// reinforcement + GEPA actionable side information, adapted).
//
// Scalar rewards say THAT a candidate failed; the natural-language lesson
// says WHY, and it compounds: every future SAMPLE reads the relevant lessons
// first. Lessons live in `.conecode/rsi/REFLECTIONS.md`; this module is the
// pure retrieval/pruning core plus the Absolute Zero learnability score that
// steers direction-picking toward maximal-learning-signal work.

export type LessonOutcome = 'success' | 'failure' | 'neutral';

export interface Lesson {
  id: string;
  /** Harness module the lesson applies to, or 'general'. */
  module: string;
  /** One or two sentences: the failure mode / reusable rule. ≤280 chars. */
  text: string;
  /** Episode ids supporting it (grows as the lesson re-occurs). */
  episodes: string[];
  outcome: LessonOutcome;
}

const MAX_TEXT = 280;

export function isWellFormedLesson(l: Lesson): boolean {
  return !!l.id.trim() && !!l.text.trim() && l.text.length <= MAX_TEXT && l.episodes.length > 0;
}

/**
 * Lessons for the upcoming SAMPLE, most useful first: same-module lessons
 * (failures before successes — what to avoid dominates), then general ones,
 * newest first within each band. Capped so the prompt stays small.
 */
export function relevantLessons(lessons: Lesson[], module: string, limit = 5): Lesson[] {
  const band = (l: Lesson): number => {
    if (l.module === module) return l.outcome === 'failure' ? 0 : 1;
    if (l.module === 'general') return 2;
    return 3;
  };
  const recency = (l: Lesson): string => l.episodes[l.episodes.length - 1] ?? '';
  return [...lessons]
    .sort((a, b) => band(a) - band(b) || (recency(b) < recency(a) ? -1 : recency(b) > recency(a) ? 1 : 0))
    .slice(0, Math.max(0, limit));
}

/**
 * Merge an incoming lesson: exact-text duplicates reinforce the existing
 * record (episode appended) instead of doubling the file.
 * Returns the updated list and whether it was a merge.
 */
export function addLesson(lessons: Lesson[], incoming: Lesson): { lessons: Lesson[]; merged: boolean } {
  const norm = (t: string) => t.toLowerCase().replace(/\s+/g, ' ').trim();
  const dup = lessons.find((l) => l.module === incoming.module && norm(l.text) === norm(incoming.text));
  if (dup) {
    const episodes = [...new Set([...dup.episodes, ...incoming.episodes])];
    return {
      lessons: lessons.map((l) => (l === dup ? { ...l, episodes } : l)),
      merged: true,
    };
  }
  return { lessons: [...lessons, incoming], merged: false };
}

/**
 * Prune to `max` lessons when the file grows: neutrals go first (oldest),
 * then oldest failures/successes. Never prune to zero while lessons exist.
 */
export function pruneLessons(lessons: Lesson[], max = 30): Lesson[] {
  const keep = Math.max(1, max);
  if (lessons.length <= keep) return lessons;
  const rank = (l: Lesson): number => (l.outcome === 'neutral' ? 0 : 1);
  const sorted = [...lessons].sort((a, b) => rank(a) - rank(b));
  const drop = new Set(sorted.slice(0, lessons.length - keep));
  return lessons.filter((l) => !drop.has(l));
}

// ---------------------------------------------------------------------------
// Absolute Zero learnability (Zhao et al., arXiv:2505.03335): the richest
// learning signal comes from tasks the solver SOMETIMES passes — maximal
// expected improvement. Applied to direction-picking: prefer directions
// with mixed prior outcomes over saturated wins or hopeless losses.
// ---------------------------------------------------------------------------

/**
 * Learnability in [0, 1]: 1.0 at a 50% success rate, 0 at always/never.
 * Zero attempts (unexplored) scores 0.5 — unknown, not saturated.
 */
export function learnabilityScore(attempts: number, successes: number): number {
  if (!(attempts > 0)) return 0.5;
  const p = Math.min(1, Math.max(0, successes / attempts));
  return 1 - Math.abs(2 * p - 1);
}
