import { create } from 'zustand';
import { BUILTIN_PLUGINS, type PluginDef, type PluginKind } from '../core/plugins/plugins';
import { useMarketStore } from './market.store';
import { useSkillsStore } from './skills.store';

const CUSTOM_KEY = 'conecode.customPlugins';
const DISABLED_KEY = 'conecode.disabledPlugins';

export interface CustomPlugin {
  id: string;
  name: string;
  description: string;
  /** Optional linked skill that does the legwork (generic run view). */
  skillId?: string;
}

export interface PluginEntry extends PluginDef {
  /** False when the user disabled it in the library (views hide it). */
  enabled: boolean;
  /** Scope of the linked skill, when there is one. */
  skillScope?: string;
}

function loadJSON<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

interface PluginStore {
  custom: CustomPlugin[];
  disabled: string[];
  addCustom: (draft: { name: string; description: string; skillId?: string }) => string | null;
  removeCustom: (id: string) => void;
  setEnabled: (id: string, on: boolean) => void;
}

function customId(name: string, taken: Set<string>): string {
  const base =
    name.trim().toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32) ||
    'plugin';
  let id = base;
  for (let i = 2; taken.has(id); i++) id = `${base}-${i}`;
  return id;
}

export const usePluginStore = create<PluginStore>((set, get) => ({
  custom: loadJSON<CustomPlugin[]>(CUSTOM_KEY, []),
  disabled: loadJSON<string[]>(DISABLED_KEY, []),

  addCustom: (draft) => {
    const name = draft.name.trim();
    const description = draft.description.trim();
    if (!name || !description) return null;
    const taken = new Set([
      ...BUILTIN_PLUGINS.map((p) => p.id),
      ...get().custom.map((p) => p.id),
      ...Object.keys(useMarketStore.getState().origins),
    ]);
    const id = customId(name, taken);
    const custom = [...get().custom, { id, name, description, skillId: draft.skillId || undefined }];
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    } catch {}
    set({ custom });
    return id;
  },

  removeCustom: (id) => {
    const custom = get().custom.filter((p) => p.id !== id);
    try {
      localStorage.setItem(CUSTOM_KEY, JSON.stringify(custom));
    } catch {}
    set({ custom });
  },

  setEnabled: (id, on) => {
    const disabled = on
      ? get().disabled.filter((x) => x !== id)
      : [...get().disabled.filter((x) => x !== id), id];
    try {
      localStorage.setItem(DISABLED_KEY, JSON.stringify(disabled));
    } catch {}
    set({ disabled });
  },
}));

/**
 * Everything the library shows, merged from three sources that never fight:
 * builtin code, market installs (derived from sync origins whose skill is
 * still installed), and user-added customs. Enabling/disabling a plugin only
 * affects the plugin side — the linked skill's own switch stays independent.
 */
export function selectPlugins(): PluginEntry[] {
  const { custom, disabled } = usePluginStore.getState();
  const origins = useMarketStore.getState().origins;
  const installed = useSkillsStore.getState().installed;
  const out: PluginEntry[] = BUILTIN_PLUGINS.map((p) => ({
    ...p,
    enabled: !disabled.includes(p.id),
  }));
  for (const [skillId, origin] of Object.entries(origins)) {
    const skill = installed.find((s) => s.id === skillId);
    if (!skill) continue;
    out.push({
      id: `market:${skillId}`,
      name: skill.name || skillId,
      description: skill.description || origin.path,
      kind: 'market' as PluginKind,
      icon: 'box',
      skillId,
      view: 'skill',
      enabled: !disabled.includes(`market:${skillId}`),
      skillScope: skill.scope,
    });
  }
  for (const c of custom) {
    const skill = c.skillId ? installed.find((s) => s.id === c.skillId) : undefined;
    out.push({
      id: c.id,
      name: c.name,
      description: c.description,
      kind: 'custom' as PluginKind,
      icon: 'box',
      skillId: skill ? c.skillId : undefined,
      view: skill ? 'skill' : undefined,
      enabled: !disabled.includes(c.id),
      skillScope: skill?.scope,
    });
  }
  return out;
}
