import { create } from 'zustand';

// Preserve write order when several controls are changed quickly. IPC calls can
// finish out of order; serializing snapshots prevents an older settings object
// from overwriting the user's newest choice on disk.
let settingsSaveQueue: Promise<unknown> = Promise.resolve();

// Codex-style tiered approval:
//  - suggest:  ask before every edit and command (safest, default)
//  - autoEdit: auto-apply file edits/renames/copies; still ask before exec/delete
//  - fullAuto: auto-apply everything, including commands (risky)
export type ApprovalMode = 'suggest' | 'autoEdit' | 'fullAuto';

// How the agent asks for tools:
//  - auto:   native function calling when the model advertises it (default)
//  - native: always send tool schemas — for endpoints whose /models list
//            under-reports capabilities (local llama.cpp, vLLM, proxies)
//  - prompt: never send them; use the ```json protocol in the system prompt
export type ToolCallMode = 'auto' | 'native' | 'prompt';

// How agent-run commands are confined:
//  - workspaceWrite: reads anywhere, writes only in the workspace + scratch
//                    (macOS seatbelt; unavailable elsewhere)
//  - off:            commands run with the user's full authority
export type SandboxMode = 'off' | 'workspaceWrite';
export type NotificationMode = 'never' | 'background' | 'always';

interface Settings {
  theme: 'light' | 'dark' | 'system';
  language: string;
  sendWithEnter: boolean;
  streamEnabled: boolean;
  defaultProviderId: string | null;
  defaultModelId: string | null;
  autoIncludeFileContext: boolean;
  maxContextFileSize: number;
  approvalMode: ApprovalMode;
  toolCallMode: ToolCallMode;
  sandboxMode: SandboxMode;
  notificationMode: NotificationMode;
  notifyApprovals: boolean;
  preventSleepWhileRunning: boolean;
  /**
   * The user has acknowledged that a custom skill is unreviewed instructions the
   * agent will follow, and that they own the outcome. Asked once, then remembered.
   */
  customSkillsAcknowledged: boolean;
  /** Commands may reach the network. On by default: installs/tests need it. */
  sandboxAllowNetwork: boolean;
}

interface SettingsStore extends Settings {
  updateSettings: (partial: Partial<Settings>) => void;
  loadSettings: () => Promise<void>;
  saveSettings: () => Promise<void>;
}

export const useSettingsStore = create<SettingsStore>((set, get) => ({
  theme: 'dark',
  language: 'en',
  sendWithEnter: true,
  streamEnabled: true,
  defaultProviderId: null,
  defaultModelId: null,
  autoIncludeFileContext: true,
  maxContextFileSize: 10000,
  approvalMode: 'suggest',
  toolCallMode: 'auto',
  sandboxMode: 'workspaceWrite',
  notificationMode: 'background',
  notifyApprovals: true,
  preventSleepWhileRunning: true,
  customSkillsAcknowledged: false,
  sandboxAllowNetwork: true,

  updateSettings: (partial) => {
    set(partial);
    void get().saveSettings().catch(() => {});
  },

  loadSettings: async () => {
    try {
      const settings = await window.electronAPI.settings.get();
      if (settings) {
        // Merge with defaults to ensure new fields have values. Migrate the old
        // boolean autoApprove → fullAuto / suggest.
        set((state) => ({
          ...state,
          ...settings,
          autoIncludeFileContext: settings.autoIncludeFileContext ?? true,
          maxContextFileSize: settings.maxContextFileSize ?? 10000,
          approvalMode: settings.approvalMode ?? (settings.autoApprove ? 'fullAuto' : 'suggest'),
          toolCallMode: settings.toolCallMode ?? 'auto',
          sandboxMode: settings.sandboxMode ?? 'workspaceWrite',
          notificationMode: settings.notificationMode ?? 'background',
          notifyApprovals: settings.notifyApprovals ?? true,
          preventSleepWhileRunning: settings.preventSleepWhileRunning ?? true,
          customSkillsAcknowledged: settings.customSkillsAcknowledged ?? false,
          sandboxAllowNetwork: settings.sandboxAllowNetwork ?? true,
        }));
      }
    } catch {}
  },

  saveSettings: async () => {
    const { theme, language, sendWithEnter, streamEnabled, defaultProviderId, defaultModelId, autoIncludeFileContext, maxContextFileSize, approvalMode, toolCallMode, sandboxMode, notificationMode, notifyApprovals, preventSleepWhileRunning, sandboxAllowNetwork, customSkillsAcknowledged } = get();
    const snapshot = { theme, language, sendWithEnter, streamEnabled, defaultProviderId, defaultModelId, autoIncludeFileContext, maxContextFileSize, approvalMode, toolCallMode, sandboxMode, notificationMode, notifyApprovals, preventSleepWhileRunning, sandboxAllowNetwork, customSkillsAcknowledged };
    const save = settingsSaveQueue.then(() => window.electronAPI.settings.update(snapshot));
    // Keep the queue alive after a failed write while still rejecting this call
    // to any explicit caller that wants to surface the error.
    settingsSaveQueue = save.catch(() => undefined);
    await save;
  },
}));
