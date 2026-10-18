import type { Message } from '../../types';

/** Observed response evidence, not an intelligence score or identity proof. */
export function responseHealth(messages: Message[], providerId: string, modelId: string, expectsReasoning: boolean) {
  const samples = messages.filter((m) => m.providerId === providerId && m.modelId === modelId
    && m.role === 'assistant' && !m.isToolResult && !m.isLocalNotice && !m.isSummary && !m.isQuestion).slice(-10);
  const reasoning = samples.filter((m) => !!m.reasoning_content?.trim()
    || m.thinkingBlocks?.some((block) => !!block.thinking.trim())).length;
  const interruptions = samples.filter((m) => m.interrupted).length;
  return {
    samples: samples.length,
    reasoning,
    interruptions,
    missingReasoning: expectsReasoning && samples.length >= 3 && reasoning === 0,
    repeatedInterruptions: interruptions >= 2,
  };
}
