import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useGithubPushStore } from './githubPush.store';
import { useMarketStore } from './market.store';
import { useWorkspaceStore } from './workspace.store';
import { runGithubPushText } from './chat.store';
import { usePluginStore } from './plugin.store';

beforeEach(() => {
  vi.restoreAllMocks();
  useGithubPushStore.getState().cancel();
  useWorkspaceStore.setState({ rootPath: '/original' });
  useMarketStore.setState({ repo: 'old/repo' });
  usePluginStore.setState({ disabled: [] });
});
describe('AI GitHub push confirmation', () => {
  it('waits for confirmation and freezes source and chosen destination', async () => {
    const push = vi.spyOn(useMarketStore.getState(), 'pushRepo').mockResolvedValue({ ok: true, message: 'pushed' });
    const result = runGithubPushText('fix');
    await vi.waitFor(() => expect(useGithubPushStore.getState().pending?.root).toBe('/original'));
    expect(push).not.toHaveBeenCalled();
    useWorkspaceStore.setState({ rootPath: '/other' });
    useGithubPushStore.getState().confirm('https://github.com/new/target.git');
    expect(await result).toBe('pushed');
    expect(push).toHaveBeenCalledWith('fix', { root: '/original', repo: 'new/target' });
  });
  it('does not push on cancellation or invalid input', async () => {
    const push = vi.spyOn(useMarketStore.getState(), 'pushRepo').mockResolvedValue({ ok: true, message: 'pushed' });
    const result = useGithubPushStore.getState().request();
    useGithubPushStore.getState().confirm('invalid');
    expect(useGithubPushStore.getState().pending).not.toBeNull();
    useGithubPushStore.getState().cancel();
    expect((await result).ok).toBe(false);
    expect(push).not.toHaveBeenCalled();
  });
});
