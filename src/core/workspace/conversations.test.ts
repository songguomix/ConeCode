import { describe, it, expect } from 'vitest';
import { groupConversationsByFolder, folderDisplayName, isChatConversation, isWorkConversation } from './conversations';
import { defaultRsiState } from '../agents/rsiConversation';
import type { Conversation } from '../../types';

const conv = (id: string, rootPath: string | null, updatedAt: number, isChatMode?: boolean): Conversation => ({
  id, title: id, providerId: 'p', modelId: 'm', rootPath, createdAt: updatedAt, updatedAt, isChatMode,
});

describe('groupConversationsByFolder', () => {
  it('groups multiple chats under the same folder', () => {
    const list = [
      conv('a', '/proj/foo', 3),
      conv('b', '/proj/foo', 2),
      conv('c', '/proj/bar', 1),
    ];
    const groups = groupConversationsByFolder(list, null);
    expect(groups).toHaveLength(2);
    expect(groups.find(([k]) => k === '/proj/foo')?.[1].map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('puts the current folder first', () => {
    const list = [
      conv('a', '/proj/foo', 1),
      conv('b', '/proj/bar', 100),
    ];
    const groups = groupConversationsByFolder(list, '/proj/foo');
    expect(groups[0][0]).toBe('/proj/foo');
  });

  it('keeps Chat below every Work group even when Chat is most recent', () => {
    const list = [conv('chat', null, 1000), conv('work', '/other', 2), conv('current', '/current', 1)];
    expect(groupConversationsByFolder(list, '/current').map(([key]) => key)).toEqual(['/current', '/other', '']);
    expect(groupConversationsByFolder(list, null).map(([key]) => key)).toEqual(['/other', '/current', '']);
  });

  it('keeps unbound chats in their own group', () => {
    const list = [conv('a', null, 1), conv('b', '/x', 2)];
    const groups = groupConversationsByFolder(list, '/x');
    expect(groups[0][0]).toBe('/x');
    expect(groups[1][0]).toBe('');
  });
});

describe('folderDisplayName', () => {
  it('uses the last path segment', () => {
    expect(folderDisplayName('/a/b/foo')).toBe('foo');
    expect(folderDisplayName('')).toBe('');
  });
});

describe('isChatConversation & isWorkConversation isolation', () => {
  it('correctly classifies unbound and chat-mode conversations as chat', () => {
    const unbound = conv('c1', null, 1);
    const explicitChat = conv('c2', null, 2, true);
    expect(isChatConversation(unbound)).toBe(true);
    expect(isWorkConversation(unbound)).toBe(false);
    expect(isChatConversation(explicitChat)).toBe(true);
    expect(isWorkConversation(explicitChat)).toBe(false);
  });

  it('correctly classifies folder-bound conversations as work', () => {
    const work = conv('w1', '/proj/app', 1, false);
    const legacyWork = conv('w2', '/proj/app', 2);
    expect(isWorkConversation(work)).toBe(true);
    expect(isChatConversation(work)).toBe(false);
    expect(isWorkConversation(legacyWork)).toBe(true);
    expect(isChatConversation(legacyWork)).toBe(false);
  });

  it('excludes RSI conversations from both chat and work', () => {
    const rsi1: Conversation = {
      ...conv('r1', '/proj/app', 1),
      agentMode: 'rsi',
      rsi: defaultRsiState(),
    };
    const rsi2: Conversation = {
      ...conv('r2', null, 2),
      agentMode: 'rsi',
      rsi: defaultRsiState(),
    };
    expect(isChatConversation(rsi1)).toBe(false);
    expect(isWorkConversation(rsi1)).toBe(false);
    expect(isChatConversation(rsi2)).toBe(false);
    expect(isWorkConversation(rsi2)).toBe(false);
  });
});
