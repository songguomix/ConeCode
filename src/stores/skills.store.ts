import { create } from 'zustand';
import { useInstallGateStore } from './installGate.store';
import { useChatStore } from './chat.store';
import { BUILTIN_SKILLS, type CatalogSkill } from '../core/skills/builtin';
import {
  formatSkillsPrompt,
  mergeSkills,
  parseSkill,
  serializeSkill,
  skillId,
  validateDraft,
  draftHasErrors,
  type Skill,
  type SkillDraft,
  type SkillMeta,
} from '../core/skills/skills';
import { useWorkspaceStore } from './workspace.store';

// The plugin library. Installed skills live on disk as SKILL.md files, so they
// can be edited, version-controlled with the project, or written by hand — the
// app is a browser and installer for them, not their owner.

let loadRequest = 0;

function effectiveSkills(global: Skill[], project: Skill[]): Skill[] {
  const byScopeAndId = new Map<string, Skill>();
  for (const skill of [...global, ...project]) {
    byScopeAndId.set(`${skill.scope}:${skill.id}`, skill);
  }
  return mergeSkills(global, project)
    .map((skill) => byScopeAndId.get(`${skill.scope}:${skill.id}`))
    .filter((skill): skill is Skill => !!skill && skill.enabled !== false);
}

function allSkills(global: Skill[], project: Skill[]): Skill[] {
  return [...global, ...project].sort((a, b) =>
    a.name.localeCompare(b.name) || (a.scope === b.scope ? 0 : a.scope === 'project' ? -1 : 1),
  );
}

interface SkillsStore {
  installed: Skill[];
  /** Enabled skills after project-over-global shadowing; this is what the agent sees. */
  effective: Skill[];
  loaded: boolean;
  loadedRootPath: string | null;
  busy: string | null;
  error: string | null;

  load: () => Promise<void>;
  /** Deploy a catalog skill to this project or to every project. */
  install: (skill: CatalogSkill, scope: 'global' | 'project') => Promise<boolean>;
  /**
   * Write a skill the USER wrote or imported. Stamped as custom so it is always
   * labelled as unreviewed — ConeCode does not vet these.
   */
  saveCustom: (draft: SkillDraft, scope: 'global' | 'project', replaceId?: string) => Promise<boolean>;
  setEnabled: (skill: Skill, enabled: boolean) => Promise<boolean>;
  remove: (skill: SkillMeta) => Promise<void>;
  /** The system-prompt block: ids and descriptions only. */
  promptBlock: () => string;
  /** Full instructions for one skill — what `use_skill` returns. */
  body: (id: string) => string | null;
  isInstalled: (id: string) => boolean;
  catalog: () => CatalogSkill[];
}

