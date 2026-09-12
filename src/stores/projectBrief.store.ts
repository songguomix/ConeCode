import { create } from 'zustand';
import { PROJECT_BRIEF_SYSTEM_PROMPT, parseProjectBrief, projectExecutionPrompt, type ProjectBrief } from '../core/agenda/projectBrief';
import { createProjectDir } from './autopilot.store';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';

let generation = 0;
interface ProjectBriefStore {
  idea: string;
  brief: ProjectBrief | null;
  prompt: string;
  generating: boolean;
  starting: boolean;
  error: string | null;
  directory: string | null;
  setIdea: (idea: string) => void;
  setPrompt: (prompt: string) => void;
  cancel: () => void;
  generate: (providerId: string, modelId: string, locale: string) => Promise<void>;
  start: (providerId: string, modelId: string) => Promise<void>;
}

export const useProjectBriefStore = create<ProjectBriefStore>((set, get) => ({
  idea: '', brief: null, prompt: '', generating: false, starting: false, error: null, directory: null,
  setIdea: (idea) => {
    if (get().starting) return;
    generation++;
    set({ idea, brief: null, prompt: '', generating: false, error: null });
  },
  setPrompt: (prompt) => { if (!get().starting) set({ prompt }); },
  cancel: () => { generation++; set({ generating: false }); },
  generate: async (providerId, modelId, locale) => {
    const idea = get().idea.trim();
    if (!idea || !providerId || !modelId || get().generating || get().starting) return;
    const request = ++generation;
    set({ generating: true, error: null });
    try {
      const result = await window.electronAPI.chat.stream({
        providerId, modelId, silent: true, maxTokens: 4096,
        messages: [
          { role: 'system', content: `${PROJECT_BRIEF_SYSTEM_PROMPT}\nWrite the title and prompt in ${locale === 'zh' ? 'Simplified Chinese' : locale === 'ja' ? 'Japanese' : 'English'}, unless the user explicitly requests another language.` },
          { role: 'user', content: idea },
        ],
      });
      if (request !== generation) return;
      const brief = parseProjectBrief(result);
      set({ brief, prompt: brief.prompt, generating: false });
    } catch {
      if (request === generation) set({ generating: false, error: 'briefGenerateFailed' });
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
      const directory = await createProjectDir(brief.title);
      if (!directory) throw new Error('briefFolderFailed');
      set({ directory });
      checkConversation(initialConversation);
      const chat = useChatStore.getState();
      const id = await chat.createConversation(providerId, modelId);
      checkConversation(id);
      if (!await useWorkspaceStore.getState().openFolderPath(directory)) throw new Error('briefFolderFailed');
      checkConversation(id);
      await chat.setConversationFolder(directory);
      checkConversation(id);
      await chat.renameConversation(id, brief.title);
      checkConversation(id);
      await chat.sendMessage(projectExecutionPrompt(prompt, directory), providerId, modelId);
    } catch (error) {
      const code = error instanceof Error ? error.message : '';
      set({ error: ['briefFolderFailed', 'briefConversationChanged'].includes(code) ? code : 'briefStartFailed' });
    } finally {
      set({ starting: false });
    }
  },
}));
