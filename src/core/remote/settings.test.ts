import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useProviderStore } from '../../stores/provider.store';
import { usePromptStore } from '../../stores/prompt.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import type { ProviderConfig } from '../../types/provider.types';
import { handleRemoteSettings } from './settings';

vi.mock('../../stores/theme.store', () => ({
  useThemeStore: { getState: () => ({ theme: 'system', setTheme: vi.fn() }) },
}));

const provider: ProviderConfig = {
  id: 'provider-a',
  name: 'Private provider',
  type: 'custom',
  baseUrl: 'https://api.example.test/path/key-in-path?token=secret-in-url',
  apiKey: 'private-provider-key',
  defaultModel: 'model',
  timeout: 60_000,
  enabled: true,
  createdAt: 0,
  updatedAt: 0,
};

beforeEach(() => {
  vi.stubGlobal('window', { electronAPI: {} });
  useProviderStore.setState({ providers: [provider] });
  useWorkspaceStore.setState({ rootPath: '/open/project' });
  usePromptStore.setState({ customUserPrompts: [] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  localStorage.clear();
});

describe('remote desktop settings', () => {
  it('lists provider metadata without the key or secret-bearing endpoint', async () => {
    const result = await handleRemoteSettings({ action: 'list', section: 'providers' });
    expect(result.page?.items).toEqual([expect.objectContaining({
      id: provider.id,
      description: 'api.example.test',
    })]);
    const wire = JSON.stringify(result);
    expect(wire).not.toContain(provider.apiKey);
    expect(wire).not.toContain('key-in-path');
    expect(wire).not.toContain('secret-in-url');
  });

  it('does not forward an existing key to a replacement endpoint', async () => {
    const save = vi.spyOn(useProviderStore.getState(), 'updateProvider').mockResolvedValue(undefined);
    const result = await handleRemoteSettings({
      action: 'save', section: 'providers', id: provider.id,
      values: { ...provider, baseUrl: 'https://different.example.test', apiKey: '' },
    });
    expect(result).toEqual({ ok: false, error: 'Enter an API key for the new endpoint or provider type.' });
    expect(save).not.toHaveBeenCalled();
  });

  it('updates a provider name without touching the saved credential', async () => {
    const save = vi.spyOn(useProviderStore.getState(), 'updateProvider').mockResolvedValue(undefined);
    const result = await handleRemoteSettings({
      action: 'save', section: 'providers', id: provider.id,
      values: { ...provider, name: 'New name', baseUrl: '', apiKey: '' },
    });
    expect(result.ok).toBe(true);
    expect(save).toHaveBeenCalledWith(provider.id, {
      name: 'New name', type: provider.type, baseUrl: provider.baseUrl,
      timeout: provider.timeout, defaultModel: provider.defaultModel,
    });
  });

  it('cannot operate on workspace-scoped data from a previously selected folder', async () => {
    const result = await handleRemoteSettings({ action: 'list', section: 'memory', root: '/old/project' });
    expect(result).toEqual({ ok: false, error: 'The desktop workspace changed. Refresh and try again.' });
  });

  it('creates, reads and updates a custom prompt through its existing store', async () => {
    const draft = { title: 'Review notes', category: 'review', description: 'For my own use', content: 'Summarize changes.' };
    expect(await handleRemoteSettings({ action: 'save', section: 'prompts', values: draft })).toEqual({ ok: true });
    const id = usePromptStore.getState().customUserPrompts[0].id;
    const detail = await handleRemoteSettings({ action: 'detail', section: 'prompts', id });
    expect(detail.item).toEqual(expect.objectContaining({ title: draft.title, content: draft.content, enabled: true }));
    expect(await handleRemoteSettings({ action: 'toggle', section: 'prompts', id })).toEqual({ ok: true });
    expect(usePromptStore.getState().customUserPrompts[0].enabled).toBe(false);
  });

  it('rejects unlisted settings instead of forwarding arbitrary store keys', async () => {
    expect(await handleRemoteSettings({
      action: 'save', section: 'general', id: 'approvalOverride', values: { value: 'fullAuto' },
    })).toEqual({ ok: false, error: 'Unknown setting.' });
  });
});
