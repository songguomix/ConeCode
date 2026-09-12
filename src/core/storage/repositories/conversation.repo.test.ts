import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../../../types';

const disk = vi.hoisted(() => ({ messages: [] as Message[] }));
vi.mock('../database', () => ({
  readJSON: () => structuredClone(disk.messages),
  writeJSON: vi.fn((_file: string, messages: Message[]) => { disk.messages = structuredClone(messages); }),
}));
import { messageRepo } from './conversation.repo';
import { writeJSON } from '../database';

describe('persisted message editing', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    disk.messages = [
      { id: 'first', conversationId: 'one', role: 'user', content: 'earlier', createdAt: 1 },
      { id: 'target', conversationId: 'one', role: 'user', content: 'original', createdAt: 2 },
      { id: 'other', conversationId: 'two', role: 'user', content: 'other chat', createdAt: 3 },
      { id: 'reply', conversationId: 'one', role: 'assistant', content: 'old reply', createdAt: 4 },
      { id: 'tool', conversationId: 'one', role: 'tool', content: 'old tool output', createdAt: 5 },
    ];
  });

  it('saves the replacement and removes the tail in one write without touching other chats', () => {
    const replacement = messageRepo.editAndTruncate('one', 'target', 'edited');
    expect(writeJSON).toHaveBeenCalledTimes(1);
    expect(messageRepo.findByConversation('one').map((m) => m.content)).toEqual(['earlier', 'edited']);
    expect(messageRepo.findByConversation('one')[1]).toEqual(replacement);
    expect(messageRepo.findByConversation('two').map((m) => m.content)).toEqual(['other chat']);
  });

  it('refuses a wrong conversation, a non-user message, and empty content', () => {
    for (const [conv, id, content] of [['two', 'target', 'x'], ['one', 'reply', 'x'], ['one', 'target', ' ']]) {
      expect(() => messageRepo.editAndTruncate(conv, id, content)).toThrow();
    }
    expect(writeJSON).not.toHaveBeenCalled();
    expect(disk.messages).toHaveLength(5);
  });
});
