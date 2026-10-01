import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import { useWorkspaceStore } from './workspace.store';
import type { Message } from '../types';

// The operation a change performs. Set explicitly at the proposal site — never
// inferred from the free-text description (which mis-fires when an edit's
// description happens to contain a word like "delete"/"rename"/"copy").
export type ChangeKind = 'edit' | 'create' | 'delete' | 'rename' | 'copy' | 'exec' | 'computer';

export interface CodeChange {
  id: string;
  kind: ChangeKind;
  filePath: string;
  originalCode: string;
  newCode: string;
  description: string;
  status: 'pending' | 'applied' | 'reverted' | 'failed';
  createdAt: number;
  cwd?: string;
  /** Required for hdiutil disk-image operations under the macOS command sandbox. */
  allowDiskImages?: boolean;
  // Conversation that proposed this change, so the outcome can be fed back to the model.
  conversationId?: string;
  providerId?: string;
  modelId?: string;
  // Assistant message that proposed this change, so its approval card can be
  // rendered inline right after that message in the transcript.
  messageId?: string;
}

// Outcomes collected per conversation, flushed back to the model once the user
// has resolved (applied/rejected) every pending change IN THAT CONVERSATION.
// Keyed by conversation: a single global list let one chat's pending card block
// another chat's flush, and sent the results to whichever conversation happened
// to own the first change in the list.
const batchResults = new Map<string, string[]>();

/** Locate the real user turn that owns an assistant change proposal. */
export function checkpointRewindIndex(messages: Message[], messageId: string): number {
  const idx = messages.findIndex((message) => message.id === messageId);
  if (idx === -1) return -1;
  for (let i = idx - 1; i >= 0; i--) {
    const candidate = messages[i];
    if (candidate.role === 'user' && !candidate.isToolResult && !candidate.isLocalNotice) return i;
  }
  return idx;
}

function recordOutcome(change: CodeChange, text: string) {
  const convId = change.conversationId;
  if (!convId) return;
  const list = batchResults.get(convId) || [];
  list.push(text);
  batchResults.set(convId, list);
}

async function flushIfResolved(convId: string | undefined) {
  if (!convId) return;
  const { changes } = useCodeChangesStore.getState();
  const stillPending = changes.some((c) => c.conversationId === convId && c.status === 'pending');
  const results = batchResults.get(convId);
  if (stillPending || !results?.length) return;

  const ctx = changes.find((c) => c.conversationId === convId && c.providerId && c.modelId);
  batchResults.delete(convId);
  if (!ctx) return;

  const { useChatStore } = await import('./chat.store');
  // Fire-and-forget: this kicks off a new (streamed) assistant turn; we must
  // not block the Apply button on it.
  void useChatStore.getState().feedToolResults(
    convId,
    ctx.providerId!,
    ctx.modelId!,
    results.join('\n\n'),
  );
}

