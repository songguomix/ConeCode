import type { Message } from '../../types';

export interface WorkProcess {
  startId: string;
  finalId: string;
  messageIds: Set<string>;
}

/** UI-only grouping: never removes tool history from the model's context. */
export function completedWorkProcesses(messages: Message[], streaming: boolean, pendingIds: Set<string>): WorkProcess[] {
  const groups: WorkProcess[] = [];
  let start = 0;
  const finish = (end: number) => {
    const final = messages[end - 1];
    if (!final || final.role !== 'assistant' || final.isToolResult || final.isQuestion
      || final.isLocalNotice || final.isSummary || final.interrupted || final.toolCalls?.length
      || !final.content.trim() || /```json\s*\n|\[SUGGEST_WORK_MODE\]/.test(final.content)) return;
    const process = messages.slice(start, end - 1);
    if (!process.length || process.some((m) => m.isSummary || m.isLocalNotice || pendingIds.has(m.id))
      || pendingIds.has(final.id)) return;
    groups.push({ startId: process[0].id, finalId: final.id, messageIds: new Set(process.map((m) => m.id)) });
  };
  for (let i = 0; i < messages.length; i++) {
    const message = messages[i];
    if (message.role === 'user' && !message.isToolResult) {
      finish(i);
      start = i + 1;
    }
  }
  if (!streaming) finish(messages.length);
  return groups;
}
