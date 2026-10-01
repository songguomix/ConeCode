import { describe, it, expect, beforeEach } from 'vitest';
import { useAiHighlightsStore, resetAiHighlights } from './aiHighlights.store';

beforeEach(() => resetAiHighlights());

describe('aiHighlights', () => {
  it('marks added lines green per Q&A turn', () => {
    const added = useAiHighlightsStore.getState().markAiEdit({
      filePath: '/p/a.ts',
      original: 'a\nb',
      updated: 'a\nb\nc',
      conversationId: 'c1',
      messageId: 'm1',
    });
    expect(added).toEqual([3]);
    expect(useAiHighlightsStore.getState().lines['/p/a.ts']).toEqual([3]);
    expect(useAiHighlightsStore.getState().turnOf['/p/a.ts']).toBe('m1');
  });

  it('replaces marks on the next edit of the same file', () => {
    const s = useAiHighlightsStore.getState();
    s.markAiEdit({ filePath: '/p/a.ts', original: 'a', updated: 'a\nb', messageId: 'm1' });
    s.markAiEdit({ filePath: '/p/a.ts', original: 'a\nb', updated: 'A\nb', messageId: 'm2' });
    expect(useAiHighlightsStore.getState().lines['/p/a.ts']).toEqual([1]);
    expect(useAiHighlightsStore.getState().turnOf['/p/a.ts']).toBe('m2');
  });

  it('ignores pseudo paths like [Command]', () => {
    const added = useAiHighlightsStore.getState().markAiEdit({
      filePath: '[Command]', original: 'a', updated: 'b', messageId: 'm1',
    });
    expect(added).toEqual([]);
    expect(useAiHighlightsStore.getState().lines['[Command]']).toBeUndefined();
  });

  it('clamps marks that fall outside the current content', () => {
    const s = useAiHighlightsStore.getState();
    s.markAiEdit({ filePath: '/p/a.ts', original: 'a', updated: 'a\nb\nc', messageId: 'm1' });
    s.retainExistingLines('/p/a.ts', 'x\ny');
    expect(useAiHighlightsStore.getState().lines['/p/a.ts']).toEqual([2]);
    s.retainExistingLines('/p/a.ts', '');
    expect(useAiHighlightsStore.getState().lines['/p/a.ts']).toBeUndefined();
  });
});