export const useSkillsStore = create<SkillsStore>((set, get) => ({
  installed: [],
  effective: [],
  loaded: false,
  loadedRootPath: null,
  busy: null,
  error: null,

  load: async () => {
    const request = ++loadRequest;
    const rootPath = useWorkspaceStore.getState().rootPath || null;
    set((state) => {
      if (state.loadedRootPath === rootPath) return { error: null };
      // Never advertise a project skill from the previously-open workspace
      // while the new workspace is still loading.
      const global = state.installed.filter((skill) => skill.scope === 'global');
      return {
        installed: global,
        effective: effectiveSkills(global, []),
        loaded: false,
        error: null,
      };
    });
    try {
      const res = await window.electronAPI.skill.list(rootPath || undefined);
      if (request !== loadRequest) return;
      const global = (res.global || []) as Skill[];
      const project = (res.project || []) as Skill[];
      set({
        installed: allSkills(global, project),
        effective: effectiveSkills(global, project),
        loaded: true,
        loadedRootPath: rootPath,
        error: null,
      });
    } catch (e: any) {
      if (request === loadRequest) {
        set({ loaded: true, loadedRootPath: rootPath, error: e?.message || String(e) });
      }
    }
  },

  install: async (skill, scope) => {
    set({ busy: skill.id, error: null });
    const holdId = `skill-install:${skill.id}:${Date.now()}`;
    useInstallGateStore.getState().begin(holdId, skill.name || skill.id, 'skill');
    const finishInstall = () => {
      useInstallGateStore.getState().end(holdId);
      void useChatStore.getState().continueAfterInstall?.();
    };
    try {
      const rootPath = useWorkspaceStore.getState().rootPath || undefined;
      if (scope === 'project' && !rootPath) {
        set({ busy: null, error: 'no-project' });
        return false;
      }
      const content = serializeSkill({
        name: skill.name,
        description: skill.description,
        tags: skill.tags,
        body: skill.body,
        source: 'builtin',
      });
      const res = await window.electronAPI.skill.install({ id: skill.id, content, scope, rootPath });
      if (!res.ok) {
        set({ busy: null, error: res.error || 'install-failed' });
        return false;
      }
      await get().load();
      set({ busy: null });
      return true;
    } catch (e: any) {
      set({ busy: null, error: e?.message || String(e) });
      return false;
    } finally {
      finishInstall();
    }
  },

  saveCustom: async (draft, scope, replaceId) => {
    const errors = validateDraft(draft);
    if (draftHasErrors(errors)) {
      set({ error: 'invalid-draft' });
      return false;
    }
    const id = replaceId || skillId(draft.name);
    set({ busy: id, error: null });
    const holdId = `skill-save:${id}:${Date.now()}`;
    useInstallGateStore.getState().begin(holdId, draft.name || id, 'skill');
    try {
      const rootPath = useWorkspaceStore.getState().rootPath || undefined;
      if (scope === 'project' && !rootPath) {
        set({ busy: null, error: 'no-project' });
        return false;
      }
      // Editing overwrites in place; creating must not silently clobber an
      // existing skill of the same name in the same scope.
      if (!replaceId && get().installed.some((s) => s.id === id && s.scope === scope)) {
        set({ busy: null, error: 'already-exists' });
        return false;
      }
      const existing = replaceId
        ? get().installed.find((skill) => skill.id === replaceId && skill.scope === scope)
        : undefined;
      const content = serializeSkill({
        name: draft.name.trim(),
        description: draft.description.trim(),
        tags: draft.tags,
        body: draft.body,
        source: 'custom',
        enabled: existing?.enabled,
      });
      const res = await window.electronAPI.skill.install({ id, content, scope, rootPath });
      if (!res.ok) {
        set({ busy: null, error: res.error || 'install-failed' });
        return false;
      }
      await get().load();
      set({ busy: null });
      return true;
    } catch (e: any) {
      set({ busy: null, error: e?.message || String(e) });
      return false;
    } finally {
      useInstallGateStore.getState().end(holdId);
      void useChatStore.getState().continueAfterInstall?.();
    }
  },

  setEnabled: async (skill, enabled) => {
    set({ busy: skill.id, error: null });
    try {
      const rootPath = useWorkspaceStore.getState().rootPath || undefined;
      if (skill.scope === 'project' && !rootPath) {
        set({ busy: null, error: 'no-project' });
        return false;
      }
      const content = serializeSkill({ ...skill, enabled });
      const res = await window.electronAPI.skill.install({
        id: skill.id, content, scope: skill.scope, rootPath,
      });
      if (!res.ok) {
        set({ busy: null, error: res.error || 'update-failed' });
        return false;
      }
      await get().load();
      set({ busy: null });
      return true;
    } catch (e: any) {
      set({ busy: null, error: e?.message || String(e) });
      return false;
    }
  },

  remove: async (skill) => {
    set({ busy: skill.id, error: null });
    try {
      const rootPath = useWorkspaceStore.getState().rootPath || undefined;
      const res = await window.electronAPI.skill.remove({ id: skill.id, scope: skill.scope, rootPath });
      if (!res.ok) {
        set({ error: res.error || 'remove-failed' });
        return;
      }
      await get().load();
    } catch (e: any) {
      set({ error: e?.message || String(e) });
    } finally {
      set({ busy: null });
    }
  },

  promptBlock: () => formatSkillsPrompt(get().effective),

  body: (id) => {
    const skill = get().effective.find((s) => s.id === id);
    if (!skill) return null;
    // Project skills shadow global ones in the effective list.
    return skill.body || null;
  },

  isInstalled: (id) => get().installed.some((s) => s.id === id),

  catalog: () => BUILTIN_SKILLS,
}));

/** Re-parse a SKILL.md the user edited by hand, without a full reload. */
export function parseSkillFile(raw: string, id: string, scope: 'global' | 'project'): Skill | null {
  return parseSkill(raw, { id, scope });
}
