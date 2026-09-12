import { describe, expect, it } from 'vitest';
import type { CodeChange } from '../../stores/codeChanges.store';
import { commandsForConversation, pendingFileChanges } from './approvalPresentation';

const change = (overrides: Partial<CodeChange>): CodeChange => ({
  id: 'change',
  kind: 'edit',
  filePath: '/workspace/file.ts',
  originalCode: '',
  newCode: '',
  description: '',
  status: 'pending',
  createdAt: 1,
  ...overrides,
});

describe('approval presentation', () => {
  it('never includes commands in batch file approval', () => {
    const file = change({ id: 'file' });
    const command = change({ id: 'command', kind: 'exec' });
    const appliedFile = change({ id: 'applied', status: 'applied' });

    expect(pendingFileChanges([file, command, appliedFile]).map((item) => item.id)).toEqual(['file']);
  });

  it('scopes and orders command dialogs to the active conversation', () => {
    const commands = commandsForConversation([
      change({ id: 'later', kind: 'exec', conversationId: 'active', createdAt: 2 }),
      change({ id: 'other', kind: 'exec', conversationId: 'other', createdAt: 0 }),
      change({ id: 'first', kind: 'exec', conversationId: 'active', createdAt: 1 }),
      change({ id: 'legacy', kind: 'exec', messageId: 'visible', createdAt: 3 }),
    ], 'active', new Set(['visible']));

    expect(commands.map((item) => item.id)).toEqual(['first', 'later', 'legacy']);
  });
});
