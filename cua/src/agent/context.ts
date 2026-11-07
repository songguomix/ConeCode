import type { ModelMessage } from '../model/types.js';

export interface CompactionResult {
  messages: ModelMessage[];
  compacted: boolean;
  omitted: number;
  beforeChars: number;
  afterChars: number;
}

/**
 * Bounded conversation context. Long page text/screenshots are already trimmed
 * by the observation projection; this keeps the accumulated action history
 * from growing without bound. It never removes the system prompt or the most
 * recent tool/result pair, and it never invents a summary of page state.
 */
export function compactMessages(messages: ModelMessage[], maxChars = 60_000): CompactionResult {
  const beforeChars = estimateChars(messages);
  if (beforeChars <= maxChars || messages.length <= 8) {
    return { messages, compacted: false, omitted: 0, beforeChars, afterChars: beforeChars };
  }
  const system = messages.filter((m) => m.role === 'system').slice(0, 1);
  let start = Math.max(system.length, messages.length - 10);
  // Do not start with a tool result: OpenAI-compatible APIs require the
  // assistant tool-call message that produced it.
  while (start > system.length && messages[start]!.role === 'tool') start -= 1;
  const recent = messages.slice(start);
  const omitted = start - system.length;
  const note: ModelMessage = {
    role: 'user',
    content: `[Context compacted by the runtime: ${omitted} earlier message(s) were omitted. They remain available in the append-only event log. Re-observe before acting; do not rely on omitted page state.]`,
  };
  const next = [...system, note, ...recent];
  return {
    messages: next,
    compacted: true,
    omitted,
    beforeChars,
    afterChars: estimateChars(next),
  };
}

export function estimateChars(messages: ModelMessage[]): number {
  let chars = 0;
  for (const message of messages) {
    if (typeof message.content === 'string') chars += message.content.length;
    else chars += message.content.reduce((sum, part) => sum + (part.type === 'text' ? part.text.length : 100_000), 0);
    chars += (message.toolCalls?.length ?? 0) * 200;
  }
  return chars;
}
