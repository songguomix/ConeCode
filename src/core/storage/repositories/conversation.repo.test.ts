import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../../../types';

const disk = vi.hoisted(() => ({
  conversations: [] as Conversation[],
  messages: [] as Message[],
}));
vi.mock('../database', () => ({
  readJSON: (file: string) => structuredClone(file === 'conversations.json' ? disk.conversations : disk.messages),
  writeJSON: vi.fn((file: string, records: Conversation[] | Message[]) => {
    if (file === 'conversations.json') disk.conversations = structuredClone(records as Conversation[]);
    else disk.messages = structuredClone(records as Message[]);
  }),
}));
import { conversationRepo, messageRepo } from './conversation.repo';
import { writeJSON } from '../database';

describe('persisted conversation archive', () => {
  it('archives and restores a legacy conversation without changing its activity or transcript', () => {
    const conversation = {
      id: 'one', title: 'Old project', providerId: 'p1', modelId: 'm1',
      rootPath: '/workspace/project', createdAt: 1, updatedAt: 2,
    };
    const message: Message = { id: 'first', conversationId: 'one', role: 'user', content: 'Keep me', createdAt: 1 };
    disk.conversations = [conversation];
    disk.messages = [message];

    const archived = conversationRepo.setArchived(conversation.id, true);
    expect(archived).toEqual({ ...conversation, archivedAt: expect.any(Number) });
    expect(conversationRepo.findAll()).toEqual([archived]);
    expect(conversationRepo.setArchived(conversation.id, true)).toEqual(archived);
    expect(conversationRepo.setArchived(conversation.id, false)).toEqual({ ...conversation, archivedAt: null });
    expect(conversationRepo.findById(conversation.id)?.archivedAt).toBeNull();
    expect(messageRepo.findByConversation(conversation.id)).toEqual([message]);
  });
});

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
