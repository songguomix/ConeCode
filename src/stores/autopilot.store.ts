import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  FALLBACK_IDEAS,
  IDEAS_SYSTEM_PROMPT,
  buildAutopilotPrompt,
  buildRepairPrompt,
  extractVerifyCommand,
  guessVerifyCommand,
  parseIdeas,
  slugify,
  uniqueFolderName,
  type ProjectIdea,
} from '../core/agenda/newProject';
import { useChatStore } from './chat.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';

// Autopilot: the user picks an idea and nothing else. Everything below runs
// unattended — create the folder, build the project, then VERIFY it by actually
// running the project's own command, and hand failures back for repair until it
// passes. "It compiles in the transcript" is not finished; exit code 0 is.

const PROJECTS_DIR_NAME = 'ConeCode Projects';
const MAX_REPAIR_ATTEMPTS = 3;

export type AutopilotPhase = 'idle' | 'creating' | 'building' | 'verifying' | 'repairing' | 'done' | 'failed';

interface AutopilotStore {
  ideas: ProjectIdea[];
  loadingIdeas: boolean;
  /** True while the cards are the built-in list rather than a live suggestion. */
  usingFallback: boolean;
  /**
   * Which model produced the current ideas ("provider:model"), or null when
   * they are the built-in fallbacks. Models load asynchronously at startup, so
   * without this the fallback list cached on the first render would never be
   * replaced once the user's model actually arrived.
   */
  ideasModelKey: string | null;

  phase: AutopilotPhase;
  running: ProjectIdea | null;
  projectDir: string | null;
  attempt: number;
  verifyCommand: string | null;
  lastOutput: string;
  error: string | null;

  loadIdeas: (providerId?: string, modelId?: string, force?: boolean) => Promise<void>;
  run: (idea: ProjectIdea, providerId: string, modelId: string) => Promise<void>;
  reset: () => void;
}

