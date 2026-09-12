import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useSkillsStore } from './skills.store';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';
import { useSettingsStore } from './settings.store';
import { useModelStore } from './model.store';
import { useMemoryStore } from './memory.store';
import { BUILTIN_SKILLS } from '../core/skills/builtin';
import { parseSkill } from '../core/skills/skills';
import type { AIModel } from '../types';

// End to end: deploy a skill → it reaches the system prompt → the agent loads it
// with use_skill → the full instructions come back as a tool result.

let installed: { global: any[]; project: any[] };
let installCalls: any[];
let removeCalls: any[];
let streamCalls: any[];
let queued: any[];

const model: AIModel = {
  id: 'm1', name: 'M', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({ choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }] });
const toolCall = (name: string, args: any) => ({
  choices: [{
    message: { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name, arguments: JSON.stringify(args) } }] },
    finish_reason: 'tool_calls',
  }],
});

beforeEach(() => {
  installed = { global: [], project: [] };
  installCalls = [];
  removeCalls = [];
  streamCalls = [];
  queued = [];

  (globalThis as any).window = {
    electronAPI: {
      skill: {
        list: async () => installed,
        install: async (opts: any) => {
          installCalls.push(opts);
          const key = opts.scope as 'global' | 'project';
          const parsed = parseSkill(opts.content, {
            id: opts.id, scope: key, path: `/skills/${opts.id}`,
          });
          if (parsed) {
            const index = installed[key].findIndex((skill) => skill.id === opts.id);
            if (index >= 0) installed[key][index] = parsed;
            else installed[key].push(parsed);
          }
          return { ok: true, path: `/skills/${opts.id}` };
        },
        remove: async (opts: any) => {
          removeCalls.push(opts);
          const key = opts.scope as 'global' | 'project';
          installed[key] = installed[key].filter((skill) => skill.id !== opts.id);
          return { ok: true };
        },
      },
      chat: {
        stream: async (params: any) => { streamCalls.push(params); return queued.shift() ?? textResponse('done'); },
        stop: async () => true,
      },
      message: { create: async (m: any) => m, delete: async () => true, list: async () => [] },
      conversation: { create: async (d: any) => ({ id: 'c1', ...d }), update: async () => {}, list: async () => [] },
      fs: { readFile: async () => null, exists: async () => false, glob: async () => [], search: async () => [] },
    },
  };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: 'm1' });
  useSettingsStore.setState({ toolCallMode: 'auto', approvalMode: 'suggest', autoIncludeFileContext: false });
  useWorkspaceStore.setState({ rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null, fileContent: null, agentsMd: null });
  useMemoryStore.setState({ enabled: false, entries: [], loaded: true, extracting: false, turnsSinceExtraction: 0 });
  useChatStore.setState({ messages: [], activeConversationId: 'c1', isStreaming: false, planMode: false, error: null });
  useSkillsStore.setState({ installed: [], effective: [], loaded: false, loadedRootPath: null, busy: null, error: null });
});

describe('deploying a skill', () => {
  it('writes a real SKILL.md that parses back', async () => {
    const skill = BUILTIN_SKILLS[0];
    await useSkillsStore.getState().install(skill, 'global');

    expect(installCalls).toHaveLength(1);
    expect(installCalls[0]).toMatchObject({ id: skill.id, scope: 'global' });
    // Frontmatter plus body, not a JSON blob — editable by hand afterwards.
    expect(installCalls[0].content).toContain(`name: ${skill.name}`);
    expect(installCalls[0].content).toContain(skill.body.split('\n')[0]);
  });

  it('deploys to the open project when asked', async () => {
    await useSkillsStore.getState().install(BUILTIN_SKILLS[0], 'project');
    expect(installCalls[0]).toMatchObject({ scope: 'project', rootPath: '/proj' });
  });

  it('refuses a project deploy with no project open', async () => {
    useWorkspaceStore.setState({ rootPath: null });
    const ok = await useSkillsStore.getState().install(BUILTIN_SKILLS[0], 'project');
    expect(ok).toBe(false);
    expect(installCalls).toHaveLength(0);
    expect(useSkillsStore.getState().error).toBe('no-project');
  });

  it('removes with the scope it was installed in', async () => {
    installed = { global: [{ id: 'code-review', name: 'Code Review', description: 'd', tags: [], scope: 'global', body: 'b' }], project: [] };
    await useSkillsStore.getState().load();
    await useSkillsStore.getState().remove(useSkillsStore.getState().installed[0]);
    expect(removeCalls[0]).toMatchObject({ id: 'code-review', scope: 'global' });
  });

  it('surfaces an IPC removal failure and keeps the skill installed', async () => {
    installed.global = [{ id: 'code-review', name: 'Code Review', description: 'd', tags: [], scope: 'global', body: 'b' }];
    await useSkillsStore.getState().load();
    window.electronAPI.skill.remove = async () => ({ ok: false, error: 'denied' });

    await useSkillsStore.getState().remove(useSkillsStore.getState().installed[0]);

    expect(useSkillsStore.getState().error).toBe('denied');
    expect(useSkillsStore.getState().installed).toHaveLength(1);
  });
});

