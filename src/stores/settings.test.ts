import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore, effectiveApprovalMode } from './settings.store';

describe('settings persistence', () => {
  beforeEach(() => {
    useSettingsStore.setState({ language: 'en', sendWithEnter: true });
  });

  it('serializes rapid saves so the newest snapshot is written last', async () => {
    const releases: Array<() => void> = [];
    const writes: any[] = [];
    (globalThis as any).window = {
      electronAPI: {
        settings: {
          update: vi.fn((snapshot: any) => {
            writes.push(snapshot);
            return new Promise<void>((resolve) => releases.push(resolve));
          }),
        },
      },
    };

    useSettingsStore.getState().updateSettings({ language: 'zh' });
    useSettingsStore.getState().updateSettings({ language: 'ja' });
    await vi.waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0].language).toBe('zh');

    releases.shift()!();
    await vi.waitFor(() => expect(writes).toHaveLength(2));
    expect(writes[1].language).toBe('ja');
    releases.shift()!();
  });
});

describe('approval override', () => {
  beforeEach(() => {
    useSettingsStore.setState({ approvalMode: 'suggest', approvalOverride: null });
  });

  it('drives execution while leaving the stored mode untouched', () => {
    expect(effectiveApprovalMode()).toBe('suggest');
    useSettingsStore.setState({ approvalOverride: 'fullAuto' });
    expect(effectiveApprovalMode()).toBe('fullAuto');
    expect(useSettingsStore.getState().approvalMode).toBe('suggest');
    useSettingsStore.setState({ approvalOverride: null });
    expect(effectiveApprovalMode()).toBe('suggest');
  });

  it('never persists the override to disk', async () => {
    const writes: any[] = [];
    (globalThis as any).window = {
      electronAPI: {
        settings: { update: vi.fn(async (snapshot: any) => { writes.push(snapshot); }) },
      },
    };
    useSettingsStore.setState({ approvalOverride: 'fullAuto' });
    await useSettingsStore.getState().saveSettings();
    expect(writes).toHaveLength(1);
    expect(writes[0].approvalOverride).toBeUndefined();
    expect(writes[0].approvalMode).toBe('suggest');
    useSettingsStore.setState({ approvalOverride: null });
  });
});
