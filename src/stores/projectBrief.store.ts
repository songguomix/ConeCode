import { create } from 'zustand';
import {
  BRIEF_CEILING_OUTPUT_TOKENS, BRIEF_FLOOR_OUTPUT_TOKENS, PROJECT_BRIEF_SYSTEM_PROMPT,
  briefFinishReason, briefHasText, briefMaxTokens, parseProjectBrief, projectExecutionPrompt,
  type ProjectBrief,
} from '../core/agenda/projectBrief';
import { createProjectDir } from './autopilot.store';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';
import { usePromptStore } from './prompt.store';

let generation = 0;

/** Turn a provider/stream failure into a message the user can act on. */
function briefErrorKey(error: any): string {
  const code = String(error?.message || error || '');
  if (code === 'EMPTY_TRUNCATED') return 'briefErrorTruncated';
  if (code === 'EMPTY_REPLY') return 'briefErrorEmpty';
  if (/Incomplete model stream|No response body/i.test(code)) return 'briefErrorInterrupted';
  if (/timed out|timeout/i.test(code)) return 'briefErrorTimeout';
  if (/401|invalid api key|unauthorized/i.test(code)) return 'briefErrorAuth';
  if (/429|rate limit|quota/i.test(code)) return 'briefErrorRate';
  if (/404|model not found/i.test(code)) return 'briefErrorModel';
  return 'briefGenerateFailed';
}

interface ProjectBriefStore {
  idea: string;
  brief: ProjectBrief | null;
  prompt: string;
  generating: boolean;
  starting: boolean;
  error: string | null;
  /** Raw failure text, shown under the friendly message so it is diagnosable. */
  errorDetail: string | null;
  directory: string | null;
  setIdea: (idea: string) => void;
  setPrompt: (prompt: string) => void;
  cancel: () => void;
  generate: (providerId: string, modelId: string, locale: string) => Promise<void>;
  start: (providerId: string, modelId: string) => Promise<void>;
}

export const useProjectBriefStore = create<ProjectBriefStore>((set, get) => ({
  idea: '', brief: null, prompt: '', generating: false, starting: false, error: null, errorDetail: null, directory: null,
  setIdea: (idea) => {
    if (get().starting) return;
    generation++;
    set({ idea, brief: null, prompt: '', generating: false, error: null, errorDetail: null });
  },
  setPrompt: (prompt) => { if (!get().starting) set({ prompt }); },
  cancel: () => { generation++; set({ generating: false }); },
  generate: async (providerId, modelId, locale) => {
    const idea = get().idea.trim();
    if (!idea || !providerId || !modelId || get().generating || get().starting) return;
    const request = ++generation;
    set({ generating: true, error: null, errorDetail: null });
    try {
      let model: { maxOutputTokens?: number } | null = null;
      try {
        const { useModelStore } = await import('./model.store');
        model = useModelStore.getState().models.get(providerId)?.find((x) => x.id === modelId) || null;
      } catch {}
      // Reasoning models spend output tokens thinking before they answer. A
      // fixed 4096 cap let DeepSeek Flash burn the whole budget mid-thought and
      // return nothing, which surfaced as the misleading "check your model
      // connection" message. Size the budget from the model itself.
      let maxTokens = briefMaxTokens(model);
      const call = (tokens: number) => window.electronAPI.chat.stream({
        providerId, modelId, silent: true, maxTokens: tokens,
        messages: [
          { role: 'system', content: `${usePromptStore.getState().getPrompt('project_brief')}\nWrite the title and prompt in ${locale === 'zh' ? 'Simplified Chinese' : locale === 'zhHant' ? 'Traditional Chinese' : locale === 'ja' ? 'Japanese' : 'English'}, unless the user explicitly requests another language.` },
          { role: 'user', content: idea },
        ],
      });
      let result = await call(maxTokens);
      if (request !== generation) return;
      let finishReason = briefFinishReason(result);
      // A truncated reply or an empty one is usually the reasoning budget
      // running out, not a dead connection: climb towards the ceiling before
      // giving up, then keep whatever usable text came back.
      for (let retry = 0; retry < 2; retry++) {
        if (finishReason !== 'length' && briefHasText(result)) break;
        if (maxTokens >= BRIEF_CEILING_OUTPUT_TOKENS) break;
        maxTokens = Math.min(Math.max(maxTokens * 2, BRIEF_FLOOR_OUTPUT_TOKENS), BRIEF_CEILING_OUTPUT_TOKENS);
        result = await call(maxTokens);
        if (request !== generation) return;
        finishReason = briefFinishReason(result);
      }
      // parseProjectBrief never throws on non-empty output: even a non-JSON
      // reply becomes an editable prompt, so step 2 always has something to
      // review before step 3 starts the work.
      const brief = parseProjectBrief(result, { finishReason });
      set({ brief, prompt: brief.prompt, generating: false });
    } catch (e: any) {
      // Keep the i18n key (the UI renders t(error)) but log the real cause —
      // previously every failure (timeout, 401, empty reply) collapsed into one
      // opaque key with nothing in the console to diagnose.
      console.warn('[brief] generate failed:', e?.message || String(e));
      if (request === generation) {
        set({
          generating: false,
          error: briefErrorKey(e),
          errorDetail: String(e?.message || e || '').slice(0, 500) || null,
        });
      }
    }
  },
  start: async (providerId, modelId) => {
    const { brief, prompt, generating, starting } = get();
    if (!brief || !prompt.trim() || !providerId || !modelId || generating || starting) return;
    const initialConversation = useChatStore.getState().activeConversationId;
    const checkConversation = (id: string | null) => {
      if (useChatStore.getState().activeConversationId !== id) throw new Error('briefConversationChanged');
    };
    set({ starting: true, error: null, directory: null });
    try {
      // If a folder is already open, continue in it ("顺下来") instead of
      // forcing a new one. Only create ~/ConeCode Projects/<slug> when there
      // is nothing open — describing an idea never requires opening a folder.
      const existing = useWorkspaceStore.getState().rootPath;
      const isNewDir = !existing;
      const directory = existing ?? await createProjectDir(brief.title);
      if (!directory) throw new Error('briefFolderFailed');
      set({ directory });
      checkConversation(initialConversation);
      const chat = useChatStore.getState();
      const id = await chat.createConversation(providerId, modelId);
      checkConversation(id);
      if (isNewDir) {
        if (!await useWorkspaceStore.getState().openFolderPath(directory)) throw new Error('briefFolderFailed');
        checkConversation(id);
      }
      await chat.setConversationFolder(directory);
      checkConversation(id);
      await chat.renameConversation(id, brief.title);
      checkConversation(id);
      await chat.sendMessage(projectExecutionPrompt(prompt, directory, isNewDir), providerId, modelId);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      set({ error: ['briefFolderFailed', 'briefConversationChanged'].includes(code) ? code : 'briefStartFailed' });
    } finally {
      set({ starting: false });
    }
  },
}));
