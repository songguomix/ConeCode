import { describe, expect, it } from 'vitest';
import { installBrowserBridge } from './bridge';

describe('browser preview bridge', () => {
  it('provides boot data and cleanup without a preload', async () => {
    const target: any = {};
    installBrowserBridge(target);
    expect(await target.electronAPI.provider.list()).toEqual([]);
    expect(await target.electronAPI.conversation.list()).toEqual([]);
    expect(await target.electronAPI.skill.list()).toEqual({ global: [], project: [] });
    expect(typeof target.electronAPI.chat.onChunk(() => {})).toBe('function');
    await expect(target.electronAPI.power.setPreventSleep(true)).resolves.toBe(false);
    await expect(target.electronAPI.exec.run('echo test')).rejects.toThrow('desktop');
  });

  it('never replaces the real Electron bridge', () => {
    const real = { power: { setPreventSleep: () => true } };
    const target: any = { electronAPI: real };
    installBrowserBridge(target);
    expect(target.electronAPI).toBe(real);
  });
});
