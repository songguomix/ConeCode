import { beforeEach, describe, expect, it } from 'vitest';
import { useCodeChangesStore, type CodeChange } from './codeChanges.store';
import { useWorkspaceStore } from './workspace.store';

const pending = (): CodeChange => ({
  id: 'change', kind: 'edit', filePath: '/project/a.ts', originalCode: 'old', newCode: 'new',
  description: '', status: 'pending', createdAt: 0,
});

describe('change application status', () => {
  beforeEach(() => {
    (globalThis as any).window = {
      electronAPI: { fs: { writeFile: async () => false } },
    };
    useWorkspaceStore.setState({ selectedFile: null, rootPath: '/project' });
    useCodeChangesStore.setState({ changes: [pending()] });
  });

  it('marks a failed manual action as failed instead of applied', async () => {
    const result = await useCodeChangesStore.getState().applyChange('change');
    expect(result.success).toBe(false);
    expect(useCodeChangesStore.getState().changes[0].status).toBe('failed');
  });

  it('marks a failed automatic action as failed instead of applied', async () => {
    const result = await useCodeChangesStore.getState().autoApply('change');
    expect(result.success).toBe(false);
    expect(useCodeChangesStore.getState().changes[0].status).toBe('failed');
  });
});
