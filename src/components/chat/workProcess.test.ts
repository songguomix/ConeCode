import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { completedWorkProcesses } from './workProcess';
const msg = (id: string, patch: Partial<Message> = {}): Message => ({ id, conversationId: 'c', role: 'assistant', content: 'text', createdAt: 0, ...patch });
const turn = [msg('u', { role: 'user' }), msg('step'), msg('tool', { role: 'user', isToolResult: true }), msg('final')];
describe('completed Work process grouping', () => {
  it('keeps the final response outside the folded process', () => {
    const [group] = completedWorkProcesses(turn, false, new Set());
    expect(group.finalId).toBe('final');
    expect([...group.messageIds]).toEqual(['step', 'tool']);
  });
  it('does not collapse a live turn or pending approvals', () => {
    expect(completedWorkProcesses(turn, true, new Set())).toEqual([]);
    expect(completedWorkProcesses(turn, false, new Set(['step']))).toEqual([]);
  });
  it('keeps interrupted replies, questions and tool requests visible', () => {
    for (const patch of [{ interrupted: true }, { isQuestion: true }, { toolCalls: [{ id: 't', name: 'exec', arguments: {} }] }]) {
      expect(completedWorkProcesses([...turn.slice(0, -1), msg('final', patch)], false, new Set())).toEqual([]);
    }
  });
  it('can fold a finished historical turn during the next live turn', () => {
    expect(completedWorkProcesses([...turn, msg('u2', { role: 'user' }), msg('next')], true, new Set()).map((g) => g.finalId)).toEqual(['final']);
  });
});
