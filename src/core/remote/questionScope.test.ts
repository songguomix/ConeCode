import { describe, expect, it } from 'vitest';
import { remoteQuestion } from './questionScope';

const question = { id: 'q1', conversationId: 'chat', role: 'assistant' as const, isQuestion: true };

describe('remote question scope', () => {
  it('restores the pending question and ignores subsequent tool evidence', () => {
    expect(remoteQuestion([question, { id: 'tool', conversationId: 'chat', role: 'user', isToolResult: true }], 'chat')).toEqual(question);
  });
  it('never revives a question after a later user answer', () => {
    expect(remoteQuestion([question, { id: 'answer', conversationId: 'chat', role: 'user' }, { id: 'later', conversationId: 'chat', role: 'assistant' }], 'chat')).toBeNull();
  });
  it('isolates concurrent chats and selects only the latest question', () => {
    const latest = { ...question, id: 'q2' };
    expect(remoteQuestion([question, latest, { id: 'other', conversationId: 'other', role: 'user' }], 'chat')).toEqual(latest);
    expect(remoteQuestion([question], 'other')).toBeNull();
    expect(remoteQuestion([question], null)).toBeNull();
  });
});
