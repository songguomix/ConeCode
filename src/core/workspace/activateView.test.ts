import { beforeEach, describe, expect, it, vi } from 'vitest';

const states = vi.hoisted(() => ({ chat: {} as any, ui: {} as any, root: null as string | null }));
vi.mock('../../stores/chat.store', () => ({ useChatStore: { getState: () => states.chat } }));
vi.mock('../../stores/ui.store', () => ({ useUIStore: { getState: () => states.ui } }));
vi.mock('../../stores/workspace.store', () => ({ useWorkspaceStore: { getState: () => ({ rootPath: states.root }) } }));
vi.mock('../../stores/model.store', () => ({ useModelStore: { getState: () => ({ getSelectedModel: () => ({ providerId: 'p', id: 'm' }) }) } }));
import { activateWorkspaceView } from './activateView';

beforeEach(() => {
  states.root = '/project';
  states.ui = { setViewMode: vi.fn() };
  states.chat = {
    agentMode: 'standard', activeConversationId: null, conversations: [],
    setAgentMode: vi.fn(), setActiveConversation: vi.fn(async (id: string) => { states.chat.activeConversationId = id; }),
    newConversation: vi.fn(async (_provider: string, _model: string, rootPath: string | null) => {
      const id = `new-${states.chat.conversations.length}`;
      states.chat.conversations.push({ id, rootPath, agentMode: 'standard' });
      states.chat.activeConversationId = id;
    }), ensureWorkFolder: vi.fn(async () => {}),
  };
});

describe('shared Chat / Work / RSI destination navigation', () => {
  it('serializes repeated taps and creates only one empty Chat', async () => {
    await Promise.all([activateWorkspaceView('chat'), activateWorkspaceView('chat')]);
    expect(states.chat.newConversation).toHaveBeenCalledTimes(1);
    expect(states.chat.newConversation).toHaveBeenCalledWith('p', 'm', null);
  });
  it('restores a Work conversation without adopting Chat or RSI', async () => {
    states.chat.conversations = [{ id: 'chat', rootPath: null }, { id: 'rsi', agentMode: 'rsi', rootPath: '/project', rsi: { status: 'idle', runs: [] } }, { id: 'work', rootPath: '/project' }];
    states.chat.activeConversationId = 'chat';
    await activateWorkspaceView('work');
    expect(states.chat.setActiveConversation).toHaveBeenCalledWith('work');
    expect(states.chat.newConversation).not.toHaveBeenCalled();
  });
  it('uses the desktop folder flow when Work has no project', async () => {
    states.root = null;
    await activateWorkspaceView('work');
    expect(states.chat.ensureWorkFolder).toHaveBeenCalledOnce();
    expect(states.chat.newConversation).not.toHaveBeenCalled();
  });
  it('enters RSI through its existing mode and exits through the selected view', async () => {
    await activateWorkspaceView('rsi');
    expect(states.chat.setAgentMode).toHaveBeenCalledWith('rsi');
    states.chat.agentMode = 'rsi';
    await activateWorkspaceView('chat');
    expect(states.ui.setViewMode).toHaveBeenCalledWith('chat');
    expect(states.chat.setAgentMode).toHaveBeenLastCalledWith('standard');
  });
});
