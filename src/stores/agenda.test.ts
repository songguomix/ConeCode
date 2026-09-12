import { describe, it, expect, beforeEach } from 'vitest';
import { useAgendaStore } from './agenda.store';
import { useWorkspaceStore } from './workspace.store';
import { useChatStore } from './chat.store';
import { useCodeChangesStore } from './codeChanges.store';

let streamCalls: any[];
let queued: string[];

const suggestion = (titles: string[]) => JSON.stringify({
  tasks: titles.map((title) => ({
    title, rationale: 'from the scan', kind: 'bug', effort: 'quick', risk: 'low',
    files: ['src/a.ts'], prompt: `Do: ${title}`,
  })),
});

beforeEach(() => {
  streamCalls = [];
  queued = [];
  localStorage.clear();
  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => {
          streamCalls.push(params);
          return { choices: [{ message: { content: queued.shift() ?? '{"tasks":[]}' } }] };
        },
      },
      git: {
        info: async () => ({ isRepo: true, branch: 'main', dirty: 3 }),
        status: async () => 'M src/a.ts',
        diff: async () => '--- a\n+++ b',
      },
      fs: {
        search: async () => [{ file: '/proj/src/a.ts', line: 7, text: '// TODO: fix' }],
        glob: async () => ['/proj/src/a.ts', '/proj/src/a.test.ts', '/proj/main.py'],
        readFile: async (p: string) =>
          p.endsWith('package.json') ? '{"name":"demo","scripts":{"test":"vitest"}}' :
          p.endsWith('README.md') ? '# demo project' : null,
      },
      message: { list: async () => [] },
    },
  };
  useWorkspaceStore.setState({ rootPath: '/proj' });
  useChatStore.setState({ conversations: [], messages: [] });
  useCodeChangesStore.setState({ changes: [] });
  useAgendaStore.setState({ scan: null, tasks: [], generatedAt: null, error: null, resume: [], scanning: false, suggesting: false });
});

describe('workspace scan', () => {
  it('reads real project state without calling a model', async () => {
    const scan = await useAgendaStore.getState().scanWorkspace();

    expect(streamCalls).toHaveLength(0); // free: no provider involved
    expect(scan).toMatchObject({ projectName: 'demo', scripts: ['test'], hasTests: true });
    expect(scan!.git).toMatchObject({ branch: 'main', dirty: 3 });
    expect(scan!.languages).toContain('TypeScript');
    // Paths are relative so cards and prompts stay readable.
    expect(scan!.todoComments[0]).toMatchObject({ file: 'src/a.ts', line: 7 });
  });

  it('does nothing without an open folder', async () => {
    useWorkspaceStore.setState({ rootPath: null });
    expect(await useAgendaStore.getState().scanWorkspace()).toBeNull();
  });
});

describe('findWork', () => {
  it('scans, asks the model, and ranks what comes back', async () => {
    queued = [suggestion(['Fix A', 'Fix B'])];
    await useAgendaStore.getState().findWork('p1', 'm1');

    expect(streamCalls).toHaveLength(1);
    expect(streamCalls[0].silent, 'must not appear in the transcript').toBe(true);
    // The briefing has to carry the scanned facts, or proposals are guesses.
    const briefing = streamCalls[0].messages[1].content;
    expect(briefing).toContain('src/a.ts:7');
    expect(briefing).toContain('branch main');
    expect(useAgendaStore.getState().tasks.map((t) => t.title)).toEqual(['Fix A', 'Fix B']);
  });

  it('serves the cache on a second call instead of spending tokens again', async () => {
    queued = [suggestion(['Cached task'])];
    await useAgendaStore.getState().findWork('p1', 'm1');
    useAgendaStore.setState({ tasks: [], generatedAt: null });

    await useAgendaStore.getState().findWork('p1', 'm1');
    expect(streamCalls.filter((c) => c.messages?.length === 2)).toHaveLength(1); // still just one suggest call
    expect(useAgendaStore.getState().tasks.map((t) => t.title)).toEqual(['Cached task']);
  });

  it('re-asks when forced', async () => {
    queued = [suggestion(['First']), suggestion(['Second'])];
    await useAgendaStore.getState().findWork('p1', 'm1');
    await useAgendaStore.getState().findWork('p1', 'm1', true);
    expect(useAgendaStore.getState().tasks.map((t) => t.title)).toEqual(['Second']);
  });

  it('reports an empty result rather than showing nothing', async () => {
    queued = ['{"tasks":[]}'];
    await useAgendaStore.getState().findWork('p1', 'm1');
    expect(useAgendaStore.getState().error).toBe('empty');
    expect(useAgendaStore.getState().suggesting).toBe(false);
  });

  it('surfaces a provider failure without throwing', async () => {
    (globalThis as any).window.electronAPI.chat.stream = async () => { throw new Error('rate limited'); };
    await useAgendaStore.getState().findWork('p1', 'm1');
    expect(useAgendaStore.getState().error).toContain('rate limited');
    expect(useAgendaStore.getState().suggesting).toBe(false);
  });
});

describe('resume list', () => {
  it('reports what each conversation left unfinished', async () => {
    const todoMsg = '```json\n' + JSON.stringify({
      action: 'update_todos',
      todos: [{ content: 'wire up the parser', status: 'pending' }, { content: 'done bit', status: 'completed' }],
    }) + '\n```';
    (globalThis as any).window.electronAPI.message.list = async () => [
      { role: 'user', content: 'build the parser' },
      { role: 'assistant', content: todoMsg },
      { role: 'assistant', content: 'I added the tokenizer.' },
    ];
    useChatStore.setState({
      conversations: [{ id: 'c1', title: 'Parser work', providerId: 'p', modelId: 'm', rootPath: '/proj', createdAt: 0, updatedAt: 1000 }],
    });
    useCodeChangesStore.setState({
      changes: [{ id: 'ch', kind: 'edit', filePath: '/proj/src/a.ts', originalCode: '', newCode: '', description: '', status: 'pending', createdAt: 0, conversationId: 'c1' }],
    });

    await useAgendaStore.getState().loadResume();

    const [candidate] = useAgendaStore.getState().resume;
    expect(candidate).toMatchObject({ conversationId: 'c1', title: 'Parser work', pendingChanges: 1 });
    expect(candidate.openTodos).toEqual(['wire up the parser']);
    expect(candidate.lastMessage).toBe('I added the tokenizer.');
  });

  it('skips untitled and empty conversations', async () => {
    useChatStore.setState({
      conversations: [{ id: 'c1', title: 'New Chat', providerId: 'p', modelId: 'm', createdAt: 0, updatedAt: 0 }],
    });
    await useAgendaStore.getState().loadResume();
    expect(useAgendaStore.getState().resume).toHaveLength(0);
  });
});

describe('loadCached', () => {
  it('shows a previous run instantly without contacting the provider', async () => {
    queued = [suggestion(['Yesterday task'])];
    await useAgendaStore.getState().findWork('p1', 'm1');
    const spent = streamCalls.length;

    useAgendaStore.setState({ tasks: [], generatedAt: null });
    useAgendaStore.getState().loadCached();

    expect(useAgendaStore.getState().tasks.map((t) => t.title)).toEqual(['Yesterday task']);
    expect(streamCalls).toHaveLength(spent); // no extra call
  });

  it('does nothing when there is no cache for this project', () => {
    useAgendaStore.getState().loadCached();
    expect(useAgendaStore.getState().tasks).toHaveLength(0);
  });
});
