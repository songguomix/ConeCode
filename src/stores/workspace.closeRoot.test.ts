import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useWorkspaceStore } from './workspace.store';
import { useChatStore } from './chat.store';

function installStubs() {
  (globalThis as any).window = {
    electronAPI: {
      conversation: { update: vi.fn(async () => {}) },
      app: { getSystemInfo: async () => ({ homedir: '/home/test' }) },
      fs: {
        readDir: async () => [],
        readFile: async () => null,
        readFileBase64: async () => null,
      },
    },
  };
}

const file = (path: string) => ({ name: path.split('/').pop()!, path, isDirectory: false });

beforeEach(() => {
  installStubs();
  useWorkspaceStore.setState({
    rootPath: null,
    files: [],
    extraRoots: [],
    selectedFile: null,
    fileContent: null,
    selectedFileIsImage: false,
    openTabs: [],
    dirtyTabs: {},
    contextFiles: [],
    fileList: null,
  });
  useChatStore.setState({ activeConversationId: null });
});

describe('closeRoot (single click on a folder)', () => {
  it('closing the last folder leaves a blank project', () => {
    useWorkspaceStore.setState({
      rootPath: '/a',
      files: [file('/a/x.ts')],
      openTabs: ['/a/x.ts'],
      selectedFile: '/a/x.ts',
      fileContent: 'x',
    });
    useWorkspaceStore.getState().closeRoot('/a');
    const s = useWorkspaceStore.getState();
    expect(s.rootPath).toBeNull();
    expect(s.files).toEqual([]);
    expect(s.extraRoots).toEqual([]);
    expect(s.openTabs).toEqual([]);
    expect(s.selectedFile).toBeNull();
  });

  it('closing an extra folder detaches only it', () => {
    useWorkspaceStore.setState({
      rootPath: '/a',
      files: [file('/a/x.ts')],
      extraRoots: [{ path: '/b', files: [file('/b/y.ts')] }],
      openTabs: ['/a/x.ts', '/b/y.ts'],
      selectedFile: '/b/y.ts',
      fileContent: 'y',
    });
    useWorkspaceStore.getState().closeRoot('/b');
    const s = useWorkspaceStore.getState();
    expect(s.rootPath).toBe('/a');
    expect(s.extraRoots).toEqual([]);
    expect(s.openTabs).toEqual(['/a/x.ts']);
  });

  it('closing the primary promotes the first extra folder', async () => {
    useWorkspaceStore.setState({
      rootPath: '/a',
      files: [file('/a/x.ts')],
      extraRoots: [
        { path: '/b', files: [file('/b/y.ts')] },
        { path: '/c', files: [] },
      ],
    });
    useWorkspaceStore.getState().closeRoot('/a');
    await vi.waitFor(() => expect(useWorkspaceStore.getState().rootPath).toBe('/b'));
    const s = useWorkspaceStore.getState();
    expect(s.extraRoots.map((r) => r.path)).toEqual(['/c']);
  });

  it('ignores a path that is not open', () => {
    useWorkspaceStore.setState({ rootPath: '/a', files: [file('/a/x.ts')] });
    useWorkspaceStore.getState().closeRoot('/nope');
    expect(useWorkspaceStore.getState().rootPath).toBe('/a');
  });
});