export const useAutopilotStore = create<AutopilotStore>((set, get) => ({
  ideas: [],
  loadingIdeas: false,
  usingFallback: false,
  ideasModelKey: null,
  phase: 'idle',
  running: null,
  projectDir: null,
  attempt: 0,
  verifyCommand: null,
  lastOutput: '',
  error: null,

  reset: () =>
    set({ phase: 'idle', running: null, projectDir: null, attempt: 0, verifyCommand: null, lastOutput: '', error: null }),

  /**
   * Ask the model what is worth building right now. Falls back to the built-in
   * list on any failure so the screen is never empty and never blocks on a
   * provider being configured.
   */
  loadIdeas: async (providerId, modelId, force = false) => {
    if (get().loadingIdeas) return;

    const key = providerId && modelId ? `${providerId}:${modelId}` : null;
    // Ask the user's model whenever we have one and the shown ideas did not come
    // from it — that covers the startup race and switching models later.
    const stale = key !== get().ideasModelKey;
    if (!force && get().ideas.length && !stale) return;

    const showFallback = () =>
      set({
        ideas: FALLBACK_IDEAS.map((i) => ({ ...i, id: uuidv4() })),
        usingFallback: true,
        loadingIdeas: false,
        ideasModelKey: null,
      });

    if (!key) return showFallback();

    set({ loadingIdeas: true });
    try {
      const result = await window.electronAPI.chat.stream({
        providerId: providerId!,
        modelId: modelId!,
        silent: true,
        maxTokens: 1200,
        messages: [
          { role: 'system', content: IDEAS_SYSTEM_PROMPT },
          { role: 'user', content: 'Suggest 6 projects to build right now.' },
        ],
      });
      const ideas = parseIdeas(extractText(result), uuidv4);
      if (!ideas.length) return showFallback();
      set({ ideas, usingFallback: false, loadingIdeas: false, ideasModelKey: key });
    } catch {
      showFallback();
    }
  },

  run: async (idea, providerId, modelId) => {
    if (get().phase !== 'idle' && get().phase !== 'done' && get().phase !== 'failed') return;

    const chat = useChatStore.getState();
    const settings = useSettingsStore.getState();
    const workspace = useWorkspaceStore.getState();
    // Unattended means unattended: approvals would stall the run at the first
    // edit. Restored in the finally below, whatever happens.
    const previousApproval = settings.approvalMode;

    set({ phase: 'creating', running: idea, attempt: 0, error: null, lastOutput: '', verifyCommand: null });

    try {
      const dir = await createProjectDir(idea.title);
      if (!dir) {
        set({ phase: 'failed', error: 'could-not-create-folder' });
        return;
      }
      set({ projectDir: dir });

      // A fresh conversation bound to the new folder, so the run is self-contained
      // and resumable later from the home screen.
      await chat.createConversation(providerId, modelId);
      await workspace.openFolderPath(dir);
      await chat.setConversationFolder(dir);
      await useChatStore.getState().renameConversation(
        useChatStore.getState().activeConversationId!,
        idea.title,
      );

      useSettingsStore.setState({ approvalMode: 'fullAuto' });

      set({ phase: 'building' });
      await useChatStore.getState().sendMessage(buildAutopilotPrompt(idea, dir), providerId, modelId);

      // --- verification loop -------------------------------------------------
      for (let attempt = 1; attempt <= MAX_REPAIR_ATTEMPTS; attempt++) {
        set({ phase: 'verifying', attempt });

        const command = await resolveVerifyCommand(dir);
        if (!command) {
          set({ phase: 'failed', error: 'no-verify-command' });
          return;
        }
        set({ verifyCommand: command });

        const result = await window.electronAPI.exec.run(command, dir, {
          mode: settings.sandboxMode,
          allowNetwork: settings.sandboxAllowNetwork,
          extraWritableRoots: [dir],
        });
        const output = `${result.stdout || ''}\n${result.stderr || ''}`.trim();
        set({ lastOutput: output.slice(-4000) });

        if (result.success) {
          set({ phase: 'done' });
          return;
        }
        if (attempt === MAX_REPAIR_ATTEMPTS) break;

        // Hand the real failure back and let it fix its own work.
        set({ phase: 'repairing' });
        await useChatStore
          .getState()
          .sendMessage(buildRepairPrompt(command, output, attempt, MAX_REPAIR_ATTEMPTS), providerId, modelId);
      }

      set({ phase: 'failed', error: 'verification-failed' });
    } catch (e: any) {
      set({ phase: 'failed', error: e?.message || String(e) });
    } finally {
      useSettingsStore.setState({ approvalMode: previousApproval });
    }
  },
}));

/**
 * Create the project folder without asking: <home>/ConeCode Projects/<slug>,
 * de-duplicated so a second "CLI Tool" never lands on top of the first.
 */
async function createProjectDir(title: string): Promise<string | null> {
  const api = window.electronAPI;
  const info = await api.app.getSystemInfo().catch(() => null as any);
  const home = info?.homedir;
  if (!home) return null;

  const base = `${home}/${PROJECTS_DIR_NAME}`;
  if (!(await api.fs.createDir(base))) return null;

  // uniqueFolderName needs a synchronous predicate, so the existing siblings are
  // listed once up front rather than probed one at a time.
  const siblings = await api.fs.readDir(base).catch(() => []);
  const taken = new Set(siblings.map((s) => s.name));
  const name = uniqueFolderName(slugify(title), (n) => taken.has(n));

  const dir = `${base}/${name}`;
  return (await api.fs.createDir(dir)) ? dir : null;
}

/**
 * The command that proves the project works: what the agent declared, or failing
 * that, whatever the project layout implies.
 */
async function resolveVerifyCommand(dir: string): Promise<string | null> {
  const messages = useChatStore.getState().messages;
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m.role !== 'assistant' || m.isLocalNotice) continue;
    const declared = extractVerifyCommand(m.content);
    if (declared) return declared;
  }
  const files = await window.electronAPI.fs.glob({ pattern: '*', dir, maxResults: 200 }).catch(() => []);
  return guessVerifyCommand(files.map((f) => f.split('/').pop() || f));
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
