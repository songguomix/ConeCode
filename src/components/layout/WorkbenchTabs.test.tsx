import { afterAll, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

const ui = vi.hoisted(() => ({ sidebarOpen: false, previewOpen: true }));

vi.mock('../../stores', () => ({
  useUIStore: (select: (state: typeof ui) => unknown) => select(ui),
  useWorkspaceStore: (select: (state: { openTabs: string[] }) => unknown) => select({ openTabs: [] }),
  useAiHighlightsStore: () => ({}),
  usePreviewStore: () => 'idle',
  useLanguageStore: () => ({ t: (key: string) => key }),
}));

vi.stubGlobal('navigator', { platform: 'MacIntel', userAgent: 'Macintosh' });
const { default: WorkbenchTabs } = await import('./WorkbenchTabs');
afterAll(() => vi.unstubAllGlobals());

describe('macOS workbench tab placement', () => {
  it.each([true, false])('aligns the right preview tabs with the dock when sidebarOpen is %s', (sidebarOpen) => {
    ui.sidebarOpen = sidebarOpen;
    const html = renderToStaticMarkup(<WorkbenchTabs active="preview" />);

    expect(html).toContain('data-active="true"');
    expect(html).not.toContain('padding-left:');
  });

  it('reserves space for window controls only when the left editor is exposed', () => {
    ui.sidebarOpen = false;
    expect(renderToStaticMarkup(<WorkbenchTabs active="code" />)).toContain('padding-left:74px');

    ui.sidebarOpen = true;
    expect(renderToStaticMarkup(<WorkbenchTabs active="code" />)).not.toContain('padding-left:');
  });
});
