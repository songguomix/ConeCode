import { create } from 'zustand';
import { isSafeSkillId, parseSkill, serializeSkill, skillId } from '../core/skills/skills';
import { useSkillsStore } from './skills.store';

const REPO_KEY = 'conecode.pluginRepo';
const TOKEN_KEY = 'conecode.pluginToken';
const ORIGINS_KEY = 'conecode.pluginOrigins';

export type MarketError =
  | 'repo-not-found'
  | 'auth-failed'
  | 'rate-limited'
  | 'network-error'
  | 'empty-repo'
  | 'conflict';

/** A SKILL.md found in the synced repo. `installed` is resolved at render. */
export interface RemoteSkill {
  id: string;
  name: string;
  description: string;
  path: string;
  body: string;
}

/** Where an installed skill came from, plus what it looked like then. */
export interface SkillOrigin {
  repo: string;
  path: string;
  /** Full serialized SKILL.md at install/push time — the diff baseline. */
  content: string;
}

interface MarketStore {
  /** "owner/repo". */
  repo: string;
  tokenSet: boolean;
  remote: RemoteSkill[];
  fetchedAt: number | null;
  syncing: boolean;
  error: MarketError | null;
  /** skillId → where it was installed from (survives reloads). */
  origins: Record<string, SkillOrigin>;
  pushing: string | null;
  setRepo: (repo: string) => void;
  /** Persist a token (or null to forget it). The value never enters state. */
  setToken: (token: string | null) => void;
  sync: () => Promise<boolean>;
  /** Install/update into the library (stamped custom = unreviewed). */
  installRemote: (skill: RemoteSkill, scope: 'global' | 'project') => Promise<boolean>;
  /** True when the local copy differs from the last synced content. */
  hasLocalChanges: (skillId: string) => boolean;
  /** Push the local SKILL.md back to its repo (one click, fixed message). */
  pushSkill: (skillId: string) => Promise<boolean>;
}

function loadOrigins(): Record<string, SkillOrigin> {
  try {
    return JSON.parse(localStorage.getItem(ORIGINS_KEY) || '{}');
  } catch {
    return {};
  }
}

function saveOrigins(origins: Record<string, SkillOrigin>) {
  try {
    localStorage.setItem(ORIGINS_KEY, JSON.stringify(origins));
  } catch {}
}

function loadRepo(): string {
  try {
    return localStorage.getItem(REPO_KEY) || '';
  } catch {
    return '';
  }
}

function loadToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY) || null;
  } catch {
    return null;
  }
}

function headers(): Record<string, string> {
  const h: Record<string, string> = { Accept: 'application/vnd.github+json' };
  const token = loadToken();
  if (token) h.Authorization = `Bearer ${token}`;
  return h;
}