// Perform a change's filesystem/command effect and keep the open editor in sync.
// Pure side effect: does not touch change status, the model batch, or flush — so
// both the manual (applyChange) and auto-approve (autoApply) paths can reuse it.
async function applyEffect(change: CodeChange): Promise<{ success: boolean; result: string }> {
  let result = '';
  let success = false;
  const kind = change.kind || 'edit';

  try {
    if (kind === 'delete') {
      if (change.originalCode === '[Directory]') {
        success = await window.electronAPI.fs.deleteDir(change.filePath);
      } else {
        success = await window.electronAPI.fs.deleteFile(change.filePath);
      }
      result = success ? `Deleted: ${change.filePath}` : `Failed to delete: ${change.filePath}`;
    } else if (kind === 'rename') {
      const newPath = change.newCode.replace('Rename to: ', '');
      success = await window.electronAPI.fs.rename(change.filePath, newPath);
      result = success ? `Renamed to: ${newPath}` : `Failed to rename`;
    } else if (kind === 'copy') {
      const destPath = change.newCode.replace('Copy to: ', '');
      success = await window.electronAPI.fs.copy(change.filePath, destPath);
      result = success ? `Copied to: ${destPath}` : `Failed to copy`;
    } else if (kind === 'exec') {
      const command = change.newCode;
      const cwd = change.cwd || useWorkspaceStore.getState().rootPath || undefined;
      // Confine the command: it may read the machine but only write inside the
      // workspace (see core/exec/sandbox.ts). The main process resolves the real
      // paths and falls back to unconfined where seatbelt is unavailable.
      const { useSettingsStore: settingsStore } = await import('./settings.store');
      const settings = settingsStore.getState();
      const execResult = await window.electronAPI.exec.run(command, cwd, {
        mode: settings.sandboxMode,
        allowNetwork: settings.sandboxAllowNetwork,
        allowDiskImages: change.allowDiskImages === true,
      });
      success = execResult.success;
      result = execResult.success
        ? `Command output:\n${execResult.stdout}`
        : `Command failed (exit code ${execResult.exitCode}):\n${execResult.stderr}` +
          (execResult.stdout ? `\n--- stdout ---\n${execResult.stdout}` : '');
    } else if (kind === 'computer') {
      // The pointer/keyboard request rides in newCode as JSON so the approval
      // card can show it verbatim before anything touches the screen.
      const request = JSON.parse(change.newCode);
      const outcome = await window.electronAPI.computer.act(request);
      success = outcome.ok;
      result = outcome.message + (outcome.cursor ? `\nPointer is now at (${outcome.cursor.join(', ')}).` : '');
    } else if (kind === 'create') {
      success = await window.electronAPI.fs.writeFile(change.filePath, change.newCode);
      result = success ? `File created: ${change.filePath}` : `Failed to create file`;
    } else {
      // edit
      success = await window.electronAPI.fs.writeFile(change.filePath, change.newCode);
      result = success ? `File updated: ${change.filePath}` : `Failed to update file`;
    }
  } catch (error: any) {
    console.error('[applyEffect] Error:', error);
    success = false;
    result = `Error: ${error.message || 'Unknown error'}`;
  }

  // Keep the open editor consistent with what just changed on disk.
  if (success && kind !== 'exec' && change.filePath !== '[Command]') {
    // Green marks for this Q&A turn: every AI-written line is highlighted in
    // the editor until the user clears it. One assistant message = one turn.
    if (kind === 'edit' || kind === 'create') {
      try {
        const { useAiHighlightsStore } = await import('./aiHighlights.store');
        useAiHighlightsStore.getState().markAiEdit({
          filePath: change.filePath,
          original: kind === 'create' ? '' : change.originalCode,
          updated: change.newCode,
          conversationId: change.conversationId,
          messageId: change.messageId,
        });
      } catch {}
    }
    const ws = useWorkspaceStore.getState();
    if (ws.selectedFile === change.filePath) {
      if (kind === 'delete' || kind === 'rename') {
        ws.closeFile();
      } else if (kind !== 'copy') {
        await ws.selectFile(change.filePath); // reload edited content into the editor
      }
    }
  }

  return { success, result };
}

// Undo one applied edit against the CURRENT file content. Writing the stale
// `original` snapshot back would wipe out any edits made to the same file AFTER
// this change was applied, so instead: diff the two snapshots down to their
// single changed region (common prefix/suffix stripped), expand it to whole
// lines, and reverse just those lines in the current content. Later edits to
// OTHER lines survive; if the changed lines themselves were edited again (the
// needle no longer occurs) or can't be located unambiguously even with maximal
// context, return null — there is no safe automatic revert anymore.
export function reverseEdit(current: string, original: string, updated: string): string | null {
  if (current === updated) return original;
  let p = 0;
  const minLen = Math.min(original.length, updated.length);
  while (p < minLen && original[p] === updated[p]) p++;
  let so = original.length;
  let su = updated.length;
  while (so > p && su > p && original[so - 1] === updated[su - 1]) { so--; su--; }

  // Expand [p, su) / [p, so) to line boundaries. The expansion text comes from
  // the shared prefix/suffix, so the same indices are valid in both snapshots.
  let start = updated.lastIndexOf('\n', p - 1) + 1;
  let endNew = updated.indexOf('\n', su);
  endNew = endNew === -1 ? updated.length : endNew + 1;
  let endOld = so + (endNew - su);

  let needle = updated.slice(start, endNew);
  let replacement = original.slice(start, endOld);

  for (;;) {
    const count = needle ? current.split(needle).length - 1 : 0;
    if (count === 1) return current.replace(needle, replacement);
    // Non-empty needle not found: the changed lines were edited again — bail
    // out rather than guess.
    if (count === 0 && needle) return null;
    // Ambiguous (or zero-width) — grow the anchor by one line on each side.
    if (start === 0 && endNew >= updated.length) return null;
    const grownEnd = updated.indexOf('\n', endNew);
    endOld += (grownEnd === -1 ? updated.length : grownEnd + 1) - endNew;
    endNew = grownEnd === -1 ? updated.length : grownEnd + 1;
    start = start === 0 ? 0 : updated.lastIndexOf('\n', start - 2) + 1;
    needle = updated.slice(start, endNew);
    replacement = original.slice(start, endOld);
  }
}

