import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BUILTIN_PLUGINS, buildCreatePluginPrompt, findBuiltinPlugin } from '../core/plugins/plugins';
import { selectPlugins, usePluginStore } from './plugin.store';
import { useLanguageStore } from './language.store';
import { useSkillsStore } from './skills.store';

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).window = {
    electronAPI: {
      skill: {
        install: vi.fn(async () => ({ ok: true })),
        list: vi.fn(async () => ({ global: [], project: [] })),
        remove: vi.fn(async () => ({ ok: true })),
      },
      conversation: { create: vi.fn(), list: vi.fn(async () => []), update: vi.fn() },
      message: { create: vi.fn(), list: vi.fn(async () => []) },
      chat: { onChunk: vi.fn(() => () => {}), stream: vi.fn(), stop: vi.fn() },
    },
  };
  usePluginStore.setState({ custom: [], disabled: [] });
  useSkillsStore.setState({ installed: [], effective: [], loaded: true } as any);
});

describe('builtin catalog', () => {
  it('ships our six plugins with views and linked skills', () => {
    expect(BUILTIN_PLUGINS.map((p) => p.id)).toEqual([
      'github-sync', 'perf-monitor', 'security-review', 'todo-scan', 'commit-msg', 'repo-map',
    ]);
    for (const p of BUILTIN_PLUGINS) {
      expect(p.view, p.id).toBeDefined();
    }
    expect(findBuiltinPlugin('perf-monitor')?.skillId).toBe('perf-monitor');
  });

  it('scaffolds creation through the AI chat without mixing concerns', () => {
    useLanguageStore.setState({ locale: 'zh' });
    const prompt = buildCreatePluginPrompt(useLanguageStore.getState().t);
    expect(prompt).toContain('SKILL.md');
    expect(prompt).toMatch(/插件是插件/);
  });

  it('renders the prompt in the active locale', () => {
    useLanguageStore.setState({ locale: 'en' });
    const t = useLanguageStore.getState().t;
    expect(buildCreatePluginPrompt(t)).toMatch(/Plugins are plugins/);
    useLanguageStore.setState({ locale: 'zh' });
  });

  it('covers every builtin with name/description keys in all locales', () => {
    for (const loc of ['en', 'zh', 'zhHant', 'ja'] as const) {
      useLanguageStore.setState({ locale: loc });
      const t = useLanguageStore.getState().t;
      for (const p of BUILTIN_PLUGINS) {
        expect(t(`pluginName_${p.id}`), `${loc}/${p.id} name`).not.toBe(`pluginName_${p.id}`);
        expect(t(`pluginDesc_${p.id}`), `${loc}/${p.id} desc`).not.toBe(`pluginDesc_${p.id}`);
      }
      for (const id of ['perf-monitor', 'security-review', 'todo-scan', 'commit-msg', 'repo-map']) {
        expect(t(`pluginSkillName_${id}`), `${loc}/${id}`).not.toBe(`pluginSkillName_${id}`);
        expect(t(`pluginSkillDesc_${id}`), `${loc}/${id}`).not.toBe(`pluginSkillDesc_${id}`);
      }
    }
    useLanguageStore.setState({ locale: 'zh' });
  });
});

describe('plugin registry', () => {
  it('adds and removes custom plugins with unique ids', () => {
    const id1 = usePluginStore.getState().addCustom({ name: '我的插件', description: '自建测试用' });
    const id2 = usePluginStore.getState().addCustom({ name: '我的插件', description: '重名自增' });
    expect(id1).toBeTruthy();
    expect(id2).not.toBe(id1);
    expect(usePluginStore.getState().addCustom({ name: '', description: 'x' })).toBeNull();
    usePluginStore.getState().removeCustom(id1!);
    expect(usePluginStore.getState().custom.some((c) => c.id === id1)).toBe(false);
  });

  it('merges builtin and custom without fighting skills', () => {
    useSkillsStore.setState({
      installed: [{ id: 'alpha', name: 'Alpha', scope: 'global', source: 'custom', description: 'd', tags: [], body: 'b' }],
      effective: [],
      loaded: true,
    } as any);
    usePluginStore.getState().addCustom({ name: '自建', description: 'd', skillId: 'alpha' });
    const all = selectPlugins();
    expect(all.filter((p) => p.kind === 'builtin')).toHaveLength(6);
    expect(all.some((p) => p.kind === 'custom' && p.view === 'skill')).toBe(true);
    expect(all.find((p) => p.id === 'github-sync')?.skillInstalled).toBe(true);
    expect(all.find((p) => p.id === 'todo-scan')?.skillInstalled).toBe(false);
    expect(all.find((p) => p.kind === 'custom')?.skillInstalled).toBe(true);
    // Disabling a plugin never touches the skill side.
    usePluginStore.getState().setEnabled('todo-scan', false);
    expect(selectPlugins().find((p) => p.id === 'todo-scan')?.enabled).toBe(false);
    expect(useSkillsStore.getState().installed).toHaveLength(1);
  });
});
