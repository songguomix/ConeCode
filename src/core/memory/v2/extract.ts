// Memory 2.0 — value-node extraction.
//
// The legacy extractor ran on a fixed "every 3rd turn" cadence and summarised
// the last 8 messages. That both wasted provider calls on small talk and missed
// important one-off decisions. Here extraction is triggered by *events with
// long-term value*, and the model is asked for structured facts rather than a
// chat summary.

import { looksLikeSecret } from './model';
import type { MemoryLayer, MemoryStatus, MemoryType } from './types';
import { MEMORY_LAYERS, MEMORY_TYPES } from './types';

export interface ExchangeMessage {
  role: string;
  content: string;
}

export type ValueEventKind =
  | 'task_completed'
  | 'user_decision'
  | 'architecture_change'
  | 'problem_solved'
  | 'reusable_experience'
  | 'session_end'
  | 'task_failed';

export interface ExtractionContext {
  event?: ValueEventKind;
  sessionId?: string;
  projectId?: string | null;
  taskText?: string;
  failed?: boolean;
}

export interface ValueSignal {
  kind: ValueEventKind;
  weight: number;
  evidence: string;
}

export interface ParsedMemoryV2 {
  title: string;
  content: string;
  type: MemoryType;
  layer: MemoryLayer;
  scope: 'global' | 'project';
  tags: string[];
  importance: number;
  confidence: number;
  status: MemoryStatus;
  why?: string;
  outcome?: 'success' | 'failure';
}

const DECISION_RE = /(决定|就用|采用|确认|拍板|approved?|confirmed|decided|let'?s (use|go with)|we'?ll use|改用|定为)/i;
const ARCH_RE = /(架构|重构|migrat|refactor|模块拆分|技术选型|stack|schema change| redesign )/i;
const SOLVED_RE = /(已修复|修复了|resolved|fixed|workaround|root cause|根因|解决(了|方案))/i;
const DONE_RE = /(完成|已完成|测试通过|tests? pass|verified|done and|shipped|merged)/i;
const REUSABLE_RE = /(以后|每次|总是|永远|不要|务必|always|never|remember|经验|复用|踩坑|规律|convention)/i;
const FAILED_RE = /(失败|报错|error|failed|regression|回滚|rollback|could not|unable to)/i;
const CHITCHAT_RE = /^(谢谢|thanks|ok|okay|好的|嗯|hi|hello|hey|再见|bye|收到|👍|👌)[\s\W!！.。~]*$/i;

/**
 * Strict hygiene for anything that would become a durable memory. The
 * extractor runs on real conversations, and models like to return process
 * narration ("I will now edit the file") or unanswered questions as if they
 * were knowledge. Those are context, not memory, and must not accumulate.
 */
export function isNoiseMemory(content: string): boolean {
  const text = content.replace(/\s+/g, ' ').trim();
  if (!text || text.length < 8) return true;
  if (CHITCHAT_RE.test(text)) return true;
  // A question is not a fact, a decision, or a lesson.
  if (/[?？]\s*$/.test(text)) return true;
  // First-person process narration / next-step talk.
  if (/^(i (will|am going to|'ll)|i'll|let me|let's|we (will|need to|are going to|'ll)|next[, ]|now i|then i)\b/i.test(text)) return true;
  if (/^(我来|我会|接下来|下一步|现在我们|先来|然后我们|继续处理|正在处理)/.test(text)) return true;
  if (/^(we|i) (looked|reviewed|checked|discussed|went through)\b/i.test(text)
    && !/(because|so that|therefore|decided|conclusion|因为|所以|因此|决定|结论|避免|否则)/i.test(text)) return true;
  return false;
}

/** A task is worth a local working-memory row only when it has substance. */
export function isSubstantiveTask(text: string): boolean {
  const value = text.replace(/\s+/g, ' ').trim();
  if (value.length < 8) return false;
  if (CHITCHAT_RE.test(value)) return false;
  // Pure acknowledgements / navigation commands are not a task context.
  if (/^(open|close|show|hide|打开|关闭|显示|隐藏|切换|继续|再来|好的|收到)[\s\W]*$/i.test(value)) return false;
  return true;
}

