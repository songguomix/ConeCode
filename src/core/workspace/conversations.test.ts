import { describe, it, expect } from 'vitest';
import {
  groupConversationsByFolder, folderDisplayName, isChatConversation, isWorkConversation,
  isBlankConversation, pickReusableConversation,
  groupOpenProjectConversations,
} from './conversations';
import { defaultRsiState } from '../agents/rsiConversation';
import type { Conversation } from '../../types';

const conv = (id: string, rootPath: string | null, updatedAt: number, isChatMode?: boolean): Conversation => ({
  id, title: id, providerId: 'p', modelId: 'm', rootPath, createdAt: updatedAt, updatedAt, isChatMode,
});

describe('groupOpenProjectConversations', () => {
  it('keeps empty open folders and puts each chat under its own project', () => {
    const a = conv('a', '/app', 3);
    const b = conv('b', '/api', 2);
    const c = conv('c', '/app', 1);
    expect(groupOpenProjectConversations([a, b, c], ['/app', '/empty', '/api', '/app']))
      .toEqual([['/app', [a, c]], ['/empty', []], ['/api', [b]]]);
  });

  it('keeps closed projects after the open ones so no chat is orphaned', () => {
    const work = conv('work', '/app', 1);
    const older = conv('older', '/closed', 2);
    const newer = conv('newer', '/gone', 3);
    const list = [work, older, newer, conv('chat', null, 4),
      conv('chat-only', '/app', 5, true), { ...conv('rsi', '/app', 6), agentMode: 'rsi' as const }];
    expect(groupOpenProjectConversations(list, ['/app'])).toEqual([
      ['/app', [work]], ['/gone', [newer]], ['/closed', [older]],
    ]);
    expect(groupOpenProjectConversations(list, [])).toEqual([
      ['/gone', [newer]], ['/closed', [older]], ['/app', [work]],
    ]);
  });
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

const blank = (
  id: string,
  rootPath: string | null,
  updatedAt: number,
  overrides: Partial<Conversation> = {},
): Conversation => ({
  ...conv(id, rootPath, updatedAt),
  title: 'New Chat',
  ...overrides,
});

describe('isBlankConversation', () => {
  it('treats a default-titled, message-less conversation as unused', () => {
    expect(isBlankConversation(blank('a', null, 1), 0)).toBe(true);
  });

  it('never treats a conversation with messages, a custom title, or RSI state as unused', () => {
    expect(isBlankConversation(blank('a', null, 1), 1)).toBe(false);
    expect(isBlankConversation({ ...blank('a', null, 1), title: 'Research' }, 0)).toBe(false);
    const rsi = { ...blank('r', '/proj', 1), agentMode: 'rsi' as const, rsi: defaultRsiState() };
    expect(isBlankConversation(rsi, 0)).toBe(true);
    expect(isBlankConversation({
      ...rsi,
      rsi: { ...rsi.rsi!, directionConfig: { ...rsi.rsi!.directionConfig, objective: 'ship it' } },
    }, 0)).toBe(false);
    expect(isBlankConversation({
      ...rsi,
      rsi: { ...rsi.rsi!, runs: [{ id: 'run', status: 'completed', iteration: 1, result: null, createdAt: 1, updatedAt: 1 }] },
    }, 0)).toBe(false);
  });
});

describe('pickReusableConversation', () => {
  it('prefers the active blank conversation', () => {
    const active = blank('active', null, 1);
    const older = blank('older', null, 99);
    const picked = pickReusableConversation(
      [older, active], 'chat', null, active.id, 0, { active: 0, older: 0 },
    );
    expect(picked?.id).toBe('active');
  });

  it('reuses the newest blank conversation when the active one is used', () => {
    const used = blank('used', null, 3);
    const older = blank('older', null, 1);
    const newer = blank('newer', null, 2);
    const picked = pickReusableConversation(
      [used, older, newer], 'chat', null, used.id, 2, { used: 2, older: 0, newer: 0 },
    );
    expect(picked?.id).toBe('newer');
  });

  it('does not cross modes or folders', () => {
    const chat = blank('chat', null, 1);
    const otherFolder = blank('other', '/proj/other', 2);
    expect(pickReusableConversation([chat], 'work', '/proj/app', null, 0, {})).toBeNull();
    expect(pickReusableConversation([otherFolder], 'work', '/proj/app', null, 0, { other: 0 })).toBeNull();
  });

  it('reuses a blank RSI conversation only in the same workspace', () => {
    const rsi = (id: string, rootPath: string | null): Conversation => ({
      ...blank(id, rootPath, 1),
      agentMode: 'rsi',
      rsi: defaultRsiState(),
    });
    expect(pickReusableConversation([rsi('r1', '/proj/app')], 'rsi', '/proj/app', null, 0, { r1: 0 })?.id).toBe('r1');
    expect(pickReusableConversation([rsi('r2', '/proj/other')], 'rsi', '/proj/app', null, 0, { r2: 0 })).toBeNull();
  });

  it('treats unknown counts as used when the main process cannot report them', () => {
    const blankConv = blank('a', null, 1);
    expect(pickReusableConversation([blankConv], 'chat', null, null, 0, null)).toBeNull();
    expect(pickReusableConversation([blankConv], 'chat', null, 'a', 0, null)?.id).toBe('a');
  });
});
