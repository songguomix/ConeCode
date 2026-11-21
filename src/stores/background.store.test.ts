import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { BackgroundTaskRecord, Conversation } from '../types';
import { useBackgroundStore } from './background.store';
import { useChatStore } from './chat.store';

const update = vi.fn(async (_id: string, _patch: Partial<Conversation>) => undefined);
const { resumeBackgroundRun, setActiveConversation } = useChatStore.getState();
const makeConversation = (id: string, task: Partial<BackgroundTaskRecord> = {}): Conversation => ({
  id, title: 'Task', providerId: 'provider', modelId: 'model', createdAt: 1, updatedAt: 1,
  backgroundTask: { status: 'running', source: 'chat', startedAt: 1, finishedAt: null, unseen: false, promptId: `${id}-prompt`, ...task },
});

beforeEach(() => {
  vi.clearAllMocks();
  (globalThis as any).window = { electronAPI: { conversation: { update } } };
  useChatStore.setState({ conversations: [], streamingRuns: {}, activeConversationId: null, isStreaming: false, resumeBackgroundRun, setActiveConversation });
  useBackgroundStore.setState({ tasks: {} });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe('background task registry', () => {
  it('waits for startup and respects the saved retry time', async () => {
    vi.useFakeTimers();
    const resume = vi.spyOn(useChatStore.getState(), 'resumeBackgroundRun').mockImplementation(async (id) => {
      useChatStore.setState(({ conversations }) => ({
        conversations: conversations.map((conversation) => conversation.id === id
          ? { ...conversation, backgroundTask: { ...conversation.backgroundTask!, status: 'done' } }
          : conversation),
      }));
    });
    let ready!: () => void;
    const stop = useBackgroundStore.getState().init(new Promise<void>((resolve) => { ready = resolve; }));
    try {
      useChatStore.setState({ conversations: [makeConversation('pending')] });
      await vi.advanceTimersByTimeAsync(400);
      expect(resume).not.toHaveBeenCalled();
      useChatStore.setState({ conversations: [makeConversation('pending', { retryAt: Date.now() + 600 })] });
      ready();
      await vi.advanceTimersByTimeAsync(599);
      expect(resume).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      expect(resume.mock.calls.map(([id]) => id)).toEqual(['pending']);
    } finally {
      stop();
    }
  });

  it('does not rebuild or reschedule the registry for text and navigation updates', async () => {
    vi.useFakeTimers();
    const liveRun = { content: '', reasoningContent: '', status: 'thinking' as const, toolName: null, retry: null, streamedTokens: 0 };
    useChatStore.setState({
      conversations: [
        makeConversation('live'),
        makeConversation('finished', { status: 'done' }),
        makeConversation('retry', { retryAt: Date.now() + 1000 }),
      ],
      streamingRuns: { live: liveRun },
      isStreaming: true,
    });
    const stop = useBackgroundStore.getState().init();
    try {
      await vi.advanceTimersByTimeAsync(0);
      const tasks = useBackgroundStore.getState().tasks;
      const setTimer = vi.spyOn(globalThis, 'setTimeout');
      for (let i = 0; i < 100; i++) {
        useChatStore.setState({ streamingRuns: { live: { ...liveRun, content: String(i) } } });
      }
      useChatStore.setState({ activeConversationId: 'live' });
      expect(useBackgroundStore.getState().tasks).toBe(tasks);
      expect(setTimer).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });

  it('persists opening and dismissing a finished task', async () => {
    const conversation = makeConversation('finished', { status: 'done', unseen: true, finishedAt: 2 });
    useChatStore.setState({ conversations: [conversation] });
    const open = vi.spyOn(useChatStore.getState(), 'setActiveConversation').mockResolvedValue(undefined);
    const store = useBackgroundStore.getState();
    const stop = store.init();
    try {
      store.jump('missing');
      expect(open).not.toHaveBeenCalled();
      store.jump('finished');
      expect(open).toHaveBeenCalledExactlyOnceWith('finished');
      expect(useBackgroundStore.getState().tasks.finished.unseen).toBe(false);
      expect(update).toHaveBeenCalledWith('finished', { backgroundTask: expect.objectContaining({ unseen: false }) });

      store.remove('finished');
      expect(useBackgroundStore.getState().tasks.finished).toBeUndefined();
      expect(update).toHaveBeenLastCalledWith('finished', { backgroundTask: expect.objectContaining({ status: 'done', dismissed: true, unseen: false }) });
    } finally {
      stop();
    }
  });

  it('dismisses a task queued for retry without restarting it', async () => {
    vi.useFakeTimers();
    useChatStore.setState({ conversations: [makeConversation('later', { retryAt: Date.now() + 1000 })] });
    const resume = vi.spyOn(useChatStore.getState(), 'resumeBackgroundRun').mockResolvedValue(undefined);
    const store = useBackgroundStore.getState();
    const stop = store.init();
    try {
      await vi.advanceTimersByTimeAsync(1);
      store.remove('later');
      expect(useBackgroundStore.getState().tasks.later).toBeUndefined();
      expect(update).toHaveBeenCalledWith('later', { backgroundTask: expect.objectContaining({ status: 'stopped', dismissed: true }) });
      await vi.advanceTimersByTimeAsync(1000);
      expect(resume).not.toHaveBeenCalled();
    } finally {
      stop();
    }
  });
});
