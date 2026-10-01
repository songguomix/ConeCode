import { describe, it, expect } from 'vitest';
import { groupConversationsByFolder, folderDisplayName } from './conversations';
import type { Conversation } from '../../types';

const conv = (id: string, rootPath: string | null, updatedAt: number): Conversation => ({
  id, title: id, providerId: 'p', modelId: 'm', rootPath, createdAt: updatedAt, updatedAt,
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
