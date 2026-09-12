import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useCodeChangesStore } from './codeChanges.store';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';
import type { CodeChange } from './codeChanges.store';
import type { Message } from '../types';

let files: Map<string, string>;
let deletedMessageIds: string[];
const originalFeedToolResults = useChatStore.getState().feedToolResults;

function installStubs() {
  files = new Map();
  deletedMessageIds = [];
  (globalThis as any).window = {
    electronAPI: {
      fs: {
        readFile: async (p: string) => (files.has(p) ? files.get(p)! : null),
        writeFile: async (p: string, c: string) => { files.set(p, c); return true; },
        exists: async (p: string) => files.has(p),
        deleteFile: async (p: string) => files.delete(p),
        createDir: async () => true,
        rename: async () => true,
      },
      message: {
        delete: async (id: string) => { deletedMessageIds.push(id); return true; },
      },
      chat: { stop: async () => true },
    },
  };
}

const message = (id: string, role: Message['role'] = 'assistant'): Message => ({
  id, conversationId: 'conv1', role, content: id, createdAt: 0,
});

const change = (c: Partial<CodeChange>): CodeChange => ({
  id: c.id || 'c', kind: 'edit', filePath: '/a.ts', originalCode: '', newCode: '',
  description: '', status: 'applied', createdAt: 0, conversationId: 'conv1', ...c,
} as CodeChange);

