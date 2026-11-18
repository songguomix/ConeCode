import type { Message } from '../../types/chat.types';
import type { SubAgentRun } from '../../types/subAgent.types';
import { parsePromptToolCalls, toolActionLabel } from '../tools/definitions';

type HistoryCall = { id?: string; name: string; arguments: Record<string, unknown> };

interface DelegatingTurn {
  parent: Message;
  calls: HistoryCall[];
  native: boolean;
}

function resultHeader(call: HistoryCall): string {
  const action = ['perf_monitor', 'perf_inspect'].includes(call.name) ? 'perf_snapshot' : call.name;
  return `Result for ${toolActionLabel({ ...call.arguments, action })}:\n`;
}

function recoverReport(turn: DelegatingTurn, index: number, result: string, runs: Map<string, SubAgentRun>) {
  const call = turn.calls[index];
  const task = call?.arguments?.task;
  if (call?.name !== 'spawn_agent' || typeof task !== 'string' || !task.trim()) return;
  const { parent } = turn;
  const id = `${parent.id}:${index}`;
  if (runs.has(id)) return;
  const header = resultHeader(call);
  if (!result.startsWith(header)) return;
  const body = result.slice(header.length);
  const prefix = 'Sub-agent report:\n';
  const executorError = body.startsWith('Error: spawn_agent failed:');
  if (!body.startsWith(prefix) && !executorError) return;
  const report = executorError ? body : body.slice(prefix.length);
  let status: SubAgentRun['status'] = 'completed';
  if (executorError || report.startsWith('(sub-agent error:') || report === '(empty report)') status = 'failed';
  else if (report === '(sub-agent cancelled)') status = 'interrupted';
  else if (report === '(sub-agent reached its step limit without a final report)') status = 'limit';

  runs.set(id, {
    id, conversationId: parent.conversationId, task, startedAt: parent.createdAt, status,
    messages: status === 'completed' ? [{ role: 'assistant', content: report }] : [],
    ...(status === 'completed' ? {} : { detail: report }),
  });
}

function recoverPromptBatch(turn: DelegatingTurn, content: string, runs: Map<string, SubAgentRun>) {
  // Prompt mode serializes a batch as a single user/tool-result message.
  // A single call owns its whole result, including quoted result headers.
  const results = turn.calls.length === 1 ? [content] : content.split(/\n\n(?=Result for [^\n]+:\n)/);
  let indexes = turn.calls.map((_, index) => index);
  if (results.length !== indexes.length) {
    // ask_user displays a separate question instead of producing a prompt result.
    indexes = indexes.filter((index) => turn.calls[index].name !== 'ask_user');
  }
  // Old batches have no escaping. If content contains apparent extra
  // headers and an unambiguous pairing is impossible, keep it in the parent.
  if (results.length !== indexes.length) return;
  // Guard against a missing result offsetting an apparent header inside a
  // different tool's output. Malformed calls use their function name as label.
  if (results.some((result, offset) => {
    const call = turn.calls[indexes[offset]];
    return !result.startsWith(resultHeader(call)) && !result.startsWith(`Result for ${call.name}:\n`);
  })) return;
  results.forEach((result, offset) => recoverReport(turn, indexes[offset], result, runs));
}

/** Collect recorded conversations, including findings saved by older versions. */
export function collectSubAgentRuns(messages: Message[]): SubAgentRun[] {
  const runs = new Map<string, SubAgentRun>();
  const pending = new Map<string, DelegatingTurn>();
  for (const message of messages) {
    const { conversationId } = message;
    if (message.role === 'assistant') {
      pending.delete(conversationId);
      for (const run of message.subAgentRuns ?? []) runs.set(run.id, run);
      if (message.isLocalNotice || message.isSummary || message.isQuestion) continue;
      const native = !!message.toolCalls?.length;
      const calls = native ? message.toolCalls!
        : message.content.includes('spawn_agent') ? parsePromptToolCalls(message.content) : [];
      if (calls.some((call) => call.name === 'spawn_agent')) pending.set(conversationId, { parent: message, native, calls });
      continue;
    }

    const turn = pending.get(conversationId);
    if (!turn) continue;
    if (turn.native && message.role === 'tool') {
      if (message.toolCallId && (!message.toolName || message.toolName === 'spawn_agent')) {
        const index = turn.calls.findIndex((call) => call.id === message.toolCallId);
        if (index >= 0) recoverReport(turn, index, message.content, runs);
      }
      continue;
    }
    if (!turn.native && message.role === 'user' && message.isToolResult) {
      recoverPromptBatch(turn, message.content, runs);
    }
    pending.delete(conversationId);
  }
  return [...runs.values()].sort((a, b) => b.startedAt - a.startedAt);
}