/** Accept "owner/repo" or a github.com URL, reject everything else. */
export function normalizeRepo(input: string): string | null {
  const t = input.trim().replace(/\/+$/, '');
  const m = t.match(/^(?:https?:\/\/github\.com\/)?([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/);
  return m ? m[1] : null;
}

async function api(path: string): Promise<{ ok: boolean; status: number; text: string }> {
  const res = await fetch(`https://api.github.com${path}`, { headers: headers() });
  return { ok: res.ok, status: res.status, text: await res.text() };
}

function toError(status: number): MarketError {
  if (status === 404) return 'repo-not-found';
  if (status === 401) return 'auth-failed';
  if (status === 403 || status === 429) return 'rate-limited';
  return 'network-error';
}

/** UTF-8-safe base64 for the Contents API (btoa is Latin-1 only). */
function b64(text: string): string {
  const Buf = (globalThis as any).Buffer;
  if (Buf) return Buf.from(text, 'utf-8').toString('base64');
  return btoa(unescape(encodeURIComponent(text)));
}

export const useMarketStore = create<MarketStore>((set, get) => ({
  repo: loadRepo(),
  tokenSet: !!loadToken(),
  remote: [],
  fetchedAt: null,
  syncing: false,
  error: null,
  origins: loadOrigins(),
  pushing: null,

  setRepo: (repo) => {
    try {
      localStorage.setItem(REPO_KEY, repo);
    } catch {}
    set({ repo });
  },

  setToken: (token) => {
    try {
      if (token) localStorage.setItem(TOKEN_KEY, token);
      else localStorage.removeItem(TOKEN_KEY);
    } catch {}
    set({ tokenSet: !!token });
  },

  sync: async () => {
    const repo = normalizeRepo(get().repo);
    if (!repo) {
      set({ error: 'repo-not-found', remote: [] });
      return false;
    }
    set({ syncing: true, error: null });
    try {
      const tree = await api(`/repos/${repo}/git/trees/HEAD?recursive=1`);
      if (!tree.ok) {
        set({ syncing: false, error: toError(tree.status), remote: [] });
        return false;
      }
      const files = (JSON.parse(tree.text).tree || [])
        .filter((n: any) => n.type === 'blob' && /(^|\/)SKILL\.md$/i.test(n.path || ''))
        .slice(0, 60);
      if (files.length === 0) {
        set({ syncing: false, error: 'empty-repo', remote: [], fetchedAt: Date.now() });
        return false;
      }
      const out: RemoteSkill[] = [];
      for (const f of files.slice(0, 25)) {
        try {
          // Raw file bytes (not the JSON envelope) when the accept header asks.
          const h: Record<string, string> = { Accept: 'application/vnd.github.raw' };
          const token = loadToken();
          if (token) h.Authorization = `Bearer ${token}`;
          const res = await fetch(
            `https://api.github.com/repos/${repo}/contents/${encodeURIComponent(f.path)}?ref=HEAD`,
            { headers: h },
          );
          if (!res.ok) continue;
          const text = await res.text();
          const dir = f.path.split('/').slice(0, -1).join('/') || f.path;
          const fallbackId = dir.split('/').pop() || 'remote-skill';
          const parsed = parseSkill(text, {
            id: isSafeSkillId(fallbackId) ? fallbackId : skillId(fallbackId),
            scope: 'global',
          });
          if (!parsed || !parsed.body) continue;
          out.push({
            id: parsed.id,
            name: parsed.name || parsed.id,
            description: parsed.description || '',
            path: f.path,
            body: parsed.body,
          });
        } catch {
          continue;
        }
      }
      set({ syncing: false, remote: out, fetchedAt: Date.now(), error: out.length === 0 ? 'empty-repo' : null });
      return out.length > 0;
    } catch {
      set({ syncing: false, error: 'network-error' });
      return false;
    }
  },

  installRemote: async (skill, scope) => {
    const installed = useSkillsStore.getState().installed;
    const existing = installed.find((s) => s.id === skill.id && s.scope === scope);
    const ok = await useSkillsStore.getState().saveCustom(
      { name: skill.name, description: skill.description, tags: ['market'], body: skill.body },
      scope,
      existing ? skill.id : undefined,
    );
    if (ok) {
      // Baseline for one-click push-back: the exact bytes we wrote.
      const after = useSkillsStore.getState().installed.find((s) => s.id === skill.id && s.scope === scope);
      const repo = normalizeRepo(get().repo);
      if (after && repo) {
        const origins = {
          ...get().origins,
          [skill.id]: { repo, path: skill.path, content: serializeSkill(after) },
        };
        saveOrigins(origins);
        set({ origins });
      }
    }
    return ok;
  },

  hasLocalChanges: (skillId) => {
    const origin = get().origins[skillId];
    if (!origin) return false;
    const skills = useSkillsStore.getState().installed;
    const local = skills.find((s) => s.id === skillId && s.scope === 'global')
      || skills.find((s) => s.id === skillId);
    if (!local) return false;
    return serializeSkill(local) !== origin.content;
  },

  pushSkill: async (skillId) => {
    const origin = get().origins[skillId];
    const token = loadToken();
    if (!origin || !token) {
      set({ error: 'auth-failed' });
      return false;
    }
    const skills = useSkillsStore.getState().installed;
    const local = skills.find((s) => s.id === skillId && s.scope === 'global')
      || skills.find((s) => s.id === skillId);
    if (!local) return false;
    const content = serializeSkill(local);
    set({ pushing: skillId, error: null });
    try {
      const h: Record<string, string> = {
        Accept: 'application/vnd.github+json',
        Authorization: `Bearer ${token}`,
      };
      const encPath = origin.path.split('/').map(encodeURIComponent).join('/');
      // Current sha first: missing file = create, mismatched base = conflict
      // is reported by the PUT itself.
      const cur = await fetch(
        `https://api.github.com/repos/${origin.repo}/contents/${encPath}?ref=HEAD`,
        { headers: h },
      );
      let sha: string | undefined;
      if (cur.ok) {
        try {
          sha = (await cur.json()).sha;
        } catch {}
      } else if (cur.status !== 404) {
        set({ pushing: null, error: toError(cur.status) });
        return false;
      }
      const put = await fetch(
        `https://api.github.com/repos/${origin.repo}/contents/${encPath}`,
        {
          method: 'PUT',
          headers: { ...h, 'Content-Type': 'application/json' },
          body: JSON.stringify({
            message: `Update ${skillId} via ConeCode`,
            content: b64(content),
            ...(sha ? { sha } : {}),
          }),
        },
      );
      if (!put.ok) {
        const err: MarketError =
          put.status === 409 || put.status === 422 ? 'conflict'
          : put.status === 401 || put.status === 403 ? 'auth-failed'
          : toError(put.status);
        set({ pushing: null, error: err });
        return false;
      }
      const origins = { ...get().origins, [skillId]: { ...origin, content } };
      saveOrigins(origins);
      set({ pushing: null, origins });
      return true;
    } catch {
      set({ pushing: null, error: 'network-error' });
      return false;
    }
  },
}));