/**
 * Undo one APPLIED change's effect on disk. Every kind the agent can perform is
 * reversible from what the change already stores — previously only plain edits
 * were undone, so an approved delete/rename/copy was marked "reverted" in the UI
 * while the filesystem kept the change.
 *
 * Refuses (rather than guesses) whenever the file has moved on since: a revert
 * must never destroy work the user or a later edit produced.
 */
export async function undoEffect(change: CodeChange): Promise<{ success: boolean; error?: string }> {
  const kind = change.kind || 'edit';
  const name = change.filePath.split('/').pop() || change.filePath;

  try {
    if (kind === 'exec') {
      // Running a command is not reversible — the caller reports this rather
      // than pretending the effect was undone.
      return { success: false, error: `Command was not undone (commands can't be reverted): ${change.newCode}` };
    }

    if (kind === 'computer') {
      // A click or keystroke has already landed in another application; there is
      // nothing here to put back.
      return { success: false, error: 'Screen and keyboard actions cannot be undone.' };
    }

    if (kind === 'create') {
      const current = await window.electronAPI.fs.readFile(change.filePath);
      if (current === null) return { success: true }; // already gone
      if (current !== change.newCode) {
        return { success: false, error: `${name} was modified after it was created — delete it manually if you still want it gone.` };
      }
      const ok = await window.electronAPI.fs.deleteFile(change.filePath);
      return ok ? { success: true } : { success: false, error: `Could not delete ${name}` };
    }

    if (kind === 'delete') {
      if (change.originalCode === '[Directory]') {
        const ok = await window.electronAPI.fs.createDir(change.filePath);
        return ok
          ? { success: false, error: `Recreated the folder ${name}, but its contents could not be restored.` }
          : { success: false, error: `Could not recreate ${name}` };
      }
      if (await window.electronAPI.fs.exists(change.filePath)) {
        return { success: false, error: `${name} exists again — not overwriting it.` };
      }
      const ok = await window.electronAPI.fs.writeFile(change.filePath, change.originalCode);
      return ok ? { success: true } : { success: false, error: `Could not restore ${name}` };
    }

    if (kind === 'rename') {
      const newPath = change.newCode.replace('Rename to: ', '');
      if (!(await window.electronAPI.fs.exists(newPath))) {
        return { success: false, error: `${newPath.split('/').pop()} is no longer there — rename it back manually.` };
      }
      if (await window.electronAPI.fs.exists(change.filePath)) {
        return { success: false, error: `${name} already exists — not overwriting it.` };
      }
      const ok = await window.electronAPI.fs.rename(newPath, change.filePath);
      return ok ? { success: true } : { success: false, error: `Could not rename ${newPath} back` };
    }

    if (kind === 'copy') {
      const destPath = change.newCode.replace('Copy to: ', '');
      const current = await window.electronAPI.fs.readFile(destPath);
      if (current === null) return { success: true }; // copy already gone
      const source = await window.electronAPI.fs.readFile(change.filePath);
      // Only remove the copy while it is still a copy; once edited it is the
      // user's own file.
      if (source !== null && current !== source) {
        return { success: false, error: `${destPath.split('/').pop()} was modified after the copy — delete it manually.` };
      }
      const ok = await window.electronAPI.fs.deleteFile(destPath);
      return ok ? { success: true } : { success: false, error: `Could not delete ${destPath}` };
    }

    // edit — reverse just this change's lines against the CURRENT content so
    // later edits elsewhere in the file survive.
    const current = await window.electronAPI.fs.readFile(change.filePath);
    if (current === null) return { success: false, error: `Could not read ${name}` };
    if (current === change.originalCode) return { success: true }; // already back
    const restored = reverseEdit(current, change.originalCode, change.newCode);
    if (restored === null) {
      return { success: false, error: `${name} changed after this edit was applied; revert it manually.` };
    }
    const ok = await window.electronAPI.fs.writeFile(change.filePath, restored);
    return ok ? { success: true } : { success: false, error: `Could not write ${name}` };
  } catch (e: any) {
    return { success: false, error: e?.message || String(e) };
  }
}

