import { describe, expect, it, vi } from 'vitest';

describe('project brief with an open folder', () => {
  it('reads the project before asking the model and embeds the snapshot', async () => {
    const stream = vi.fn(async (_request: { messages: Array<{ role: string; content: string }> }) => ({
      choices: [
        {
          message: {
            content: JSON.stringify({ title: 'Dark mode', prompt: 'Read src/theme.ts first, then add dark mode.' }),
          },
        },
      ],
    }));
    (globalThis as any).window = {
      electronAPI: {
        fs: {
          readDir: async (dirPath: string) =>
            dirPath === '/proj'
              ? [
                  { name: 'src', isDirectory: true, path: '/proj/src' },
                  { name: 'package.json', path: '/proj/package.json' },
                  { name: 'README.md', path: '/proj/README.md' },
                ]
              : dirPath === '/proj/src'
                ? [{ name: 'theme.ts', path: '/proj/src/theme.ts' }]
                : [],
          readFile: async (filePath: string) =>
            filePath.endsWith('package.json')
              ? JSON.stringify({ dependencies: { react: '^18.0.0' } })
              : '# Widgets',
        },
        chat: { stream },
      },
    };

    const { useWorkspaceStore } = await import('./workspace.store');
    const { useProjectBriefStore } = await import('./projectBrief.store');
    useWorkspaceStore.setState({ rootPath: '/proj' });
    useProjectBriefStore.getState().setIdea('Add a dark mode toggle');
    await useProjectBriefStore.getState().generate('provider', 'model', 'en');

    expect(stream).toHaveBeenCalledTimes(1);
    const request = stream.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(request.messages[0].content).toContain('Existing project mode');
    expect(request.messages[0].content).toContain('read first');
    const user = request.messages[1].content;
    expect(user).toContain('## Existing project snapshot');
    expect(user).toContain('package.json');
    expect(user).toContain('src/theme.ts');
    expect(user.indexOf('Existing project snapshot')).toBeLessThan(user.indexOf('## Requested change'));
    expect(user).toContain('Add a dark mode toggle');

    const state = useProjectBriefStore.getState();
    expect(state.brief?.title).toBe('Dark mode');
    expect(state.projectContext?.fileCount).toBeGreaterThan(0);
    expect(state.projectReadError).toBe(false);
  });

  it('keeps the new-project prompt when no folder is open', async () => {
    const stream = vi.fn(async (_request: { messages: Array<{ role: string; content: string }> }) => ({
      choices: [{ message: { content: JSON.stringify({ title: 'New', prompt: 'Build it.' }) } }],
    }));
    (globalThis as any).window = { electronAPI: { chat: { stream }, fs: { readDir: vi.fn(), readFile: vi.fn() } } };
    const { useWorkspaceStore } = await import('./workspace.store');
    const { useProjectBriefStore } = await import('./projectBrief.store');
    useWorkspaceStore.setState({ rootPath: null });
    useProjectBriefStore.getState().setIdea('A brand new idea');
    await useProjectBriefStore.getState().generate('provider', 'model', 'en');

    const request = stream.mock.calls[0][0] as { messages: Array<{ role: string; content: string }> };
    expect(request.messages[0].content).not.toContain('Existing project mode');
    expect(request.messages[1].content).toBe('A brand new idea');
  });
});
