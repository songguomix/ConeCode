import { beforeEach, describe, expect, it } from 'vitest';
import { useUIStore } from './ui.store';

const floating = () => {
  const s = useUIStore.getState();
  return {
    changedFilesOpen: s.changedFilesOpen,
    reviewOpen: s.reviewOpen,
    backgroundOpen: s.backgroundOpen,
    worktreesOpen: s.worktreesOpen,
    remoteOpen: s.remoteOpen,
    computerOpen: s.computerOpen,
  };
};

const openCount = () => Object.values(floating()).filter(Boolean).length;

beforeEach(() => {
  useUIStore.setState({
    changedFilesOpen: false,
    reviewOpen: false,
    backgroundOpen: false,
    worktreesOpen: false,
    remoteOpen: false,
    computerOpen: false,
  });
});

describe('floating panels', () => {
  it('opening a second panel closes the first so the picked one is in front', () => {
    useUIStore.getState().toggleChangedFiles();
    expect(floating()).toMatchObject({ changedFilesOpen: true });

    useUIStore.getState().toggleBackground();
    expect(floating()).toMatchObject({ backgroundOpen: true, changedFilesOpen: false });
    expect(openCount()).toBe(1);
  });

  it('toggling the open panel again closes it', () => {
    useUIStore.getState().toggleReview();
    useUIStore.getState().toggleReview();
    expect(openCount()).toBe(0);
  });

  it('works across every floating panel', () => {
    const order = [
      'toggleChangedFiles',
      'toggleReview',
      'toggleBackground',
      'toggleWorktrees',
      'toggleRemote',
      'toggleComputer',
    ] as const;
    for (const toggle of order) {
      useUIStore.getState()[toggle]();
      expect(openCount()).toBe(1);
    }
  });
});