// After an undo, bring the open editor and file tree back in line with disk.
async function resyncWorkspace(filePath: string) {
  const ws = useWorkspaceStore.getState();
  if (ws.selectedFile !== filePath) return;
  if (await window.electronAPI.fs.exists(filePath)) await ws.selectFile(filePath);
  else ws.closeFile();
}

interface CodeChangesStore {
  changes: CodeChange[];
  addChange: (change: Omit<CodeChange, 'id' | 'status' | 'createdAt'>) => Promise<string>;
  applyChange: (id: string) => Promise<{ success: boolean; result?: string }>;
  autoApply: (id: string) => Promise<{ success: boolean; result?: string }>;
  revertChange: (id: string) => Promise<{ success: boolean; error?: string }>;
  /** Roll reversible workspace effects and the conversation back to before `messageId`. */
  revertToMessage: (messageId: string) => Promise<{
    success: boolean;
    error?: string;
    undone: number;
    retainedEffects: number;
  }>;
  clearChanges: () => void;
  discardMessageApprovals: (conversationId: string, messageIds: Set<string>) => void;
}

function isIrreversible(change: CodeChange): boolean {
  const kind = change.kind || 'edit';
  return kind === 'exec' || kind === 'computer';
}

function changeLabel(change: CodeChange): string {
  if ((change.kind || 'edit') === 'exec') return `command \`${change.newCode}\``;
  if ((change.kind || 'edit') === 'computer') return 'computer action';
  return change.filePath;
}