describe('revertToMessage (checkpoint rollback)', () => {
  beforeEach(() => {
    installStubs();
    useChatStore.setState({ messages: [], activeConversationId: 'conv1', isStreaming: false, streamingRuns: {} });
    useChatStore.setState({ feedToolResults: originalFeedToolResults });
    useWorkspaceStore.setState({ selectedFile: null });
    useCodeChangesStore.setState({ changes: [] });
  });

  it('undoes one applied file change without deleting the conversation', async () => {
    files.set('/a.ts', 'v2\n');
    const feedToolResults = vi.fn(async (
      _conversationId: string,
      _providerId: string,
      _modelId: string,
      _content: string,
    ) => {});
    useChatStore.setState({
      messages: [message('m1', 'user'), message('m2')],
      feedToolResults,
    });
    useCodeChangesStore.setState({
      changes: [change({
        id: 'single',
        messageId: 'm2',
        conversationId: 'undo-conv',
        providerId: 'provider',
        modelId: 'model',
        originalCode: 'v1\n',
        newCode: 'v2\n',
      })],
    });

    const result = await useCodeChangesStore.getState().revertChange('single');

    expect(result.success).toBe(true);
    expect(files.get('/a.ts')).toBe('v1\n');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(deletedMessageIds).toEqual([]);
    expect(useCodeChangesStore.getState().changes[0].status).toBe('reverted');
    expect(feedToolResults).toHaveBeenCalledTimes(1);
    expect(feedToolResults.mock.calls[0][3]).toContain('conversation remains');
  });

  it('undoes the code and deletes the whole user turn from memory and storage', async () => {
    files.set('/a.ts', 'v2\n');
    files.set('/b.ts', 'created\n');
    useChatStore.setState({
      messages: [
        message('before-user', 'user'),
        message('before-assistant'),
        message('request', 'user'),
        message('m2'),
        message('m3'),
      ],
    });
    useCodeChangesStore.setState({
      changes: [
        change({ id: 'cA', messageId: 'm2', filePath: '/a.ts', originalCode: 'v1\n', newCode: 'v2\n', createdAt: 1 }),
        change({ id: 'cB', messageId: 'm3', kind: 'create', filePath: '/b.ts', newCode: 'created\n', createdAt: 2 }),
      ],
    });

    const r = await useCodeChangesStore.getState().revertToMessage('m2');

    expect(r.success).toBe(true);
    expect(r.undone).toBe(2);
    expect(files.get('/a.ts')).toBe('v1\n');
    expect(files.has('/b.ts')).toBe(false);
    // The request that initiated the reverted work and every response after it
    // are gone; the previous completed turn remains.
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['before-user', 'before-assistant']);
    expect(deletedMessageIds).toEqual(['request', 'm2', 'm3']);
    expect(useCodeChangesStore.getState().changes.every((c) => c.status === 'reverted')).toBe(true);
  });

  it('unwinds stacked edits to one file newest-first', async () => {
    // Two edits to the same file: reverting the older snapshot first would fail
    // to find its anchor text in the current content.
    files.set('/a.ts', 'v3\n');
    useChatStore.setState({ messages: [message('m1', 'user'), message('m2'), message('m3')] });
    useCodeChangesStore.setState({
      changes: [
        change({ id: 'c1', messageId: 'm2', originalCode: 'v1\n', newCode: 'v2\n', createdAt: 1 }),
        change({ id: 'c2', messageId: 'm3', originalCode: 'v2\n', newCode: 'v3\n', createdAt: 2 }),
      ],
    });

    const r = await useCodeChangesStore.getState().revertToMessage('m2');

    expect(r.success).toBe(true);
    expect(files.get('/a.ts')).toBe('v1\n');
  });

  it('keeps the conversation when a file could not be safely restored', async () => {
    // The user edited the file after the agent did — undoing would clobber their
    // work, so nothing is deleted and the error is reported instead.
    files.set('/a.ts', 'my own rewrite\n');
    useChatStore.setState({ messages: [message('m1', 'user'), message('m2')] });
    useCodeChangesStore.setState({
      changes: [change({ id: 'cA', messageId: 'm2', originalCode: 'v1\n', newCode: 'v2\n' })],
    });

    const r = await useCodeChangesStore.getState().revertToMessage('m2');

    expect(r.success).toBe(false);
    expect(r.error).toContain('manually');
    expect(files.get('/a.ts')).toBe('my own rewrite\n');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['m1', 'm2']);
    expect(deletedMessageIds).toEqual([]);
  });

  it('rolls back around an already-run command instead of refusing', async () => {
    // A command can't be undone, but that must not block rolling back the edits
    // and the transcript — the confirmation already warned about it.
    files.set('/a.ts', 'v2\n');
    useChatStore.setState({ messages: [message('before', 'assistant'), message('request', 'user'), message('m2')] });
    useCodeChangesStore.setState({
      changes: [
        change({ id: 'cA', messageId: 'm2', originalCode: 'v1\n', newCode: 'v2\n', createdAt: 1 }),
        change({ id: 'cX', messageId: 'm2', kind: 'exec', filePath: '[Command]', newCode: 'npm test', createdAt: 2 }),
      ],
    });

    const r = await useCodeChangesStore.getState().revertToMessage('m2');

    expect(r.success).toBe(true);
    expect(files.get('/a.ts')).toBe('v1\n');
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['before']);
    expect(r.retainedEffects).toBe(1);
    expect(useCodeChangesStore.getState().changes.find((c) => c.id === 'cA')!.status).toBe('reverted');
    expect(useCodeChangesStore.getState().changes.find((c) => c.id === 'cX')!.status).toBe('applied');
  });

  it('retains an already-performed computer action without blocking the checkpoint', async () => {
    useChatStore.setState({ messages: [message('before', 'assistant'), message('request', 'user'), message('m2')] });
    useCodeChangesStore.setState({
      changes: [change({
        id: 'computer',
        messageId: 'm2',
        kind: 'computer',
        filePath: '[Computer action]',
        newCode: '{"action":"left_click"}',
      })],
    });

    const result = await useCodeChangesStore.getState().revertToMessage('m2');

    expect(result).toMatchObject({ success: true, undone: 0, retainedEffects: 1 });
    expect(useChatStore.getState().messages.map((m) => m.id)).toEqual(['before']);
    expect(useCodeChangesStore.getState().changes[0].status).toBe('applied');
  });

  it('refuses to label an applied command as reverted through single-change undo', async () => {
    useCodeChangesStore.setState({
      changes: [change({
        id: 'command',
        kind: 'exec',
        filePath: '[Command]',
        newCode: 'npm test',
      })],
    });

    const result = await useCodeChangesStore.getState().revertChange('command');

    expect(result.success).toBe(false);
    expect(result.error).toContain("can't be reverted");
    expect(useCodeChangesStore.getState().changes[0].status).toBe('applied');
  });

  it('leaves changes from earlier messages alone', async () => {
    files.set('/a.ts', 'v1\n');
    files.set('/b.ts', 'v2\n');
    useChatStore.setState({ messages: [message('m1'), message('m2')] });
    useCodeChangesStore.setState({
      changes: [
        change({ id: 'old', messageId: 'm1', filePath: '/a.ts', originalCode: 'v0\n', newCode: 'v1\n' }),
        change({ id: 'new', messageId: 'm2', filePath: '/b.ts', originalCode: 'v1\n', newCode: 'v2\n' }),
      ],
    });

    await useCodeChangesStore.getState().revertToMessage('m2');

    expect(files.get('/a.ts')).toBe('v1\n'); // untouched
    expect(files.get('/b.ts')).toBe('v1\n'); // rolled back
    expect(useCodeChangesStore.getState().changes.find((c) => c.id === 'old')!.status).toBe('applied');
  });

  it('does nothing for an unknown message', async () => {
    useChatStore.setState({ messages: [message('m1')] });
    const r = await useCodeChangesStore.getState().revertToMessage('nope');
    expect(r.success).toBe(false);
    expect(useChatStore.getState().messages).toHaveLength(1);
  });
});
