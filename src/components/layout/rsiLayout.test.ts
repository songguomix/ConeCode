import { describe, expect, it } from 'vitest';
import { rsiSidebarLayout, workbenchVisible } from './rsiLayout';

describe('rsiSidebarLayout', () => {
  it('hides the file explorer and gives RSI the full conversation area', () => {
    const layout = rsiSidebarLayout({ agentMode: 'rsi', viewMode: 'work' });
    expect(layout).toMatchObject({
      isRsi: true,
      showFolderHint: true,
      showFileExplorer: false,
      fillConversations: true,
    });
  });

  it('keeps RSI isolated even when viewMode is chat', () => {
    const layout = rsiSidebarLayout({ agentMode: 'rsi', viewMode: 'chat' });
    expect(layout.showFolderHint).toBe(true);
    expect(layout.showFileExplorer).toBe(false);
    expect(layout.fillConversations).toBe(true);
  });

  it('gives Work projects the full list without a separate file tree', () => {
    const layout = rsiSidebarLayout({ agentMode: 'standard', viewMode: 'work' });
    expect(layout).toMatchObject({
      isRsi: false,
      showFolderHint: false,
      showFileExplorer: false,
      fillConversations: true,
    });
  });

  it('keeps the Chat list full height with no folder hint', () => {
    const layout = rsiSidebarLayout({ agentMode: 'goal', viewMode: 'chat' });
    expect(layout.showFolderHint).toBe(false);
    expect(layout.showFileExplorer).toBe(false);
    expect(layout.fillConversations).toBe(true);
  });
});

describe('workbenchVisible', () => {
  it('keeps the editor in Work mode', () => {
    expect(workbenchVisible({ agentMode: 'standard', selectedFile: '/project/src/a.ts' })).toBe(true);
  });

  it('gives the whole center column to the RSI conversation', () => {
    expect(workbenchVisible({ agentMode: 'rsi', selectedFile: '/project/src/a.ts' })).toBe(false);
  });

  it('stays hidden when no file is selected', () => {
    expect(workbenchVisible({ agentMode: 'rsi', selectedFile: null })).toBe(false);
    expect(workbenchVisible({ agentMode: 'standard', selectedFile: null })).toBe(false);
  });
});