/** Detect *why* this exchange is worth remembering. No timer involved. */
export function detectValueSignals(messages: ExchangeMessage[], ctx: ExtractionContext = {}): ValueSignal[] {
  const out: ValueSignal[] = [];
  const push = (kind: ValueEventKind, weight: number, evidence: string) => {
    if (!out.some((s) => s.kind === kind)) out.push({ kind, weight, evidence: evidence.slice(0, 140) });
  };
  if (ctx.event) push(ctx.event, 1, `explicit event: ${ctx.event}`);

  const userText = messages.filter((m) => m.role === 'user').map((m) => m.content).join('\n');
  const allText = messages.map((m) => m.content).join('\n');

  if (DECISION_RE.test(userText)) push('user_decision', 1, userText.match(DECISION_RE)?.[0] ?? 'decision');
  if (ARCH_RE.test(allText)) push('architecture_change', 0.9, allText.match(ARCH_RE)?.[0] ?? 'architecture');
  if (SOLVED_RE.test(allText)) push('problem_solved', 0.9, allText.match(SOLVED_RE)?.[0] ?? 'problem solved');
  if (DONE_RE.test(allText)) push('task_completed', 0.7, allText.match(DONE_RE)?.[0] ?? 'task completed');
  if (REUSABLE_RE.test(allText)) push('reusable_experience', 0.8, allText.match(REUSABLE_RE)?.[0] ?? 'reusable rule');
  if (ctx.failed || FAILED_RE.test(allText)) push('task_failed', 0.85, 'failure detected');
  return out;
}

/** A turn is extracted only when a value node is present and the user said something. */
export function shouldExtract(messages: ExchangeMessage[], ctx: ExtractionContext = {}): boolean {
  if (!messages.some((m) => m.role === 'user' && m.content.trim())) return false;
  const signals = detectValueSignals(messages, ctx);
  if (ctx.event === 'session_end') {
    // Session end is not a licence to summarise small talk. It must either
    // contain a real value node or be a genuinely long working session.
    const valueSignals = signals.filter((signal) => signal.kind !== 'session_end');
    return valueSignals.length > 0 || messages.filter((m) => m.content.trim().length >= 8).length >= 6;
  }
  const best = signals.reduce((acc, s) => Math.max(acc, s.weight), 0);
  // A single "done" (0.7) is not enough on its own; decisions/failures/solutions are.
  return best >= 0.8;
}

/** Cheap pre-filter: no point spending a provider call on "thanks!". */
export function isLowValueExchange(messages: ExchangeMessage[]): boolean {
  const meaningful = messages.filter((m) => m.content && m.content.trim());
  if (!meaningful.length) return true;
  const chars = meaningful.reduce((n, m) => n + m.content.length, 0);
  if (chars < 24) return true;
  return meaningful.every((m) => CHITCHAT_RE.test(m.content.trim()));
}

export const EXTRACTION_V2_PROMPT = `You are the memory extractor for a long-running coding agent. You do NOT summarise chat. You decide whether this exchange produced knowledge worth reusing weeks from now, and if so emit structured records.

Reply with JSON only:
{"memories":[{"title":"short label","content":"one durable fact WITH the necessary technical detail and decision context","type":"...","scope":"global|project","tags":["..."],"importance":0.0-1.0,"confidence":0.0-1.0,"status":"confirmed|inferred|pending","why":"evidence or reason, when known","outcome":"success|failure"}]}

type must be one of: ${MEMORY_TYPES.join(', ')}.
layer is derived by the engine from type + scope (available layers: ${MEMORY_LAYERS.join(', ')}).

Extract ONLY these value nodes:
- A user explicitly confirmed a decision, preference or constraint. status="confirmed", confidence>=0.9.
- A technical decision AND its reason (emit the decision; put the rationale in why).
- A project architecture/stack/constraint change.
- A problem was solved, or a task failed: emit the reusable lesson, the symptom, the root cause and the resolution. Use type failure_experience / success_experience / known_bug, and outcome.
- Current progress and unfinished TODOs that a later session would need.
- A reusable pattern observed across tasks.

Hard rules:
- Return {"memories":[]} unless something is genuinely durable. Most exchanges produce nothing. Never invent.
- NEVER store secrets, API keys, tokens, passwords, file contents, or raw transcripts.
- Do not restate small talk, greetings, or step-by-step process narration.
- Distinguish what the USER stated (confirmed) from what YOU inferred (inferred). Never promote an inference.
- One fact per record. Keep content under 800 characters, but preserve concrete identifiers (module names, commands, error strings).
- Do not repeat anything listed under "Existing memory".`;

