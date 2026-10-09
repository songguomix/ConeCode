import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBackgroundStore } from './background.store';
import { useChatStore } from './chat.store';

const show = vi.fn(async () => true);

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  (globalThis as any).window = {
    electronAPI: {
      notification: { show },
      conversation: { create: vi.fn(), list: vi.fn(async () => []), update: vi.fn() },
      message: { create: vi.fn(), list: vi.fn(async () => []) },
      chat: { onChunk: vi.fn(() => () => {}), stream: vi.fn(), stop: vi.fn() },
    },
  };
  useBackgroundStore.setState({ tasks: {} });
  useChatStore.setState({ streamingRuns: {}, conversations: [], activeConversationId: null });
});

function running(id = 'c1', startedAt = Date.now()) {
  const prev = useBackgroundStore.getState().tasks;
  useBackgroundStore.setState({
    tasks: {
      ...prev,
      [id]: {
        conversationId: id,
        title: 'task',
        status: 'running',
        observed: false,
        startedAt,
        finishedAt: null,
        unseen: false,
        source: 'chat',
      },
    },
  });
}

describe('background task lifecycle', () => {
  it('observes a live run without finishing it', () => {
    running();
    useChatStore.setState({ streamingRuns: { c1: { content: '', reasoningContent: '', status: 'thinking', toolName: null } } as any });
    useBackgroundStore.getState().sync();
    const task = useBackgroundStore.getState().tasks.c1;
    expect(task.status).toBe('running');
    expect(task.observed).toBe(true);
    expect(show).not.toHaveBeenCalled();
  });

  it('marks done + notifies once when the run disappears', () => {
    running();
    useChatStore.setState({ streamingRuns: { c1: {} } as any });
    useBackgroundStore.getState().sync();
    useChatStore.setState({ streamingRuns: {} });
    useBackgroundStore.getState().sync();
    const task = useBackgroundStore.getState().tasks.c1;
    expect(task.status).toBe('done');
    expect(task.unseen).toBe(true);
    expect(task.finishedAt).toBeTypeOf('number');
    expect(show).toHaveBeenCalledTimes(1);
    // Repeat syncs never re-notify.
    useBackgroundStore.getState().sync();
    expect(show).toHaveBeenCalledTimes(1);
  });

  it('keeps a never-observed fresh run, expires a stale one', () => {
    running('fresh', Date.now());
    running('stale', Date.now() - 60_000);
    useBackgroundStore.getState().sync();
    expect(useBackgroundStore.getState().tasks.fresh.status).toBe('running');
    expect(useBackgroundStore.getState().tasks.stale.status).toBe('done');
  });

  it('markSeen clears the badge; remove drops the task', () => {
    running();
    useChatStore.setState({ streamingRuns: { c1: {} } as any });
    useBackgroundStore.getState().sync();
    useChatStore.setState({ streamingRuns: {} });
    useBackgroundStore.getState().sync();
    useBackgroundStore.getState().markSeen('c1');
    expect(useBackgroundStore.getState().tasks.c1.unseen).toBe(false);
    useBackgroundStore.getState().remove('c1');
    expect(useBackgroundStore.getState().tasks.c1).toBeUndefined();
  });

  it('jump marks seen even when the conversation cannot open', () => {
    running();
    useBackgroundStore.getState().jump('missing');
    expect(useBackgroundStore.getState().tasks.missing).toBeUndefined();
    useBackgroundStore.getState().register('c1', 'task');
    useChatStore.setState({ streamingRuns: { c1: {} } as any });
    useBackgroundStore.getState().sync();
    useChatStore.setState({ streamingRuns: {} });
    useBackgroundStore.getState().sync();
    // 'c1' is not in conversations, so setActiveConversation no-ops — but the
    // badge must still clear without throwing.
    useBackgroundStore.getState().jump('c1');
    expect(useBackgroundStore.getState().tasks.c1.unseen).toBe(false);
  });
});