describe('scope resolution and lifecycle', () => {
  const globalSkill = {
    id: 'review', name: 'Global Review', description: 'global description',
    tags: [], scope: 'global' as const, source: 'custom' as const, body: 'global body', enabled: true,
  };
  const projectSkill = {
    id: 'review', name: 'Project Review', description: 'project description',
    tags: [], scope: 'project' as const, source: 'custom' as const, body: 'project body', enabled: true,
  };

  it('keeps both scopes manageable while the project copy is effective', async () => {
    installed = { global: [globalSkill], project: [projectSkill] };
    await useSkillsStore.getState().load();

    expect(useSkillsStore.getState().installed).toHaveLength(2);
    expect(useSkillsStore.getState().effective).toHaveLength(1);
    expect(useSkillsStore.getState().body('review')).toBe('project body');
    expect(useSkillsStore.getState().promptBlock()).toContain('project description');
    expect(useSkillsStore.getState().promptBlock()).not.toContain('global description');
  });

  it('reveals the global copy after removing its project override', async () => {
    installed = { global: [globalSkill], project: [projectSkill] };
    await useSkillsStore.getState().load();
    const project = useSkillsStore.getState().installed.find((skill) => skill.scope === 'project')!;

    await useSkillsStore.getState().remove(project);

    expect(useSkillsStore.getState().installed).toHaveLength(1);
    expect(useSkillsStore.getState().body('review')).toBe('global body');
  });

  it('persists disable and enable changes and hides disabled instructions from the agent', async () => {
    installed = { global: [globalSkill], project: [] };
    await useSkillsStore.getState().load();

    await useSkillsStore.getState().setEnabled(useSkillsStore.getState().installed[0], false);
    expect(installCalls[installCalls.length - 1].content).toContain('enabled: false');
    expect(useSkillsStore.getState().installed[0].enabled).toBe(false);
    expect(useSkillsStore.getState().effective).toEqual([]);
    expect(useSkillsStore.getState().body('review')).toBeNull();
    expect(useSkillsStore.getState().promptBlock()).toBe('');

    await useSkillsStore.getState().setEnabled(useSkillsStore.getState().installed[0], true);
    expect(installCalls[installCalls.length - 1].content).not.toContain('enabled:');
    expect(useSkillsStore.getState().body('review')).toBe('global body');
  });

  it('lets a disabled project copy suppress the same global id', async () => {
    installed = { global: [globalSkill], project: [{ ...projectSkill, enabled: false }] };
    await useSkillsStore.getState().load();

    expect(useSkillsStore.getState().installed).toHaveLength(2);
    expect(useSkillsStore.getState().effective).toEqual([]);
    expect(useSkillsStore.getState().body('review')).toBeNull();
  });

  it('ignores a slower response from a workspace that is no longer active', async () => {
    let resolveA!: (value: any) => void;
    let resolveB!: (value: any) => void;
    window.electronAPI.skill.list = (rootPath?: string) => new Promise((resolve) => {
      if (rootPath === '/a') resolveA = resolve;
      else resolveB = resolve;
    });

    useWorkspaceStore.setState({ rootPath: '/a' });
    const loadA = useSkillsStore.getState().load();
    useWorkspaceStore.setState({ rootPath: '/b' });
    const loadB = useSkillsStore.getState().load();
    resolveB({ global: [], project: [{ ...projectSkill, id: 'from-b', body: 'workspace b' }] });
    await loadB;
    resolveA({ global: [], project: [{ ...projectSkill, id: 'from-a', body: 'workspace a' }] });
    await loadA;

    expect(useSkillsStore.getState().loadedRootPath).toBe('/b');
    expect(useSkillsStore.getState().body('from-b')).toBe('workspace b');
    expect(useSkillsStore.getState().body('from-a')).toBeNull();
  });

  it('clears old project skills while the next workspace is loading', async () => {
    installed = { global: [], project: [{ ...projectSkill, id: 'old', body: 'old workspace' }] };
    useWorkspaceStore.setState({ rootPath: '/old' });
    await useSkillsStore.getState().load();
    let resolveNext!: (value: any) => void;
    window.electronAPI.skill.list = () => new Promise((resolve) => { resolveNext = resolve; });

    useWorkspaceStore.setState({ rootPath: '/next' });
    const loading = useSkillsStore.getState().load();
    expect(useSkillsStore.getState().body('old')).toBeNull();
    resolveNext({ global: [], project: [] });
    await loading;
  });
});

