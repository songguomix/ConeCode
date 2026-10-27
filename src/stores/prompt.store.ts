import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  type BuiltinPromptKey,
  BUILTIN_PROMPTS_META,
  BUILTIN_PROMPTS_MAP,
} from '../core/prompt/defaultPrompts';

export interface CustomUserPrompt {
  id: string;
  title: string;
  description: string;
  category: string;
  content: string;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

const STORAGE_OVERRIDES_KEY = 'conecode.promptOverrides';
const STORAGE_CUSTOM_KEY = 'conecode.customUserPrompts';

function getStorage(): Storage | null {
  if (typeof localStorage !== 'undefined') return localStorage;
  if (typeof window !== 'undefined' && window.localStorage) return window.localStorage;
  return null;
}

function loadOverrides(): Record<string, string> {
  const storage = getStorage();
  if (!storage) return {};
  try {
    const raw = storage.getItem(STORAGE_OVERRIDES_KEY);
    return raw ? JSON.parse(raw) : {};
  } catch {
    return {};
  }
}

function saveOverrides(overrides: Record<string, string>) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_OVERRIDES_KEY, JSON.stringify(overrides));
  } catch {}
}

function loadCustomPrompts(): CustomUserPrompt[] {
  const storage = getStorage();
  if (!storage) return [];
  try {
    const raw = storage.getItem(STORAGE_CUSTOM_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveCustomPrompts(prompts: CustomUserPrompt[]) {
  const storage = getStorage();
  if (!storage) return;
  try {
    storage.setItem(STORAGE_CUSTOM_KEY, JSON.stringify(prompts));
  } catch {}
}

export interface PromptStoreState {
  overrides: Record<string, string>;
  customUserPrompts: CustomUserPrompt[];

  /** Get the effective text for a built-in prompt, applying any placeholder replacements. */
  getPrompt: (key: BuiltinPromptKey, replacements?: Record<string, string>) => string;

  /** Set custom text for a built-in prompt. */
  setPrompt: (key: BuiltinPromptKey, content: string) => void;

  /** Reset one built-in prompt back to its default. */
  resetPrompt: (key: BuiltinPromptKey) => void;

  /** Reset all built-in prompts back to their factory defaults. */
  resetAllPrompts: () => void;

  /** Check whether a prompt has been modified from default. */
  isModified: (key: BuiltinPromptKey) => boolean;

  /** Whether any built-in prompt has been modified. */
  hasAnyModified: () => boolean;

  /** Create a brand-new custom prompt. */
  addCustomPrompt: (prompt: Omit<CustomUserPrompt, 'id' | 'createdAt' | 'updatedAt'>) => CustomUserPrompt;

  /** Update an existing custom prompt. */
  updateCustomPrompt: (id: string, patch: Partial<CustomUserPrompt>) => void;

  /** Delete a custom prompt. */
  deleteCustomPrompt: (id: string) => void;

  /** Toggle whether a custom prompt is enabled. */
  toggleCustomPrompt: (id: string) => void;

  /** Get all currently enabled custom prompts. */
  getEnabledCustomPrompts: () => CustomUserPrompt[];
}

export const usePromptStore = create<PromptStoreState>((set, get) => ({
  overrides: loadOverrides(),
  customUserPrompts: loadCustomPrompts(),

  getPrompt: (key, replacements) => {
    const { overrides } = get();
    const meta = BUILTIN_PROMPTS_MAP[key];
    let content = overrides[key] !== undefined ? overrides[key] : (meta?.defaultContent ?? '');
    if (replacements) {
      for (const [placeholder, val] of Object.entries(replacements)) {
        content = content.split(`{${placeholder}}`).join(val);
      }
    }
    return content;
  },

  setPrompt: (key, content) => {
    const meta = BUILTIN_PROMPTS_MAP[key];
    const newOverrides = { ...get().overrides };
    if (meta && content.trim() === meta.defaultContent.trim()) {
      delete newOverrides[key];
    } else {
      newOverrides[key] = content;
    }
    saveOverrides(newOverrides);
    set({ overrides: newOverrides });
  },

  resetPrompt: (key) => {
    const newOverrides = { ...get().overrides };
    delete newOverrides[key];
    saveOverrides(newOverrides);
    set({ overrides: newOverrides });
  },

  resetAllPrompts: () => {
    saveOverrides({});
    set({ overrides: {} });
  },

  isModified: (key) => {
    const { overrides } = get();
    const meta = BUILTIN_PROMPTS_MAP[key];
    if (overrides[key] === undefined) return false;
    return overrides[key].trim() !== (meta?.defaultContent ?? '').trim();
  },

  hasAnyModified: () => {
    const { overrides } = get();
    return Object.keys(overrides).some((k) => {
      const meta = BUILTIN_PROMPTS_MAP[k as BuiltinPromptKey];
      return meta && overrides[k].trim() !== meta.defaultContent.trim();
    });
  },

  addCustomPrompt: (data) => {
    const id = uuidv4();
    const now = Date.now();
    const newPrompt: CustomUserPrompt = {
      id,
      title: data.title.trim() || '未命名提示词',
      description: data.description.trim(),
      category: data.category.trim() || '自定义',
      content: data.content,
      enabled: data.enabled ?? true,
      createdAt: now,
      updatedAt: now,
    };
    const updated = [newPrompt, ...get().customUserPrompts];
    saveCustomPrompts(updated);
    set({ customUserPrompts: updated });
    return newPrompt;
  },

  updateCustomPrompt: (id, patch) => {
    const updated = get().customUserPrompts.map((p) => {
      if (p.id !== id) return p;
      return {
        ...p,
        ...patch,
        updatedAt: Date.now(),
      };
    });
    saveCustomPrompts(updated);
    set({ customUserPrompts: updated });
  },

  deleteCustomPrompt: (id) => {
    const updated = get().customUserPrompts.filter((p) => p.id !== id);
    saveCustomPrompts(updated);
    set({ customUserPrompts: updated });
  },

  toggleCustomPrompt: (id) => {
    const updated = get().customUserPrompts.map((p) =>
      p.id === id ? { ...p, enabled: !p.enabled, updatedAt: Date.now() } : p,
    );
    saveCustomPrompts(updated);
    set({ customUserPrompts: updated });
  },

  getEnabledCustomPrompts: () => {
    return get().customUserPrompts.filter((p) => p.enabled);
  },
}));
