// Classification & quality control.
//
// Classification is deterministic where it can be (type -> layer, scope ->
// projectId) and only delegates to the model for the genuinely semantic parts.
// Quality control then decides add / reinforce / merge / reject before anything
// is written, which is what stops duplicate and low-value memories piling up.

import type { MemoryLayer, MemoryRecord, MemoryType } from './types';
import { isNoiseMemory, type ParsedMemoryV2 } from './extract';
import { isContained, jaccard, termSet } from './text';

export interface ClassifyContext {
  projectId: string | null;
  /** Explicit user statements must never be downgraded to an inference. */
  userStated?: boolean;
}

export interface ClassifiedMemory {
  title: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  projectId: string | null;
  tags: string[];
  importance: number;
  confidence: number;
  status: 'confirmed' | 'inferred' | 'pending';
  why?: string;
  outcome?: 'success' | 'failure';
}

/** Map a memory type onto the layered architecture. */
export function layerFor(type: MemoryType, scope: 'global' | 'project'): MemoryLayer {
  if (scope === 'global' || type === 'user_fact') return 'global';
  if (type === 'task_result' || type === 'success_experience' || type === 'failure_experience') return 'episodic';
  if (type === 'reusable_knowledge' || type === 'decision_reason') return 'semantic';
  if (type === 'todo' || type === 'progress') return 'working';
  return 'project';
}

const NOISE_RE = /^(好的|收到|谢谢|ok|okay|继续|嗯|明白|了解|thanks|sure|got it|lgtm)[\s\W!！.。]*$/i;