function findJsonObject(raw: string): any | null {
  const text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fence ? fence[1].trim() : text;
  const start = body.indexOf('{');
  if (start === -1) return null;
  for (let end = body.lastIndexOf('}'); end > start; end = body.lastIndexOf('}', end - 1)) {
    try { return JSON.parse(body.slice(start, end + 1)); } catch { /* try a shorter slice */ }
  }
  return null;
}

function clamp(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

/** Tolerant parser: models wrap JSON in prose/fences; a bad reply must never break the turn. */
export function parseExtractionV2(raw: string): ParsedMemoryV2[] {
  const parsed = findJsonObject(raw || '');
  if (!parsed || !Array.isArray(parsed.memories)) return [];
  const out: ParsedMemoryV2[] = [];
  for (const m of parsed.memories) {
    const content = typeof m?.content === 'string' ? m.content.trim() : '';
    if (!content || content.length > 1200 || looksLikeSecret(content)) continue;
    if (isNoiseMemory(content)) continue;
    const why = typeof m?.why === 'string' ? m.why.trim() : '';
    if (looksLikeSecret(why)) continue;
    const type: MemoryType = MEMORY_TYPES.includes(m?.type) ? m.type : 'project_fact';
    const scope: 'global' | 'project' = m?.scope === 'global' || type === 'user_fact' ? 'global' : 'project';
    const status: MemoryStatus = ['confirmed', 'inferred', 'pending'].includes(m?.status) ? m.status : 'inferred';
    const layer: MemoryLayer = scope === 'global'
      ? 'global'
      : (['task_result', 'success_experience', 'failure_experience'].includes(type) ? 'episodic'
        : type === 'reusable_knowledge' || type === 'decision_reason' ? 'semantic' : 'project');
    out.push({
      title: (typeof m?.title === 'string' ? m.title.trim() : '').slice(0, 160) || content.slice(0, 60),
      content,
      type,
      layer,
      scope,
      tags: Array.isArray(m?.tags) ? m.tags.filter((t: any) => typeof t === 'string').slice(0, 8).map((t: string) => t.trim()) : [],
      importance: clamp(m?.importance, 0.5),
      confidence: clamp(m?.confidence, status === 'confirmed' ? 0.95 : 0.65),
      status,
      why: why && why.length < 600 ? why : undefined,
      outcome: m?.outcome === 'failure' || m?.outcome === 'success' ? m.outcome : undefined,
    });
  }
  return out;
}

/** Build the extractor request body, including what is already known (dedupe signal). */
export function buildExtractionRequest(opts: {
  messages: ExchangeMessage[];
  known: string[];
  signals: ValueSignal[];
  projectName?: string;
  taskText?: string;
}): { system: string; user: string } {
  const transcript = opts.messages
    .slice(-12)
    .map((m) => `${m.role === 'assistant' ? 'Assistant' : m.role === 'user' ? 'User' : 'Tool'}: ${m.content.slice(0, 2500)}`)
    .join('\n\n');
  return {
    system: EXTRACTION_V2_PROMPT,
    user: [
      `Value nodes detected: ${opts.signals.map((s) => s.kind).join(', ') || 'none'}`,
      opts.projectName ? `Current project: ${opts.projectName}` : 'No project open',
      opts.taskText ? `Task: ${opts.taskText.slice(0, 400)}` : '',
      `Existing memory (do not repeat):\n${opts.known.length ? opts.known.map((k) => `- ${k.slice(0, 240)}`).join('\n') : '(empty)'}`,
      `---\nExchange:\n${transcript}`,
    ].filter(Boolean).join('\n\n'),
  };
}
