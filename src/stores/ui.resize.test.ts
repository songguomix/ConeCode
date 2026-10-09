import { describe, expect, it } from 'vitest';
import { clampEditorWidth, clampSidebarWidth, clampPreviewWidth, clampTerminalHeight } from './ui.store';

describe('resizable panel clamps (nothing drags shut or blows out)', () => {
  it('clamps the sidebar width', () => {
    expect(clampSidebarWidth(260)).toBe(260);
    expect(clampSidebarWidth(50)).toBe(200);
    expect(clampSidebarWidth(900)).toBe(480);
  });

  it('clamps the preview dock width', () => {
    expect(clampPreviewWidth(480)).toBe(480);
    expect(clampPreviewWidth(100)).toBe(280);
    expect(clampPreviewWidth(2000)).toBe(720);
  });

  it('clamps the terminal height', () => {
    expect(clampTerminalHeight(280)).toBe(280);
    expect(clampTerminalHeight(10)).toBe(120);
    expect(clampTerminalHeight(2000)).toBe(640);
  });

  it('keeps the existing editor split clamp', () => {
    expect(clampEditorWidth(50)).toBe(50);
    expect(clampEditorWidth(5)).toBe(20);
    expect(clampEditorWidth(95)).toBe(80);
  });
});