/** 0 = worthless, 1 = clearly durable. */
export function qualityScore(input: { content: string; title?: string; tags?: string[]; why?: string; importance?: number }): number {
  const text = `${input.title ?? ''} ${input.content}`.trim();
  if (!text || text.length < 12 || NOISE_RE.test(text) || isNoiseMemory(input.content)) return 0;
  let score = 0.35;
  if (text.length >= 30) score += 0.1;
  if (/\b(?:because|since|so that|因此|因为|原因|避免|导致|否则)\b|因为|原因|由于|导致/.test(text)) score += 0.15;
  if (/[`/_.\-()]|\b(?:src|test|api|db|sql|http|config|build|deploy|module)\b/i.test(text)) score += 0.12;
  if (input.why) score += 0.12;
  if ((input.tags ?? []).length >= 2) score += 0.06;
  if (typeof input.importance === 'number') score += Math.min(0.1, input.importance * 0.1);
  return Math.min(1, score);
}

export function classify(parsed: ParsedMemoryV2, ctx: ClassifyContext): ClassifiedMemory {
  const layer = layerFor(parsed.type, parsed.scope);
  const projectId = layer === 'global' ? null : ctx.projectId;
  // A classified candidate can only be one of the three live states. Anything
  // else (superseded/archived) is a lifecycle operation, never an extraction.
  const status: 'confirmed' | 'inferred' | 'pending' = ctx.userStated
    ? 'confirmed'
    : parsed.status === 'confirmed'
      ? 'confirmed'
      : parsed.status === 'pending'
        ? 'pending'
        : 'inferred';
  const confidence = ctx.userStated ? Math.max(0.9, parsed.confidence) : parsed.confidence;
  // A project-bound memory with no project cannot be stored: demote to global
  // rather than silently attaching it to the wrong workspace.
  const safeLayer: MemoryLayer = layer !== 'global' && !projectId ? 'global' : layer;
  const tags = Array.from(new Set([
    ...parsed.tags,
    parsed.outcome ?? '',
    parsed.type,
  ].filter(Boolean)));
  return {
    title: parsed.title,
    content: parsed.content,
    type: parsed.type,
    layer: safeLayer,
    projectId: safeLayer === 'global' ? null : projectId,
    tags,
    importance: parsed.importance,
    confidence,
    status,
    why: parsed.why,
    outcome: parsed.outcome,
  };
}

export type DedupeDecision =
  | { action: 'add'; candidate: ClassifiedMemory }
  | { action: 'reinforce'; candidate: ClassifiedMemory; existing: MemoryRecord }
  | { action: 'merge'; candidate: ClassifiedMemory; existing: MemoryRecord }
  /** Same subject, opposite claim. Never overwrite silently — reconcile first. */
  | { action: 'reconcile'; candidate: ClassifiedMemory; existing: MemoryRecord }
  | { action: 'reject'; candidate: ClassifiedMemory; reason: string };

const SIMILAR_THRESHOLD = 0.62;

const NEGATIVE_POLARITY = /(?:^|\b)(?:not|never|don't|do not|avoid|disable[ds]?|remove[ds]?|delete[ds]?|without)(?:\b|$)|不要|别(?:再)?|禁止|禁用|关闭|删除|移除|避免|从不|不能|不可|无需/i;
const POSITIVE_POLARITY = /(?:^|\b)(?:always|must|use[ds]?|enable[ds]?|keep|retain|add(?:ed)?|required?|allow(?:ed)?)(?:\b|$)|必须|总是|始终|使用|启用|开启|保留|添加|可以|允许|务必/i;

/**
 * A cheap, deterministic contradiction detector. It only fires when two
 * similar memories sit on opposite sides of a rule ("always X" vs "never X",
 * "use X" vs "avoid X"). Similarity alone must never be enough to overwrite a
 * confirmed fact, so the service routes this decision through reconcile().
 */
export function detectContradiction(a: string, b: string): boolean {
  const aNeg = NEGATIVE_POLARITY.test(a);
  const bNeg = NEGATIVE_POLARITY.test(b);
  if (aNeg === bNeg) return false;
  const aPos = POSITIVE_POLARITY.test(a);
  const bPos = POSITIVE_POLARITY.test(b);
  return (aNeg && bPos) || (bNeg && aPos);
}

/**
 * Decide what a candidate does against the existing set.
 * Reinforce = same fact seen again (raise importance, do not duplicate).
 * Merge    = same subject, the new phrasing is materially sharper -> keep the better text.
 * Reject   = low quality, secret-like, or already superseded.
 */
export function dedupeCandidates(
  candidates: ClassifiedMemory[],
  existing: MemoryRecord[],
  opts: { minQuality?: number } = {},
): DedupeDecision[] {
  const minQuality = opts.minQuality ?? 0.4;
  const active = existing.filter((e) => e.deletedAt === null && e.status !== 'archived');
  const seen = new Set<string>();
  const decisions: DedupeDecision[] = [];

  for (const candidate of candidates) {
    const key = `${candidate.layer}:${candidate.projectId ?? ''}:${candidate.content}`;
    if (seen.has(key)) {
      decisions.push({ action: 'reject', candidate, reason: 'duplicate within this extraction' });
      continue;
    }
    seen.add(key);

    if (qualityScore(candidate) < minQuality) {
      decisions.push({ action: 'reject', candidate, reason: 'below quality threshold' });
      continue;
    }

    const pool = active.filter((e) => e.layer === candidate.layer && e.projectId === candidate.projectId);
    const cTerms = termSet(`${candidate.title} ${candidate.content}`);
    let best: { record: MemoryRecord; similarity: number } | null = null;
    for (const e of pool) {
      const eTerms = termSet(`${e.title} ${e.content}`);
      const similarity = Math.max(jaccard(cTerms, eTerms), isContained(candidate.content, e.content) ? 0.9 : 0);
      if (!best || similarity > best.similarity) best = { record: e, similarity };
    }

    if (best && best.similarity >= SIMILAR_THRESHOLD) {
      // Opposite rules on the same subject are a correction/conflict, not a
      // restatement. Reconcile decides using status, confidence and time.
      if (detectContradiction(candidate.content, best.record.content)) {
        decisions.push({ action: 'reconcile', candidate, existing: best.record });
        continue;
      }
      const sharper = candidate.content.length > best.record.content.length * 1.15;
      decisions.push({
        action: sharper ? 'merge' : 'reinforce',
        candidate,
        existing: best.record,
      });
      continue;
    }
    decisions.push({ action: 'add', candidate });
  }
  return decisions;
}
