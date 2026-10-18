import { describe, expect, it } from 'vitest';
import type { CodeChange } from '../../stores/codeChanges.store';
import { bulkApprovableChanges, changesForActiveConversation } from './approvalScope';

const change = (overrides: Partial<CodeChange>): CodeChange => ({
  id: 'change', kind: 'edit', filePath: '/project/a.ts', originalCode: '', newCode: '',
  description: '', status: 'pending', createdAt: 0, ...overrides,
});

describe('remote approval scope', () => {
  it('only exposes changes belonging to the active conversation', () => {
    const scoped = changesForActiveConversation([
      change({ id: 'active', conversationId: 'conv-a' }),
      change({ id: 'other', conversationId: 'conv-b' }),
      change({ id: 'legacy-visible', messageId: 'message-a' }),
      change({ id: 'legacy-hidden', messageId: 'message-b' }),
    ], 'conv-a', new Set(['message-a']));

    expect(scoped.map((item) => item.id)).toEqual(['active', 'legacy-visible']);
  });

  it('shows nothing in a new chat and restores only the selected chat history', () => {
    const history = [change({ id: 'a', conversationId: 'conv-a' }), change({ id: 'b', conversationId: 'conv-b' })];
    expect(changesForActiveConversation(history, null, new Set())).toEqual([]);
    expect(changesForActiveConversation(history, 'new-chat', new Set())).toEqual([]);
    expect(changesForActiveConversation(history, 'conv-b', new Set()).map((c) => c.id)).toEqual(['b']);
    expect(changesForActiveConversation(history, 'conv-a', new Set()).map((c) => c.id)).toEqual(['a']);
  });

  it('never bulk-approves commands or resolved changes', () => {
    expect(bulkApprovableChanges([
      change({ id: 'file' }),
      change({ id: 'command', kind: 'exec' }),
      change({ id: 'done', status: 'applied' }),
    ]).map((item) => item.id)).toEqual(['file']);
  });
});
