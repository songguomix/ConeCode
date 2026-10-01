import { create } from 'zustand';
import { addedLineNumbers } from '../core/editor/diff';

/**
 * Green marks for AI-written code, grouped by Q&A turn.
 * One user question + the assistant's follow-up edits = one turn
 * (turnId = the assistant messageId, or the conversationId when unknown).
 * The editor paints these lines green like VS Code's git gutter.
 */

export interface AiTurn {
  id: string;
  conversationId: string;
  messageId?: string;
  createdAt: number;
}

interface AiHighlightsStore {
  /** filePath -> sorted 1-based added line numbers from the latest AI edit. */
  lines: Record<string, number[]>;
  /** filePath -> turn that produced the current marks. */
  turnOf: Record<string, string>;
  turns: Record<string, AiTurn>;
  /** Latest turn first, for the "per Q&A" grouping. */
  turnOrder: string[];
  markAiEdit: (args: {
    filePath: string;
    original: string;
    updated: string;
    conversationId?: string;
    messageId?: string;
  }) => number[];
  clearFile: (filePath: string) => void;
  clearAll: () => void;
  /** Drop marks on lines the user has since rewritten (called on manual edit). */
  retainExistingLines: (filePath: string, content: string) => void;
}

const MAX_FILES = 100;

export const useAiHighlightsStore = create<AiHighlightsStore>((set, get) => ({
  lines: {},
  turnOf: {},
  turns: {},
  turnOrder: [],

  markAiEdit: ({ filePath, original, updated, conversationId, messageId }) => {
    if (!filePath || filePath.startsWith('[')) return [];
    const added = addedLineNumbers(original ?? '', updated ?? '');
    if (!added.length) return [];
    const turnId = messageId || `conv:${conversationId || 'unknown'}`;
    set((s) => {
      const lines = { ...s.lines, [filePath]: added };
      // Bound memory: drop the oldest file's marks past the cap.
      const keys = Object.keys(lines);
      if (keys.length > MAX_FILES) {
        const oldest = keys.find((k) => k !== filePath);
        if (oldest) delete lines[oldest];
      }
      const turnOf = { ...s.turnOf, [filePath]: turnId };
      const turns = { ...s.turns };
      if (!turns[turnId]) {
        turns[turnId] = {
          id: turnId,
          conversationId: conversationId || '',
          messageId,
          createdAt: Date.now(),
        };
      }
      const turnOrder = [turnId, ...s.turnOrder.filter((t) => t !== turnId)];
      return { lines, turnOf, turns, turnOrder: turnOrder.slice(0, 50) };
    });
    return added;
  },

  clearFile: (filePath) =>
    set((s) => {
      if (!s.lines[filePath]) return {} as any;
      const lines = { ...s.lines };
      const turnOf = { ...s.turnOf };
      delete lines[filePath];
      delete turnOf[filePath];
      return { lines, turnOf };
    }),

  clearAll: () => set({ lines: {}, turnOf: {} }),

  retainExistingLines: (filePath, content) => {
    const current = get().lines[filePath];
    if (!current?.length) return;
    const total = content === '' ? 0 : content.split('\n').length;
    const kept = current.filter((n) => n >= 1 && n <= Math.max(total, 1));
    if (kept.length === current.length) return;
    if (!kept.length) {
      get().clearFile(filePath);
      return;
    }
    set((s) => ({ lines: { ...s.lines, [filePath]: kept } }));
  },
}));

/** Test seam: reset between tests. */
export function resetAiHighlights() {
  useAiHighlightsStore.setState({ lines: {}, turnOf: {}, turns: {}, turnOrder: [] });
}
