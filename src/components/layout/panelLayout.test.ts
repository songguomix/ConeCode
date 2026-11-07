import { describe, expect, it } from 'vitest';
import { panelLayout } from './panelLayout';

const panels = { width: 1280, height: 720, sidebarOpen: true, sidebarWidth: 260, previewOpen: true, previewWidth: 720, editorOpen: true, terminalHeight: 640 };

describe('workbench layout', () => {
  it('reserves space for the editor and conversation when all docks are open', () => {
    const result = panelLayout(panels);
    expect(result.previewOverlay).toBe(false);
    expect(panels.width - result.sidebar - result.preview).toBeGreaterThanOrEqual(640);
    expect(panels.height - result.terminal).toBeGreaterThanOrEqual(260);
  });

  it('overlays secondary panels and stacks the editor in a narrow window', () => {
    const result = panelLayout({ ...panels, width: 600 });
    expect(result.sidebarOverlay).toBe(true);
    expect(result.previewOverlay).toBe(true);
    expect(result.stackedEditor).toBe(true);
    expect(result.preview).toBeLessThanOrEqual(552);
  });

  it('keeps the composer above the terminal when the editor stacks', () => {
    const result = panelLayout({ ...panels, width: 600, height: 620 });
    expect(620 - result.terminal).toBeGreaterThanOrEqual(480);
    expect(result.terminal).toBeLessThanOrEqual(result.terminalMax);
  });

  it('restores preferred dimensions when the window has enough space', () => {
    const result = panelLayout({ ...panels, width: 1920, height: 1080 });
    expect(result.sidebar).toBe(panels.sidebarWidth);
    expect(result.preview).toBe(panels.previewWidth);
    expect(result.terminal).toBe(panels.terminalHeight);
    expect(result.stackedEditor).toBe(false);
  });
});
