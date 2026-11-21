import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../stores/theme.store', () => ({ useThemeStore: vi.fn() }));
vi.mock('../../stores', async (importOriginal) => {
  const stores = await importOriginal<typeof import('../../stores')>();
  return {
    ...stores,
    useChatStore: Object.assign((select: (s: ReturnType<typeof stores.useChatStore.getState>) => unknown) =>
      select(stores.useChatStore.getState()), stores.useChatStore),
    useUIStore: Object.assign((select: (s: ReturnType<typeof stores.useUIStore.getState>) => unknown) =>
      select(stores.useUIStore.getState()), stores.useUIStore),
  };
});

import Sidebar from './Sidebar';
import { useChatStore, useUIStore } from '../../stores';
import type { BackgroundTaskRecord, Conversation } from '../../types';

const chat: Conversation = {
  id: 'chat', title: 'Regular Chat conversation', providerId: 'provider', modelId: 'model',
  rootPath: null, isChatMode: true, createdAt: 1, updatedAt: 1,
};
const work: Conversation = {
  ...chat, id: 'work', title: 'Regular Work conversation', rootPath: '/project', isChatMode: false,
};
const backgroundTask: BackgroundTaskRecord = {
  status: 'running', source: 'chat', startedAt: 1, promptId: 'prompt', finishedAt: null, unseen: false,
};

describe('sidebar background tasks', () => {
  beforeEach(() => {
    useChatStore.setState({
      agentMode: 'standard',
      conversations: [
        chat, work,
        { ...chat, id: 'bg-chat', title: 'Detached Chat task', backgroundTask },
        { ...work, id: 'bg-work', title: 'Detached Work task', backgroundTask },
        { ...chat, id: 'bg-archive', title: 'Archived background task', archivedAt: 2, backgroundTask },
        { ...chat, id: 'bg-dismissed', title: 'Dismissed task', backgroundTask: { ...backgroundTask, dismissed: true } },
      ],
    });
  });

  it.each([
    ['chat', chat.title],
    ['work', work.title],
  ] as const)('keeps detached tasks out of the %s history and archive', (viewMode, title) => {
    useUIStore.setState({ viewMode });

    const html = renderToStaticMarkup(<Sidebar />);

    expect(html).toContain(title);
    expect(html).not.toContain('Detached Chat task');
    expect(html).not.toContain('Detached Work task');
    expect(html).not.toContain('Dismissed task');
    expect(html).not.toContain('sidebar-conversation-archive');
  });
});
