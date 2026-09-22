import { describe, expect, it } from 'vitest';
import { groupConversationsByRoot, type GroupableConversation } from './conversationGroups';

function conv(partial: Partial<GroupableConversation> & { id: string }): GroupableConversation {
  return {
    title: partial.id,
    rootPath: null,
    updatedAt: 0,
    ...partial,
  };
}

describe('groupConversationsByRoot', () => {
  it('returns no groups for an empty list', () => {
    expect(groupConversationsByRoot([])).toEqual([]);
  });

  it('groups chats under their mother folder and nests order newest first', () => {
    const groups = groupConversationsByRoot([
      conv({ id: 'old', rootPath: '/Users/me/proj', updatedAt: 10 }),
      conv({ id: 'new', rootPath: '/Users/me/proj', updatedAt: 30 }),
      conv({ id: 'mid', rootPath: '/Users/me/proj', updatedAt: 20 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: '/Users/me/proj', rootPath: '/Users/me/proj', label: 'proj', kind: 'folder' });
    expect(groups[0].conversations.map((c) => c.id)).toEqual(['new', 'mid', 'old']);
  });

  it('keeps different folders in separate groups, most recently active first', () => {
    const groups = groupConversationsByRoot([
      conv({ id: 'a1', rootPath: '/work/alpha', updatedAt: 100 }),
      conv({ id: 'b1', rootPath: '/work/beta', updatedAt: 200 }),
      conv({ id: 'a2', rootPath: '/work/alpha', updatedAt: 50 }),
    ]);

    expect(groups.map((g) => g.key)).toEqual(['/work/beta', '/work/alpha']);
    expect(groups[0].label).toBe('beta');
    expect(groups[1].conversations.map((c) => c.id)).toEqual(['a1', 'a2']);
  });

  it('puts the no-project group last and uses kind none', () => {
    const groups = groupConversationsByRoot([
      conv({ id: 'loose-new', rootPath: null, updatedAt: 999 }),
      conv({ id: 'in-proj', rootPath: '/p', updatedAt: 1 }),
    ]);

    expect(groups.map((g) => g.kind)).toEqual(['folder', 'none']);
    expect(groups[1]).toMatchObject({ key: '', rootPath: null, label: '' });
    expect(groups[1].conversations.map((c) => c.id)).toEqual(['loose-new']);
  });

  it('treats empty and missing rootPath as the same no-project group', () => {
    const groups = groupConversationsByRoot([
      conv({ id: 'a', rootPath: undefined, updatedAt: 2 }),
      conv({ id: 'b', rootPath: '', updatedAt: 1 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].kind).toBe('none');
    expect(groups[0].conversations.map((c) => c.id)).toEqual(['a', 'b']);
  });

  it('normalizes trailing slashes so one folder is one group', () => {
    const groups = groupConversationsByRoot([
      conv({ id: 'a', rootPath: '/Users/me/web', updatedAt: 2 }),
      conv({ id: 'b', rootPath: '/Users/me/web/', updatedAt: 1 }),
    ]);

    expect(groups).toHaveLength(1);
    expect(groups[0].key).toBe('/Users/me/web');
  });

  it('disambiguates same-named folders via rootLabel', () => {
    const groups = groupConversationsByRoot([
      conv({ id: 'a', rootPath: '/one/web', updatedAt: 1 }),
      conv({ id: 'b', rootPath: '/two/web', updatedAt: 2 }),
    ]);

    const labels = Object.fromEntries(groups.map((g) => [g.key, g.label]));
    expect(labels['/one/web']).toBe('one/web');
    expect(labels['/two/web']).toBe('two/web');
  });

  it('prefers caller-supplied labels over path-derived ones', () => {
    const labels = new Map([['/Users/me/proj', 'My Project']]);
    const groups = groupConversationsByRoot(
      [conv({ id: 'a', rootPath: '/Users/me/proj', updatedAt: 1 })],
      labels,
    );

    expect(groups[0].label).toBe('My Project');
  });
});
