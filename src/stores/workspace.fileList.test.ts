import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useWorkspaceStore } from './workspace.store';

beforeEach(() => {
  useWorkspaceStore.setState({ rootPath: '/old', files: [], extraRoots: [], fileList: null });
});

describe('mention file list', () => {
  it('does not overwrite the current workspace with a late scan', async () => {
    let resolve!: (value: { files: string[] }) => void;
    vi.stubGlobal('window', { electronAPI: { fs: { glob: () => new Promise((done) => { resolve = done; }) } } });
    const pending = useWorkspaceStore.getState().ensureFileList();
    useWorkspaceStore.setState({ rootPath: '/new', files: [], fileList: ['new.ts'] });
    resolve({ files: ['/old/old.ts'] });
    expect(await pending).toEqual(['new.ts']);
    expect(useWorkspaceStore.getState().fileList).toEqual(['new.ts']);
  });

  it('discards a scan started before the current folder was refreshed', async () => {
    let resolve!: (value: { files: string[] }) => void;
    vi.stubGlobal('window', { electronAPI: { fs: { glob: () => new Promise((done) => { resolve = done; }) } } });
    const pending = useWorkspaceStore.getState().ensureFileList();
    useWorkspaceStore.setState({ files: [], fileList: null });
    resolve({ files: ['/old/deleted.ts'] });
    expect(await pending).toEqual([]);
    expect(useWorkspaceStore.getState().fileList).toBeNull();
  });
});
