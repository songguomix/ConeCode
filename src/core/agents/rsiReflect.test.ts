import { describe, expect, it } from 'vitest';
import {
  isWellFormedLesson, relevantLessons, addLesson, pruneLessons,
  learnabilityScore, type Lesson,
} from './rsiReflect';

const lesson = (over: Partial<Lesson> & { id: string }): Lesson => ({
  module: 'loop',
  text: 'Batch independent reads before mutating.',
  episodes: ['e1'],
  outcome: 'success',
  ...over,
});

describe('isWellFormedLesson', () => {
  it('rejects empty, oversized, or evidence-free lessons', () => {
    expect(isWellFormedLesson(lesson({ id: 'a' }))).toBe(true);
    expect(isWellFormedLesson(lesson({ id: 'a', text: '' }))).toBe(false);
    expect(isWellFormedLesson(lesson({ id: 'a', text: 'x'.repeat(281) }))).toBe(false);
    expect(isWellFormedLesson(lesson({ id: 'a', episodes: [] }))).toBe(false);
  });
});

describe('relevantLessons', () => {
  it('ranks same-module failures first, then successes, then general', () => {
    const out = relevantLessons([
      lesson({ id: 'g', module: 'general', text: 'general rule', outcome: 'success', episodes: ['e9'] }),
      lesson({ id: 's', module: 'loop', text: 'what worked', outcome: 'success', episodes: ['e1'] }),
      lesson({ id: 'f', module: 'loop', text: 'what broke', outcome: 'failure', episodes: ['e2'] }),
      lesson({ id: 'o', module: 'tools', text: 'elsewhere', outcome: 'failure', episodes: ['e3'] }),
    ], 'loop', 10);
    expect(out.map((l) => l.id)).toEqual(['f', 's', 'g', 'o']);
  });

  it('caps the list', () => {
    const many = Array.from({ length: 10 }, (_, i) => lesson({ id: `l${i}`, text: `rule ${i}` }));
    expect(relevantLessons(many, 'loop', 3)).toHaveLength(3);
  });
});

describe('addLesson', () => {
  it('merges duplicates by reinforcing episode evidence', () => {
    const base = [lesson({ id: 'a', text: 'Same rule', episodes: ['e1'] })];
    const { lessons, merged } = addLesson(base, lesson({ id: 'b', text: 'same  RULE', episodes: ['e2'] }));
    expect(merged).toBe(true);
    expect(lessons).toHaveLength(1);
    expect(lessons[0].episodes).toEqual(['e1', 'e2']);
  });

  it('appends genuinely new lessons', () => {
    const { lessons, merged } = addLesson([], lesson({ id: 'a' }));
    expect(merged).toBe(false);
    expect(lessons).toHaveLength(1);
  });
});

describe('pruneLessons', () => {
  it('drops old neutrals first and never empties a non-empty file', () => {
    const lessons = [
      lesson({ id: 'n1', outcome: 'neutral', text: 'old neutral' }),
      lesson({ id: 'f1', outcome: 'failure', text: 'real lesson' }),
      lesson({ id: 'n2', outcome: 'neutral', text: 'new neutral' }),
    ];
    expect(pruneLessons(lessons, 2).map((l) => l.id).sort()).toEqual(['f1', 'n2']);
    expect(pruneLessons(lessons, 0)).toHaveLength(1);
  });
});

describe('learnabilityScore (Absolute Zero)', () => {
  it('peaks at a 50% success rate', () => {
    expect(learnabilityScore(10, 5)).toBe(1);
    expect(learnabilityScore(10, 10)).toBe(0);
    expect(learnabilityScore(10, 0)).toBe(0);
    expect(learnabilityScore(4, 3)).toBeCloseTo(0.5, 5);
  });

  it('treats unexplored as unknown, not saturated', () => {
    expect(learnabilityScore(0, 0)).toBe(0.5);
  });
});
