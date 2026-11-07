import { beforeEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';

vi.mock('../../stores/theme.store', () => ({ useThemeStore: vi.fn() }));
vi.mock('../../stores', async (importOriginal) => {
  const stores = await importOriginal<typeof import('../../stores')>();
  const snapshot = (store: any) => Object.assign(
    (selector?: any) => selector ? selector(store.getState()) : store.getState(),
    store,
  );
  return {
    ...stores,
    useAutopilotStore: snapshot(stores.useAutopilotStore),
    useLanguageStore: snapshot(stores.useLanguageStore),
    useModelStore: snapshot(stores.useModelStore),
    useWorkspaceStore: snapshot(stores.useWorkspaceStore),
  };
});

import ProjectIdeas from './ProjectIdeas';
import { useAutopilotStore, useLanguageStore } from '../../stores';
import type { ProjectIdea } from '../../core/agenda/newProject';

const idea = (overrides: Partial<ProjectIdea> = {}): ProjectIdea => ({
  id: 'idea-1',
  title: 'MCP Server',
  description: 'A long explanation that should not be rendered.',
  stack: 'TypeScript',
  scale: 'small',
  tags: [],
  ...overrides,
});

beforeEach(() => {
  useLanguageStore.getState().setLocale('en');
  useAutopilotStore.setState({
    ideas: [],
    loadingIdeas: false,
    phase: 'idle',
    running: null,
    projectDir: null,
    attempt: 0,
    verifyCommand: null,
    lastOutput: '',
    error: null,
  });
});

describe('ProjectIdeas', () => {
  it('waits for the user instead of generating ideas on its own', () => {
    const markup = renderToStaticMarkup(<ProjectIdeas onCompose={() => {}} />);
    expect(markup).toContain('AI ideas');
    expect(markup).toContain('Write my own');
    expect(markup).not.toContain('anim-shimmer');
    expect(markup).not.toContain('Other ideas');
  });

  it('renders compact idea cards without the descriptive paragraph', () => {
    useAutopilotStore.setState({ ideas: [idea()] });
    const markup = renderToStaticMarkup(<ProjectIdeas />);
    expect(markup).toContain('MCP Server');
    expect(markup).toContain('TypeScript');
    expect(markup).not.toContain('A long explanation');
    expect(markup).toContain('Other ideas');
  });
});
