import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  EXTRACTION_SYSTEM_PROMPT,
  formatMemoryPrompt,
  mergeMemories,
  migrateEntries,
  parseExtraction,
  selectRelevant,
  type MemoryEntry,
} from '../core/memory/memory';

// How many messages of the exchange to show the extractor. Enough to see a
// correction and its context, small enough to stay cheap.
const EXTRACTION_WINDOW = 8;

// Extraction is a second provider call, so running it after EVERY turn would
// roughly double the round-trips of a session. It runs on the first turn (so a
// new user is learned immediately) and then every Nth turn — the window above
// covers the turns in between, so nothing is missed, it just lands later.
const EXTRACT_EVERY_TURNS = 3;

interface MemoryStore {
  entries: MemoryEntry[];
  enabled: boolean;
  loaded: boolean;
  /** Guards against two extractions racing each other into a duplicate write. */
  extracting: boolean;
  /** Turns seen since the last extraction, for the cadence guard. */
  turnsSinceExtraction: number;
  load: () => Promise<void>;
  setEnabled: (on: boolean) => void;
  remove: (id: string) => Promise<void>;
  clear: () => Promise<void>;
  add: (text: string, kind?: MemoryEntry['kind'], projectPath?: string | null, why?: string) => Promise<void>;
  /** Memories that apply to the current workspace, ready for the prompt. */
  promptBlock: (projectPath?: string | null) => string;
  relevant: (projectPath?: string | null) => MemoryEntry[];
  /** Learn from the exchange that just finished. Never throws. */
  learnFromExchange: (opts: {
    providerId: string;
    modelId: string;
    messages: { role: string; content: string }[];
    projectPath?: string | null;
  }) => Promise<void>;
}

export const useMemoryStore = create<MemoryStore>((set, get) => ({
  entries: [],
  enabled: true,
  loaded: false,
  extracting: false,
  turnsSinceExtraction: 0,

  load: async () => {
    try {
      // Everything on disk predates the workflow/project kinds, so it is brought
      // forward on read rather than trusted as-is — an entry left under a
      // retired kind would quietly stop appearing in the prompt.
      set({ entries: migrateEntries(await window.electronAPI.memory.list()), loaded: true });
    } catch {
      set({ loaded: true });
    }
  },

  setEnabled: (on) => set({ enabled: on }),

  remove: async (id) => {
    const entries = get().entries.filter((e) => e.id !== id);
    set({ entries });
    await persist(entries);
  },

  clear: async () => {
    set({ entries: [] });
    await persist([]);
  },

  add: async (text, kind = 'workflow', projectPath, why) => {
    const value = text.trim();
    if (!value) return;
    const entries = mergeMemories(
      get().entries,
      // A project memory is meaningless without a project to hang it on, so it
      // falls back to global rather than being written somewhere it can't be read.
      [{ kind, text: value, why: why?.trim() || undefined, scope: kind === 'project' || projectPath ? 'project' : 'global' }],
      { projectPath, makeId: uuidv4 },
    );
    set({ entries });
    await persist(entries);
  },

  relevant: (projectPath) => selectRelevant(get().entries, projectPath),

  promptBlock: (projectPath) => {
    if (!get().enabled) return '';
    return formatMemoryPrompt(selectRelevant(get().entries, projectPath));
  },

  learnFromExchange: async ({ providerId, modelId, messages, projectPath }) => {
    const state = get();
    if (!state.enabled || state.extracting) return;

    const window_ = messages.slice(-EXTRACTION_WINDOW);
    // Nothing the user actually said → nothing to learn.
    if (!window_.some((m) => m.role === 'user')) return;

    // Cadence: always learn from the first turn, then every Nth one.
    const turns = state.turnsSinceExtraction + 1;
    const firstEver = state.entries.length === 0;
    if (!firstEver && turns < EXTRACT_EVERY_TURNS) {
      set({ turnsSinceExtraction: turns });
      return;
    }

    set({ extracting: true, turnsSinceExtraction: 0 });
    try {
      const known = selectRelevant(state.entries, projectPath).map((e) => `- ${e.text}`).join('\n');
      const transcript = window_
        .map((m) => `${m.role === 'assistant' ? 'Assistant' : 'User'}: ${truncate(m.content, 2000)}`)
        .join('\n\n');

      const result = await window.electronAPI.chat.stream({
        providerId,
        modelId,
        // Silent: this runs after the visible turn and must not touch the
        // transcript's streaming view.
        silent: true,
        maxTokens: 600,
        messages: [
          { role: 'system', content: EXTRACTION_SYSTEM_PROMPT },
          {
            role: 'user',
            content: `Existing memory (do not repeat these):\n${known || '(empty)'}\n\n---\nRecent exchange:\n${transcript}`,
          },
        ],
      });

      const raw = extractText(result);
      const parsed = parseExtraction(raw);
      if (!parsed.length) return;

      const entries = mergeMemories(get().entries, parsed, { projectPath, makeId: uuidv4 });
      set({ entries });
      await persist(entries);
    } catch {
      // Memory is an enhancement — a failed extraction must never surface as an
      // error on the user's turn.
    } finally {
      set({ extracting: false });
    }
  },
}));

async function persist(entries: MemoryEntry[]) {
  try {
    await window.electronAPI.memory.save(entries);
  } catch {}
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : text.slice(0, max) + '…';
}

// The extractor call goes through the same provider adapters as a chat turn, so
// its reply arrives in one of the three provider shapes.
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
