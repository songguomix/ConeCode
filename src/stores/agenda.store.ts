import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  SUGGEST_SYSTEM_PROMPT,
  buildScanBriefing,
  parseSuggestions,
  rankTasks,
  recoverOpenTodos,
  type ResumeCandidate,
  type SuggestedTask,
  type WorkspaceScan,
} from '../core/agenda/agenda';
import { useWorkspaceStore } from './workspace.store';
import { useChatStore } from './chat.store';
import { useCodeChangesStore } from './codeChanges.store';

// Suggestions are cached per project so reopening the app shows yesterday's
// proposals instantly instead of spending tokens again. Kept in localStorage:
// it's a cache, not data worth an IPC round-trip.
const CACHE_KEY = 'agendaCache';
const CACHE_TTL = 12 * 60 * 60 * 1000;

// Upper bound on the file walk. Hitting it means fileCount is a floor.
const FILE_SCAN_CAP = 4000;

interface CacheShape {
  [rootPath: string]: { tasks: SuggestedTask[]; generatedAt: number };
}

function readCache(): CacheShape {
  try {
    return JSON.parse(localStorage.getItem(CACHE_KEY) || '{}');
  } catch {
    return {};
  }
}

function writeCache(rootPath: string, tasks: SuggestedTask[], generatedAt: number) {
  try {
    const cache = readCache();
    cache[rootPath] = { tasks, generatedAt };
    localStorage.setItem(CACHE_KEY, JSON.stringify(cache));
  } catch {}
}

interface AgendaStore {
  scan: WorkspaceScan | null;
  tasks: SuggestedTask[];
  generatedAt: number | null;
  scanning: boolean;
  suggesting: boolean;
  error: string | null;
  resume: ResumeCandidate[];

  scanWorkspace: () => Promise<WorkspaceScan | null>;
  /** Show a warm cache without contacting the provider. */
  loadCached: () => void;
  /** Scan (if needed) then ask the model for work. `force` bypasses the cache. */
  findWork: (providerId: string, modelId: string, force?: boolean) => Promise<void>;
  loadResume: () => Promise<void>;
  reset: () => void;
}

