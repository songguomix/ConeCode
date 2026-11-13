import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../stores/theme.store', () => ({ useThemeStore: vi.fn() }));
vi.mock('../model/ModelSelector', () => ({ default: () => null }));
vi.mock('../../stores', async (importOriginal) => {
  const stores = await importOriginal<typeof import('../../stores')>();
  // SSR uses Zustand's initial snapshot. Read the arranged state directly so
  // these render regressions exercise each real selector without a browser.
  const snapshot = (store: any) => Object.assign((selector?: any) => selector ? selector(store.getState()) : store.getState(), store);
  return { ...stores, useChatStore: snapshot(stores.useChatStore), useWorkspaceStore: snapshot(stores.useWorkspaceStore), useLanguageStore: snapshot(stores.useLanguageStore) };
});
vi.mock('../../stores/installGate.store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../stores/installGate.store')>();
  return { ...actual, useInstallGateStore: Object.assign((selector: any) => selector(actual.useInstallGateStore.getState()), actual.useInstallGateStore) };
});

import ChatInput from './ChatInput';
import MessageBubble from './MessageBubble';
import QuestionPromptCard from './QuestionPromptCard';
import { useChatStore, useLanguageStore, useWorkspaceStore } from '../../stores';
import { useInstallGateStore } from '../../stores/installGate.store';
import type { Message } from '../../types';

beforeEach(() => {
  useLanguageStore.getState().setLocale('en');
  useWorkspaceStore.setState({ contextFiles: [], selectedFile: null });
  useChatStore.setState({ activeConversationId: 'test', streamingRuns: {}, messageEdits: {}, messages: [], queuedMessages: {} });
  useInstallGateStore.getState().reset();
});

describe('question replies', () => {
  const question: Message = { id: 'question', conversationId: 'test', role: 'assistant', content: 'Continue?', createdAt: 0, isQuestion: true, questionOptions: ['Proceed'] };

  it('keeps historical questions answered after a later user reply', () => {
    useChatStore.setState({ messages: [question, { id: 'reply', conversationId: 'test', role: 'user', content: 'Proceed', createdAt: 1 }] });
    const markup = renderToStaticMarkup(<MessageBubble message={question} />);
    expect(markup).toContain('Answered');
    expect(markup).not.toMatch(/<button\b[^>]*>Proceed<\/button>/);
  });

  it('disables both question reply surfaces while a send would be held', () => {
    useChatStore.setState({ messages: [question] });
    useInstallGateStore.getState().begin('install', 'Dependencies');
    const bubble = renderToStaticMarkup(<MessageBubble message={question} />);
    const card = renderToStaticMarkup(<QuestionPromptCard message={question} />);
    expect(bubble).toMatch(/<button\b[^>]*disabled=""[^>]*>Proceed<\/button>/);
    expect(card).toMatch(/<button\b[^>]*disabled=""[^>]*><span>Proceed<\/span><\/button>/);
  });
});

function sendButton() {
  const markup = renderToStaticMarkup(<ChatInput />);
  const button = markup.match(/<button\b[^>]*aria-label="Send"[^>]*>/)?.[0];
  expect(button).toBeDefined();
  return button!;
}

describe('composer send availability', () => {
  it('allows an image-only message', () => {
    useWorkspaceStore.setState({ contextFiles: [{ path: 'pasted.png', content: '', isImage: true, dataUrl: 'data:image/png;base64,AAAA' }] });
    expect(sendButton()).not.toContain('disabled=""');
  });

  it('keeps an empty message or unloaded image disabled', () => {
    expect(sendButton()).toContain('disabled=""');
    useWorkspaceStore.setState({ contextFiles: [{ path: 'pending.png', content: '', isImage: true }] });
    expect(sendButton()).toContain('disabled=""');
  });

  it('holds image sends while installation is in progress', () => {
    useWorkspaceStore.setState({ contextFiles: [{ path: 'pasted.png', content: '', isImage: true, dataUrl: 'data:image/png;base64,AAAA' }] });
    useInstallGateStore.getState().begin('install', 'Dependencies');
    expect(sendButton()).toContain('disabled=""');
  });
});

it('renders the active conversation queue as an attached composer panel', () => {
  useChatStore.setState({
    streamingRuns: { test: { content: '', reasoningContent: '', status: 'thinking', toolName: null, retry: null } },
    queuedMessages: {
      test: [{ id: 'queued', content: 'Queued request', providerId: 'p1', modelId: 'm1', createdAt: 0, steer: false, steerError: null }],
      other: [{ id: 'other', content: 'Another conversation', providerId: 'p1', modelId: 'm1', createdAt: 0, steer: false, steerError: null }],
    },
  });
  const markup = renderToStaticMarkup(<ChatInput />);
  expect(markup).toMatch(/<section aria-label="Queued".*Queued request.*Steer.*aria-label="Remove queued message".*aria-label="Queued message details".*<div class="chat-composer/);
  expect(markup).not.toContain('Another conversation');
});
