import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComputerPreviewSurface, newerPreviewState } from './ComputerPreviewWindow';
import type { ComputerPreviewSnapshot } from '../../core/computer/preview';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6R8sAAAAASUVORK5CYII=';
function snapshot(revision = 1): ComputerPreviewSnapshot {
  return {
    revision, updatedAt: 1000,
    status: { platform: 'darwin', enabled: true, supported: true, accessibility: true, screenRecording: true, geometry: null },
    shot: { dataUrl: pixel, capturedAt: 1000, geometry: { logicalWidth: 1200, logicalHeight: 800, captureWidth: 1200, captureHeight: 800 } },
    activity: [{ id: 1, at: 1000, description: 'Private action description', ok: true }], inFlight: 0,
  };
}
const render = (state: ComputerPreviewSnapshot | null) => renderToStaticMarkup(
  <ComputerPreviewSurface snapshot={state} waiting="等待画面" unavailable="暂时无法连接" />,
);

describe('display-only native floating preview', () => {
  it('displays only the observed image without controls, nested application or chrome', () => {
    const html = render(snapshot());
    expect(html).toContain(pixel);
    expect(html).toContain('<img');
    for (const tag of ['button', 'header', 'footer', 'iframe', 'webview']) expect(html).not.toContain(`<${tag}`);
    expect(html).not.toContain('Private action description');
    expect(html).not.toContain('computer-preview-shell');
  });

  it('does not restore a stopped screen from a delayed initial pull', () => {
    const older = snapshot(4);
    const stopped = { ...snapshot(5), status: { ...snapshot().status, enabled: false }, shot: null };
    expect(newerPreviewState(stopped, older)).toBe(stopped);
    expect(newerPreviewState(stopped, { ...older, revision: Number.NaN })).toBe(stopped);
    expect(render({ ...older, status: { ...older.status, enabled: false } })).not.toContain('<img');
  });

  it('never renders remote or executable image sources', () => {
    for (const url of ['https://external.example/shot.png', 'data:image/svg+xml,<svg onload="alert(1)"/>']) {
      const state = snapshot();
      state.shot!.dataUrl = url;
      const html = render(state);
      expect(html).not.toContain('<img');
      expect(html).not.toContain(url);
    }
    expect(render(null)).toContain('等待画面');
  });
});
