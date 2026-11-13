import { useChatStore } from '../../stores/chat.store';
import { useUIStore } from '../../stores/ui.store';
import { useModelStore } from '../../stores/model.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { isChatConversation, isWorkConversation } from './conversations';

export type WorkspaceView = 'chat' | 'work' | 'rsi';
let navigation: Promise<void> = Promise.resolve();

/** Sidebar and phone share one hand-off, so entering a view never creates duplicate blank chats. */
export function activateWorkspaceView(view: WorkspaceView): Promise<void> {
  const next = navigation.catch(() => undefined).then(async () => {
    const chat = useChatStore.getState();
    if (view === 'rsi') { chat.setAgentMode('rsi'); return; }
    useUIStore.getState().setViewMode(view);
    if (chat.agentMode === 'rsi') { chat.setAgentMode('standard'); return; }
    const matches = view === 'chat' ? isChatConversation : isWorkConversation;
    const current = chat.conversations.find((c) => c.id === chat.activeConversationId);
    if (current && matches(current)) return;
    const existing = chat.conversations.find(matches);
    if (existing) { await chat.setActiveConversation(existing.id); return; }
    const model = useModelStore.getState().getSelectedModel();
    const root = useWorkspaceStore.getState().rootPath;
    if (view === 'work' && !root) { await chat.ensureWorkFolder(); return; }
    await chat.newConversation(model?.providerId || '', model?.id || '', view === 'chat' ? null : root);
  });
  navigation = next;
  return next;
}