export const useCodeChangesStore = create<CodeChangesStore>((set, get) => ({
  changes: [],

  addChange: async (change) => {
    const newChange: CodeChange = {
      ...change,
      id: uuidv4(),
      status: 'pending' as any,
      createdAt: Date.now(),
    };
    // Cards now render inline in the chat (see MessageChanges), so we no longer
    // pop the full-screen review modal.
    set((s) => ({ changes: [newChange, ...s.changes] }));
    return newChange.id;
  },

  applyChange: async (id: string) => {
    const change = get().changes.find((c) => c.id === id);
    if (!change) return { success: false, result: 'Change not found' };

    const { success, result } = await applyEffect(change);

    set((s) => ({
      changes: s.changes.map((c) => c.id === id
        ? { ...c, status: success ? 'applied' as const : 'failed' as const }
        : c),
    }));

    const label = changeLabel(change);
    recordOutcome(change, success
      ? `User approved ${label}.\n${result}`
      : `User approved ${label}, but the action failed.\n${result}`);
    await flushIfResolved(change.conversationId);

    return { success, result };
  },

  // Auto-approve path: run the effect and mark applied, but do NOT push to the
  // model batch or flush here. The agent loop calls this inline, takes the
  // returned result, and continues the turn itself (see runAgentLoop) — avoiding
  // the re-entrant stream that flushIfResolved would otherwise kick off.
  autoApply: async (id: string) => {
    const change = get().changes.find((c) => c.id === id);
    if (!change) return { success: false, result: 'Change not found' };

    const { success, result } = await applyEffect(change);

    set((s) => ({
      changes: s.changes.map((c) => c.id === id
        ? { ...c, status: success ? 'applied' as const : 'failed' as const }
        : c),
    }));

    return { success, result };
  },

  revertChange: async (id) => {
    const change = get().changes.find((c) => c.id === id);
    if (!change) return { success: false, error: 'Change not found' };

    if (change.status === 'reverted') return { success: true };
    if (change.status === 'failed') {
      return { success: false, error: 'This action failed and has no applied effect to undo.' };
    }

    const wasPending = change.status === 'pending';
    const wasApplied = change.status === 'applied';

    // This is deliberately a single-change undo. It never truncates chat. The
    // separate checkpoint action below owns the destructive conversation rewind.
    if (wasApplied) {
      const undo = await undoEffect(change);
      if (!undo.success) return { success: false, error: undo.error };
      await resyncWorkspace(change.filePath);
      // The AI-written lines are gone — drop their green marks too.
      try {
        const { useAiHighlightsStore } = await import('./aiHighlights.store');
        useAiHighlightsStore.getState().clearFile(change.filePath);
      } catch {}
    }

    set((s) => ({
      changes: s.changes.map((c) => c.id === id ? { ...c, status: 'reverted' as const } : c),
    }));

    // Both rejecting a proposal and undoing an already-applied edit change the
    // workspace state the model should build on. Keep the transcript and append a
    // tool outcome so the next turn does not assume the old change still exists.
    if (wasPending) {
      const label = changeLabel(change);
      recordOutcome(change, `User rejected ${label}. Do not retry it unless asked.`);
      await flushIfResolved(change.conversationId);
    } else if (wasApplied) {
      const label = changeLabel(change);
      recordOutcome(
        change,
        `User undid the previously applied change to ${label}. The conversation remains, but the workspace no longer includes that change.`,
      );
      await flushIfResolved(change.conversationId);
    }
    return { success: true };
  },

  /**
   * Explicit checkpoint restore: undo every reversible change from `messageId`
   * onward, then drop those messages. Commands and computer actions are historical
   * facts: their external effects remain and their status must stay `applied`.
   */
  revertToMessage: async (messageId) => {
    const { useChatStore } = await import('./chat.store');
    const messages = useChatStore.getState().messages;
    const idx = messages.findIndex((m) => m.id === messageId);
    if (idx === -1) {
      return { success: false, error: 'Message not found', undone: 0, retainedEffects: 0 };
    }

    // A stream in flight would keep appending to the history we're truncating.
    useChatStore.getState().stopGeneration();

    // A change is attached to the assistant turn that proposed it, but the
    // checkpoint is the user's turn that started that work. Remove the prompt
    // too; otherwise the rolled-back request remains visible and is replayed on
    // the next load as if the work still exists.
    const rewindIdx = checkpointRewindIndex(messages, messageId);
    const rewindMessageId = messages[rewindIdx].id;
    const doomed = new Set(messages.slice(rewindIdx).map((m) => m.id));
    // Newest first: stacked edits to one file must unwind in reverse order, or
    // an older snapshot's anchor text won't be found in the current content.
    const affected = get().changes
      .filter((c) => c.messageId && doomed.has(c.messageId))
      .sort((a, b) => b.createdAt - a.createdAt);

    const errors: string[] = [];
    const undoneIds = new Set<string>();
    const retainedEffects = affected.filter((change) => change.status === 'applied' && isIrreversible(change)).length;
    for (const change of affected) {
      if (change.status !== 'applied') continue;
      // External effects cannot be reversed. Skipping them is an accepted,
      // explicitly previewed outcome — but unlike the old implementation we do
      // not later relabel them as reverted.
      if (isIrreversible(change)) continue;
      const undo = await undoEffect(change);
      if (undo.success) undoneIds.add(change.id);
      else if (undo.error) errors.push(undo.error);
      await resyncWorkspace(change.filePath);
    }

    if (errors.length) {
      // Something on disk could not be safely restored. Keep the conversation —
      // deleting it would strip the user of the context needed to fix the rest
      // by hand — and report exactly what was left alone.
      set((s) => ({
        changes: s.changes.map((c) => (undoneIds.has(c.id) ? { ...c, status: 'reverted' as const } : c)),
      }));
      return {
        success: false,
        error: errors.join('\n'),
        undone: undoneIds.size,
        retainedEffects,
      };
    }

    set((s) => ({
      changes: s.changes.map((c) => {
        if (!c.messageId || !doomed.has(c.messageId)) return c;
        if (c.status === 'applied' && isIrreversible(c)) return c;
        return { ...c, status: 'reverted' as const };
      }),
    }));

    // Those messages are gone, so any queued approval outcomes for them are
    // meaningless — dropping them prevents a stale flush starting a new turn.
    const convId = messages[rewindIdx].conversationId;
    if (convId) batchResults.delete(convId);

    await useChatStore.getState().truncateFrom(rewindMessageId);

    return { success: true, undone: undoneIds.size, retainedEffects };
  },

  discardMessageApprovals: (conversationId, messageIds) => {
    batchResults.delete(conversationId);
    // Editing chat does not undo applied file or external effects. Only drop
    // unexecuted approvals belonging to the discarded transcript.
    set((s) => ({ changes: s.changes.filter((c) =>
      !(c.status === 'pending' && c.messageId && messageIds.has(c.messageId))) }));
  },

  clearChanges: () => set({ changes: [] }),
}));
