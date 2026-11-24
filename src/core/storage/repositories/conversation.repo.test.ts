import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { Conversation, Message } from '../../../types';
import type { SubAgentRun } from '../../../types/subAgent.types';

const disk = vi.hoisted(() => ({
  conversations: [] as Conversation[],
  messages: [] as Message[],
}));
vi.mock('../database', () => ({
  readJSON: (file: string) => structuredClone(file === 'conversations.json' ? disk.conversations : disk.messages),
  selectJSON: (_file: string, _fallback: unknown, select: (snapshot: readonly Message[]) => unknown) => structuredClone(select(disk.messages)),
  appendUniqueJSON: (_file: string, matches: (item: Readonly<Message>) => boolean, create: () => Message) => {
    const existing = disk.messages.find(matches);
    if (existing) return structuredClone(existing);
    const message = create();
    disk.messages = [...disk.messages, structuredClone(message)];
    return structuredClone(message);
  },
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

describe('persisted message creation', () => {
  it('deduplicates only within the same conversation and returns detached messages', () => {
    const previous: Message = { id: 'shared', conversationId: 'two', role: 'user', content: 'other chat', createdAt: 1 };
    disk.messages = [previous];
    const input = { id: 'shared', conversationId: 'one', role: 'user' as const, content: 'with photo', images: ['image'] };

    const created = messageRepo.create(input);
    const duplicate = messageRepo.create({ ...input, content: 'duplicate' });
    expect(duplicate).toEqual({ ...input, createdAt: expect.any(Number) });
    expect(disk.messages).toEqual([previous, created]);
    input.images.push('changed input');
    created.images!.push('changed result');
    duplicate.images!.push('changed duplicate');
    expect(messageRepo.findByConversation('one')[0].images).toEqual(['image']);
    expect(messageRepo.findByConversation('two')).toEqual([previous]);
  });
});

describe('sub-agent transcripts', () => {
  const parent: Message = { id: 'parent', conversationId: 'one', role: 'assistant', content: 'Delegating', createdAt: 1 };
  const run: SubAgentRun = {
    id: 'parent:0', conversationId: 'one', task: 'Read the docs', startedAt: 1, status: 'running', messages: [],
  };
  beforeEach(() => { disk.messages = [parent]; });

  it('updates one child without replacing its siblings or expanding the parent transcript', () => {
    const sibling = { ...run, id: 'parent:1', task: 'Review the tests' };
    const finished: SubAgentRun = { ...run, status: 'completed', messages: [{ role: 'assistant', content: 'Findings' }] };
    expect(messageRepo.recordSubAgent(parent.id, run)).toBe(true);
    expect(messageRepo.recordSubAgent(parent.id, sibling)).toBe(true);
    expect(messageRepo.recordSubAgent(parent.id, finished)).toBe(true);
    expect(messageRepo.findByConversation('one')).toEqual([parent]);
    expect(messageRepo.subAgentHistory()).toEqual([finished, sibling]);
  });

  it('never attaches a child to a different conversation or recreates a removed turn', () => {
    expect(messageRepo.recordSubAgent(parent.id, { ...run, conversationId: 'two' })).toBe(false);
    expect(messageRepo.recordSubAgent(parent.id, run)).toBe(true);
    messageRepo.delete(parent.id);
    expect(messageRepo.recordSubAgent(parent.id, run)).toBe(false);
    expect(messageRepo.subAgentHistory()).toEqual([]);
  });
});