export const useAgendaStore = create<AgendaStore>((set, get) => ({
  scan: null,
  tasks: [],
  generatedAt: null,
  scanning: false,
  suggesting: false,
  error: null,
  resume: [],

  reset: () => set({ scan: null, tasks: [], generatedAt: null, error: null }),

  /**
   * Read the real state of the workspace. Everything here is cheap and local —
   * no model involved — so the home screen has something true to show even
   * before (or without) a suggestion pass.
   */
  scanWorkspace: async () => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return null;
    set({ scanning: true, error: null });
    try {
      const api = window.electronAPI;
      const [git, statusText, diffText, todoMatches, files] = await Promise.all([
        api.git.info(rootPath).catch(() => ({ isRepo: false, branch: null, dirty: 0 })),
        api.git.status(rootPath).catch(() => ''),
        api.git.diff(rootPath).catch(() => ''),
        api.fs
          .search({ query: '(TODO|FIXME|XXX|HACK)[:( ]', dir: rootPath, isRegex: true, maxResults: 40 })
          .catch(() => []),
        api.fs.glob({ pattern: '**/*', dir: rootPath, maxResults: FILE_SCAN_CAP }).catch(() => []),
      ]);

      // package.json gives the project's real name and commands, which makes the
      // proposed prompts concrete ("run npm test") instead of generic.
      let scripts: string[] = [];
      let projectName: string | null = null;
      try {
        const pkgRaw = await api.fs.readFile(`${rootPath}/package.json`);
        if (pkgRaw) {
          const pkg = JSON.parse(pkgRaw);
          projectName = typeof pkg.name === 'string' ? pkg.name : null;
          scripts = Object.keys(pkg.scripts || {});
        }
      } catch {}

      let readmeHead = '';
      for (const name of ['README.md', 'readme.md', 'README']) {
        const text = await api.fs.readFile(`${rootPath}/${name}`).catch(() => null);
        if (text) { readmeHead = text.slice(0, 1200); break; }
      }

      const relative = files.map((f) => f.replace(rootPath.replace(/\/$/, '') + '/', ''));
      const scan: WorkspaceScan = {
        rootPath,
        scannedAt: Date.now(),
        git,
        statusText: statusText.slice(0, 2500),
        diffText: diffText.slice(0, 6000),
        todoComments: todoMatches.slice(0, 25).map((m) => ({
          file: m.file.replace(rootPath.replace(/\/$/, '') + '/', ''),
          line: m.line,
          text: m.text.slice(0, 160),
        })),
        scripts,
        projectName,
        readmeHead,
        hasTests: relative.some((f) => /(\.|_)(test|spec)\.[cm]?[jt]sx?$/.test(f) || /(^|\/)(tests?|__tests__)\//.test(f)),
        fileCount: relative.length,
        fileCountCapped: relative.length >= FILE_SCAN_CAP,
        languages: detectLanguages(relative),
      };
      set({ scan, scanning: false });
      return scan;
    } catch (e: any) {
      set({ scanning: false, error: e?.message || String(e) });
      return null;
    }
  },

  // Opening the home screen must never spend tokens on its own, but a previous
  // run's proposals are still useful — so the cache is shown immediately and a
  // fresh pass stays an explicit click.
  loadCached: () => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return;
    const cached = readCache()[rootPath];
    if (cached?.tasks?.length && Date.now() - cached.generatedAt < CACHE_TTL) {
      set({ tasks: rankTasks(cached.tasks), generatedAt: cached.generatedAt, error: null });
    }
  },

  findWork: async (providerId, modelId, force = false) => {
    const rootPath = useWorkspaceStore.getState().rootPath;
    if (!rootPath) return;

    if (!force) {
      const cached = readCache()[rootPath];
      if (cached && Date.now() - cached.generatedAt < CACHE_TTL && cached.tasks.length) {
        set({ tasks: rankTasks(cached.tasks), generatedAt: cached.generatedAt, error: null });
        // Still refresh the local facts so the header is accurate.
        void get().scanWorkspace();
        return;
      }
    }

    const scan = get().scan?.rootPath === rootPath && !force ? get().scan : await get().scanWorkspace();
    if (!scan) return;

    set({ suggesting: true, error: null });
    try {
      const result = await window.electronAPI.chat.stream({
        providerId,
        modelId,
        // Silent: this must not appear in the transcript's streaming view.
        silent: true,
        maxTokens: 2000,
        messages: [
          { role: 'system', content: SUGGEST_SYSTEM_PROMPT },
          { role: 'user', content: buildScanBriefing(scan) },
        ],
      });

      const tasks = rankTasks(parseSuggestions(extractText(result), uuidv4));
      if (!tasks.length) {
        set({ suggesting: false, error: 'empty' });
        return;
      }
      const generatedAt = Date.now();
      set({ tasks, generatedAt, suggesting: false, error: null });
      writeCache(rootPath, tasks, generatedAt);
    } catch (e: any) {
      set({ suggesting: false, error: e?.message || String(e) });
    }
  },

  /**
   * Build the "pick up where you left off" list from real conversation state:
   * what was last said, which checklist items are still open, and how many
   * proposed changes were never resolved.
   */
  loadResume: async () => {
    const conversations = useChatStore.getState().conversations;
    const changes = useCodeChangesStore.getState().changes;
    const recent = conversations
      .filter((c) => c.title && c.title !== 'New Chat')
      .slice(0, 4);

    const out: ResumeCandidate[] = [];
    for (const conv of recent) {
      let messages: { content: string; role: string }[] = [];
      try {
        messages = (await window.electronAPI.message.list(conv.id)) as any[];
      } catch {}
      if (!messages.length) continue;
      const last = [...messages].reverse().find((m) => (m.content || '').trim());
      out.push({
        conversationId: conv.id,
        title: conv.title,
        rootPath: conv.rootPath,
        updatedAt: conv.updatedAt,
        lastMessage: (last?.content || '').replace(/```[\s\S]*?```/g, '').replace(/\s+/g, ' ').trim().slice(0, 180),
        openTodos: recoverOpenTodos(messages),
        pendingChanges: changes.filter((c) => c.conversationId === conv.id && c.status === 'pending').length,
      });
    }
    set({ resume: out });
  },
}));

function detectLanguages(files: string[]): string[] {
  const counts = new Map<string, number>();
  const byExt: Record<string, string> = {
    ts: 'TypeScript', tsx: 'TypeScript', js: 'JavaScript', jsx: 'JavaScript',
    py: 'Python', go: 'Go', rs: 'Rust', java: 'Java', kt: 'Kotlin', swift: 'Swift',
    rb: 'Ruby', php: 'PHP', cs: 'C#', cpp: 'C++', c: 'C', vue: 'Vue', svelte: 'Svelte',
  };
  for (const f of files) {
    const ext = f.split('.').pop()?.toLowerCase() || '';
    const lang = byExt[ext];
    if (lang) counts.set(lang, (counts.get(lang) || 0) + 1);
  }
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([l]) => l);
}

function extractText(result: any): string {
  if (!result || typeof result !== 'object') return '';
  const msg = result.choices?.[0]?.message;
  if (msg && typeof msg.content === 'string') return msg.content;
  if (Array.isArray(result.content)) {
    return result.content.map((b: any) => (typeof b?.text === 'string' ? b.text : '')).join('');
  }
  const parts = result.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p: any) => (typeof p?.text === 'string' ? p.text : '')).join('');
  return '';
}
