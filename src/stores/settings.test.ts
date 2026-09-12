import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useSettingsStore } from './settings.store';

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
