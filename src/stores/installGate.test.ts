import { describe, expect, it } from 'vitest';
import { activeInstallLabel, isHolding, useInstallGateStore } from './installGate.store';

function reset() {
  useInstallGateStore.getState().reset();
}

describe('installGate', () => {
  it('tracks jobs and holding flag', () => {
    reset();
    const g = useInstallGateStore.getState();
    expect(isHolding(g.jobs)).toBe(false);
    g.begin('a', 'cloudflared', 'tool');
    expect(isHolding(useInstallGateStore.getState().jobs)).toBe(true);
    expect(activeInstallLabel(useInstallGateStore.getState().jobs)).toBe('cloudflared');
    useInstallGateStore.getState().end('a');
    expect(isHolding(useInstallGateStore.getState().jobs)).toBe(false);
  });

  it('end is idempotent', () => {
    reset();
    useInstallGateStore.getState().begin('x', 'x');
    useInstallGateStore.getState().end('x');
    useInstallGateStore.getState().end('x');
    expect(Object.keys(useInstallGateStore.getState().jobs)).toHaveLength(0);
  });

  it('holds resume until every install finishes', () => {
    reset();
    const g = useInstallGateStore.getState();
    g.begin('1', 'dep one');
    g.begin('2', 'dep two');
    g.markResume('conv-1');
    expect(useInstallGateStore.getState().release()).toBeNull();
    useInstallGateStore.getState().end('1');
    expect(useInstallGateStore.getState().release()).toBeNull();
    useInstallGateStore.getState().end('2');
    expect(useInstallGateStore.getState().release()).toBe('conv-1');
    // One-shot: second release does not auto-continue again.
    expect(useInstallGateStore.getState().release()).toBeNull();
  });

  it('does not resume when nothing was held', () => {
    reset();
    useInstallGateStore.getState().begin('a', 'x');
    useInstallGateStore.getState().end('a');
    expect(useInstallGateStore.getState().release()).toBeNull();
  });

  it('keeps held conversation id for the auto-continue target', () => {
    reset();
    useInstallGateStore.getState().begin('a', 'x');
    useInstallGateStore.getState().markResume('c42');
    expect(useInstallGateStore.getState().heldConversationId).toBe('c42');
    useInstallGateStore.getState().end('a');
    expect(useInstallGateStore.getState().release()).toBe('c42');
    expect(useInstallGateStore.getState().heldConversationId).toBeNull();
  });
});
