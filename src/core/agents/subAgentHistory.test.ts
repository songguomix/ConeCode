import { describe, expect, it } from 'vitest';
import type { Message } from '../../types/chat.types';
import type { SubAgentRun } from '../../types/subAgent.types';
import { collectSubAgentRuns } from './subAgentHistory';

function message(id: string, role: Message['role'], content: string, other: Partial<Message> = {}): Message {
  return { id, role, content, conversationId: 'one', createdAt: 1, ...other };
}
const spawn = (task: string, id = 'c1') => ({ id, name: 'spawn_agent', arguments: { task } });
const fence = (action: string, args: Record<string, string> = {}) =>
  `\`\`\`json\n${JSON.stringify({ action, ...args })}\n\`\`\``;
const report = (text: string) => `Result for spawn_agent:\nSub-agent report:\n${text}`;

describe('sub-agent history', () => {
  it('pairs native reports by conversation, assistant turn and provider call id', () => {
    const assistant = message('a', 'assistant', '', { toolCalls: [spawn('first'), spawn('second', 'c2')] });
    const other = message('b', 'assistant', '', { toolCalls: [spawn('third')], conversationId: 'two' });
    const runs = collectSubAgentRuns([
      assistant, other,
      message('1', 'tool', report('third report'), { conversationId: 'two', toolCallId: 'c1' }),
      message('2', 'tool', report('mislabelled'), { toolCallId: 'c1', toolName: 'read_file' }),
      message('3', 'tool', report('second report'), { toolCallId: 'c2', toolName: 'spawn_agent' }),
      message('4', 'assistant', 'I have the findings.'),
      message('5', 'tool', report('orphan'), { toolCallId: 'c1' }),
    ]);
    expect(runs.map((r) => [r.id, r.task, r.messages[0].content])).toEqual([
      ['b:0', 'third', 'third report'], ['a:1', 'second', 'second report'],
    ]);
  });

  it('recovers ordered prompt reports and keeps other calls out of each transcript', () => {
    const actions = [
      fence('read_file', { path: '/file' }), fence('spawn_agent', { task: 'one' }),
      fence('spawn_agent', { task: 'two' }), fence('ask_user', { question: 'Ready?' }),
    ];
    const runs = collectSubAgentRuns([
      message('a', 'assistant', actions.join('\n')),
      message('b', 'user', ['Result for /file:\nfile content', report('report one'), report('report two')].join('\n\n'), { isToolResult: true }),
    ]);
    expect(runs.map((r) => [r.id, r.task, r.messages[0].content])).toEqual([
      ['a:1', 'one', 'report one'], ['a:2', 'two', 'report two'],
    ]);
  });

  it('ignores tool examples, ordinary user input, skipped calls and ambiguous batch output', () => {
    const action = fence('spawn_agent', { task: 'audit' });
    expect(collectSubAgentRuns([
      message('a', 'assistant', action),
      message('b', 'user', report('user quoted a report')),
      message('c', 'user', report('orphan tool result'), { isToolResult: true }),
      message('d', 'assistant', action),
      message('e', 'user', 'Result for spawn_agent:\nSkipped because this execution was stopped.', { isToolResult: true }),
      message('f', 'assistant', fence('read_file', { path: '/f' }) + '\n' + action),
      message('g', 'user', 'Result for /f:\nfile content\n\n' + report('quoted inside file') + '\n\n' + report('actual'), { isToolResult: true }),
    ])).toEqual([]);
  });

  it('preserves headers quoted within a single report and records historical terminal states', () => {
    const cases = [
      { text: 'notes\n\nResult for read_file:\nexample', status: 'completed' },
      { text: '(sub-agent error: offline)', status: 'failed' },
      { text: '(sub-agent reached its step limit without a final report)', status: 'limit' },
      { text: '(sub-agent cancelled)', status: 'interrupted' },
    ];
    for (const { text, status } of cases) {
      const [run] = collectSubAgentRuns([
        message('a', 'assistant', fence('spawn_agent', { task: 'inspect' })),
        message('b', 'user', report(text), { isToolResult: true }),
      ]);
      expect(run.status).toEqual(status);
      expect(status === 'completed' ? run.messages[0].content : run.detail).toEqual(text);
    }
  });

  it('gives saved detailed runs precedence while recovering missing siblings', () => {
    const detailed: SubAgentRun = {
      id: 'a:0', conversationId: 'one', task: 'first', startedAt: 10, status: 'completed',
      messages: [{ role: 'tool', content: 'file contents', name: 'read_file' }, { role: 'assistant', content: 'findings' }],
    };
    const runs = collectSubAgentRuns([
      message('a', 'assistant', '', { toolCalls: [spawn('first'), spawn('second', 'c2')], subAgentRuns: [detailed] }),
      message('b', 'tool', report('short findings'), { toolCallId: 'c1' }),
      message('c', 'tool', report('second findings'), { toolCallId: 'c2' }),
    ]);
    expect(runs).toHaveLength(2);
    expect(runs[0]).toBe(detailed);
    expect(runs[1]).toMatchObject({ id: 'a:1', task: 'second', messages: [{ content: 'second findings' }] });
  });
});
