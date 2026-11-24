import { describe, expect, it } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { ComputerPreviewSurface, newerPreviewState, pointInPreviewImage } from './ComputerPreviewWindow';
import type { ComputerPreviewSnapshot } from '../../core/computer/preview';

const pixel = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl6R8sAAAAASUVORK5CYII=';
const target = { id: '11:1', name: 'Editor', title: 'Document' };
function snapshot(revision = 1): ComputerPreviewSnapshot {
  return {
    revision, updatedAt: 1000,
    status: { platform: 'darwin', enabled: true, supported: true, accessibility: true, screenRecording: true, geometry: null, target, targetRevision: 1, frameId: 'frame1' },
    shot: { dataUrl: pixel, target, frameId: 'frame1', capturedAt: 1000, geometry: { logicalWidth: 1200, logicalHeight: 800, captureWidth: 1200, captureHeight: 800 } },
    activity: [{ id: 1, at: 1000, description: 'Private action description', ok: true }], inFlight: 0,
  };
}
const render = (state: ComputerPreviewSnapshot | null) => renderToStaticMarkup(
  <ComputerPreviewSurface snapshot={state} waiting="等待画面" unavailable="暂时无法连接" />,
);

describe('native floating preview', () => {
  it('displays the observed image without activity details or an embedded application', () => {
    const html = render(snapshot());
    expect(html).toContain(pixel);
    expect(html).toContain('<img');
    for (const tag of ['button', 'header', 'footer', 'iframe', 'webview']) expect(html).not.toContain(`<${tag}`);
    expect(html).not.toContain('Private action description');
    expect(html).not.toContain('computer-preview-shell');
  });

  it('positions the cursor inside its screenshot and pulses after a click is sent', () => {
    const state = snapshot();
    state.pointer = { id: 1, frameId: 'frame1', coordinate: [300, 400], action: 'left_click', phase: 'pending', source: 'agent' };
    const pending = render(state);
    expect(pending).toContain('data-phase="pending" data-source="agent"');
    expect(pending).toContain('left:25%;top:50%');
    expect(pending).not.toContain('computer-preview-pulse');
    state.pointer.phase = 'sent';
    state.pointer.source = 'manual';
    expect(render(state)).toContain('data-phase="sent" data-source="manual"');
    expect(render(state)).toContain('computer-preview-pulse');
    state.pointer.frameId = 'older-frame';
    expect(render(state)).not.toContain('computer-preview-pointer');
  });

  it('keeps refresh available without a frame and starts with manual control inactive', () => {
    const state = snapshot();
    const controls = { act: async () => ({ ok: true, message: '' }), refresh: async () => ({ ok: true, message: '' }) };
    const html = renderToStaticMarkup(<ComputerPreviewSurface snapshot={{ ...state, shot: null }} waiting="waiting" unavailable="unavailable" controls={controls} />);
    expect(html).toMatch(/aria-pressed="false" data-testid="computer-preview-control" disabled=""/);
    expect(html).toMatch(/data-testid="computer-preview-refresh"><svg/);
  });

  it('maps only points inside a scaled and letterboxed screenshot into capture pixels', () => {
    const geometry = snapshot().shot!.geometry;
    const bounds = { left: 50, top: 20, width: 300, height: 200 };
    expect(pointInPreviewImage(50, 20, bounds, geometry)).toEqual([0, 0]);
    expect(pointInPreviewImage(125, 120, bounds, geometry)).toEqual([300, 400]);
    expect(pointInPreviewImage(349.9, 219.9, bounds, geometry)).toEqual([1199, 799]);
    expect(pointInPreviewImage(49, 120, bounds, geometry)).toBeNull();
    expect(pointInPreviewImage(350, 220, bounds, geometry)).toBeNull();
  });

  it('does not restore a stopped screen from a delayed initial pull', () => {
    const older = snapshot(4);
    const stopped = { ...snapshot(5), status: { ...snapshot().status, enabled: false }, shot: null };
    expect(newerPreviewState(stopped, older)).toBe(stopped);
    expect(newerPreviewState(stopped, { ...older, revision: Number.NaN })).toBe(stopped);
    expect(render({ ...older, status: { ...older.status, enabled: false } })).not.toContain('<img');
  });

  it('keeps the matching screenshot across compact pushes and delayed initial pulls', () => {
    const initial = snapshot(5);
    const { dataUrl, ...frame } = initial.shot!;
    const pushed = { ...initial, revision: 6, inFlight: 1, shot: frame };
    const expected = { ...pushed, shot: { ...frame, dataUrl } };
    expect(newerPreviewState(initial, pushed)).toEqual(expected);
    expect(newerPreviewState(pushed, initial)).toEqual(expected);

    const cleared = { ...pushed, revision: 7, shot: null };
    expect(newerPreviewState(cleared, initial)).toBe(cleared);
    const nextFrame = { ...pushed, revision: 7, shot: { ...frame, frameId: 'frame2' } };
    expect(newerPreviewState(nextFrame, initial)).toBe(nextFrame);
    const nextSelection = { ...pushed, revision: 7, status: { ...pushed.status, targetRevision: 2 } };
    expect(newerPreviewState(nextSelection, initial)).toBe(nextSelection);
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
