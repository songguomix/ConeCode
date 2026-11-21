import { describe, expect, it } from 'vitest';
import { indexSidebarChanges } from './sidebarChanges';

describe('sidebar change badges', () => {
  it('keeps the first two distinct filenames and excludes tool-only entries', () => {
    const indexed = indexSidebarChanges([
      { conversationId: 'work', filePath: '[exec]', kind: 'exec' },
      { conversationId: 'work', filePath: '/project/src/index.ts', kind: 'edit' },
      { conversationId: 'work', filePath: '/project/test/index.ts', kind: 'edit' },
      { conversationId: 'work', filePath: '/project/README.md', kind: 'create' },
      { conversationId: 'work', filePath: '/project/shared.ts', kind: 'edit' },
      { filePath: '/project/unassigned.ts', kind: 'create' },
    ], ['/project/shared.ts']);

    expect([...indexed]).toEqual([['work', { fileNames: ['index.ts', 'README.md'], hasAiChanges: true }]]);
  });

  it('keeps AI badges scoped to conversations that edited or created a highlighted file', () => {
    const indexed = indexSidebarChanges([
      { conversationId: 'edited', filePath: '/project/main.ts', kind: 'edit' },
      { conversationId: 'deleted', filePath: '/project/main.ts', kind: 'delete' },
      { conversationId: 'other', filePath: '/project/other.ts', kind: 'create' },
    ], ['/project/main.ts']);

    expect(indexed.get('edited')?.hasAiChanges).toBe(true);
    expect(indexed.get('deleted')?.hasAiChanges).toBe(false);
    expect(indexed.get('other')?.hasAiChanges).toBe(false);
  });
});