describe('a deployed skill reaches the agent', () => {
  const skill = {
    id: 'code-review', name: 'Code Review',
    description: 'Review a diff for real defects. Use when asked to review code.',
    tags: [], scope: 'global' as const, body: '# Code Review\n\nCorrectness first, then contract, then security.',
  };

  it('is advertised in the system prompt by id and description only', async () => {
    installed = { global: [skill], project: [] };
    await useSkillsStore.getState().load();
    queued = [textResponse('ok')];

    await useChatStore.getState().sendMessage('review my changes', 'p1', 'm1');

    const system = streamCalls[0].messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
    expect(system).toContain('code-review: Review a diff for real defects.');
    // The body must NOT be in the prompt — that is what use_skill is for.
    expect(system).not.toContain('Correctness first, then contract');
  });

  it('returns the full instructions when the agent calls use_skill', async () => {
    installed = { global: [skill], project: [] };
    await useSkillsStore.getState().load();
    queued = [toolCall('use_skill', { id: 'code-review' }), textResponse('Following the skill now.')];

    await useChatStore.getState().sendMessage('review my changes', 'p1', 'm1');

    const toolResult = useChatStore.getState().messages.find((m) => m.role === 'tool');
    expect(toolResult).toBeDefined();
    expect(toolResult!.content).toContain('Correctness first, then contract, then security.');
    // ...and the loop continues so it can act on what it just read.
    expect(streamCalls).toHaveLength(2);
  });

  it('tells the agent plainly when it asks for a skill that is not installed', async () => {
    queued = [toolCall('use_skill', { id: 'nonexistent' }), textResponse('ok, carrying on')];

    await useChatStore.getState().sendMessage('do something', 'p1', 'm1');

    const toolResult = useChatStore.getState().messages.find((m) => m.role === 'tool');
    expect(toolResult!.content).toContain('no skill installed');
    expect(streamCalls).toHaveLength(2); // not a dead end
  });

  it('offers use_skill as a real tool to the model', async () => {
    queued = [textResponse('ok')];
    await useChatStore.getState().sendMessage('hi', 'p1', 'm1');
    expect(streamCalls[0].tools.map((t: any) => t.name)).toContain('use_skill');
  });

  it('adds nothing to the prompt when no skills are installed', async () => {
    queued = [textResponse('ok')];
    await useChatStore.getState().sendMessage('hi', 'p1', 'm1');
    const system = streamCalls[0].messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
    expect(system).not.toContain('Installed skills');
  });
});

describe('authoring a custom skill', () => {
  const draft = {
    name: 'House Style',
    description: 'This repo conventions. Use before writing any code here.',
    body: 'Always use tabs. Never introduce a new dependency without asking.',
  };

  it('writes it stamped as custom, not as a reviewed built-in', async () => {
    await useSkillsStore.getState().saveCustom(draft, 'project');
    expect(installCalls[0]).toMatchObject({ id: 'house-style', scope: 'project' });
    expect(installCalls[0].content).toContain('source: custom');
    expect(installCalls[0].content).toContain('Always use tabs.');
  });

  it('refuses an invalid draft before touching the disk', async () => {
    const ok = await useSkillsStore.getState().saveCustom({ ...draft, description: '' }, 'global');
    expect(ok).toBe(false);
    expect(installCalls).toHaveLength(0);
    expect(useSkillsStore.getState().error).toBe('invalid-draft');
  });

  it('will not silently clobber an existing skill of the same name', async () => {
    installed = { global: [], project: [{ id: 'house-style', name: 'House Style', description: 'd', tags: [], scope: 'project', source: 'custom', body: 'old' }] };
    await useSkillsStore.getState().load();

    const ok = await useSkillsStore.getState().saveCustom(draft, 'project');
    expect(ok).toBe(false);
    expect(useSkillsStore.getState().error).toBe('already-exists');
    expect(installCalls).toHaveLength(0);
  });

  it('overwrites in place when editing that same skill', async () => {
    installed = { global: [], project: [{ id: 'house-style', name: 'House Style', description: 'd', tags: [], scope: 'project', source: 'custom', body: 'old' }] };
    await useSkillsStore.getState().load();

    const ok = await useSkillsStore.getState().saveCustom({ ...draft, body: 'Updated rules that are long enough.' }, 'project', 'house-style');
    expect(ok).toBe(true);
    expect(installCalls[0].content).toContain('Updated rules');
  });

  it('does not re-enable a disabled skill just because its text was edited', async () => {
    installed.project = [{
      id: 'house-style', name: 'House Style', description: 'd', tags: [],
      scope: 'project', source: 'custom', body: 'old', enabled: false,
    }];
    await useSkillsStore.getState().load();

    await useSkillsStore.getState().saveCustom(
      { ...draft, body: 'Updated rules that are long enough.' },
      'project',
      'house-style',
    );

    expect(installCalls[0].content).toContain('enabled: false');
    expect(useSkillsStore.getState().installed[0].enabled).toBe(false);
  });

  it('reaches the agent exactly like a built-in one does', async () => {
    installed = { global: [], project: [{
      id: 'house-style', name: 'House Style',
      description: 'This repo conventions. Use before writing any code here.',
      tags: [], scope: 'project', source: 'custom', body: 'Always use tabs.',
    }] };
    await useSkillsStore.getState().load();
    queued = [toolCall('use_skill', { id: 'house-style' }), textResponse('Following it.')];

    await useChatStore.getState().sendMessage('write a helper', 'p1', 'm1');

    const system = streamCalls[0].messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('\n');
    expect(system).toContain('house-style: This repo conventions.');
    const toolResult = useChatStore.getState().messages.find((m) => m.role === 'tool');
    expect(toolResult!.content).toContain('Always use tabs.');
  });
});
