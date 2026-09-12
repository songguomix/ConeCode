import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useAutopilotStore } from './autopilot.store';
import { useChatStore } from './chat.store';
import { useSettingsStore } from './settings.store';
import { useWorkspaceStore } from './workspace.store';
import { useMemoryStore } from './memory.store';
import { VERIFY_MARKER } from '../core/agenda/newProject';
import type { ProjectIdea } from '../core/agenda/newProject';

// The whole unattended path: pick an idea → folder created → project built →
// verified by actually running a command → repaired on failure. The user does
// nothing after the click, so every one of these steps has to hold on its own.

let createdDirs: string[];
let execCalls: { command: string; cwd?: string }[];
let execResults: { success: boolean; stdout: string; stderr: string; exitCode: number }[];
let sentPrompts: string[];
let existingProjects: string[];

const idea: ProjectIdea = {
  id: 'i1', title: 'CLI Tool', description: 'Does a thing.',
  stack: 'TypeScript · Node', tags: ['cli'], scale: 'small',
};

/** Stand-in agent: appends an assistant message declaring a verify command. */
function fakeAgentReply(content: string) {
  useChatStore.setState((s) => ({
    messages: [...s.messages, {
      id: `m${s.messages.length}`, conversationId: 'c1', role: 'assistant',
      content, createdAt: Date.now(),
    } as any],
  }));
}

beforeEach(() => {
  createdDirs = [];
  execCalls = [];
  execResults = [];
  sentPrompts = [];
  existingProjects = [];

  (globalThis as any).window = {
    electronAPI: {
      app: { getSystemInfo: async () => ({ homedir: '/home/me' }) },
      fs: {
        createDir: async (p: string) => { createdDirs.push(p); return true; },
        readDir: async () => existingProjects.map((name) => ({ name, path: `/x/${name}`, isDirectory: true })),
        glob: async () => ['/proj/package.json'],
        readFile: async () => null,
        exists: async () => false,
      },
      exec: {
        run: async (command: string, cwd?: string) => {
          execCalls.push({ command, cwd });
          return execResults.shift() ?? { success: true, stdout: 'ok', stderr: '', exitCode: 0 };
        },
      },
      chat: { stream: async () => ({ choices: [{ message: { content: '{"ideas":[]}' } }] }), stop: async () => true },
      message: { create: async (m: any) => m, delete: async () => true, list: async () => [] },
      conversation: { create: async (d: any) => ({ id: 'c1', title: 'New Chat', ...d }), update: async () => {}, list: async () => [] },
    },
  };

  vi.spyOn(console, 'log').mockImplementation(() => {});
  useSettingsStore.setState({ approvalMode: 'suggest', sandboxMode: 'workspaceWrite', sandboxAllowNetwork: true });
  useWorkspaceStore.setState({ rootPath: null });
  useMemoryStore.setState({ enabled: false, entries: [], loaded: true, extracting: false, turnsSinceExtraction: 0 });
  useChatStore.setState({ messages: [], conversations: [], activeConversationId: 'c1', isStreaming: false });
  useAutopilotStore.setState({
    phase: 'idle', running: null, projectDir: null, attempt: 0,
    verifyCommand: null, lastOutput: '', error: null, ideas: [], loadingIdeas: false, ideasModelKey: null,
  });

  // Stub the agent: record the prompt, reply as a finished build.
  vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(async (content: string) => {
    sentPrompts.push(content);
    fakeAgentReply(`Built it.\n\n${VERIFY_MARKER} npm test`);
  });
  vi.spyOn(useChatStore.getState(), 'createConversation').mockResolvedValue('c1');
  vi.spyOn(useChatStore.getState(), 'renameConversation').mockResolvedValue(undefined as any);
  vi.spyOn(useChatStore.getState(), 'setConversationFolder').mockResolvedValue(undefined as any);
  vi.spyOn(useWorkspaceStore.getState(), 'openFolderPath').mockResolvedValue(true);
});

describe('autopilot: one click, no further input', () => {
  it('creates the folder itself — no picker, no question', async () => {
    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(createdDirs).toContain('/home/me/ConeCode Projects');
    expect(createdDirs).toContain('/home/me/ConeCode Projects/cli-tool');
    expect(useAutopilotStore.getState().projectDir).toBe('/home/me/ConeCode Projects/cli-tool');
  });

  it('never overwrites an existing project of the same name', async () => {
    existingProjects = ['cli-tool', 'cli-tool-2'];
    await useAutopilotStore.getState().run(idea, 'p1', 'm1');
    expect(useAutopilotStore.getState().projectDir).toBe('/home/me/ConeCode Projects/cli-tool-3');
  });

  it('runs unattended: approvals are suspended for the run and restored after', async () => {
    let approvalDuringRun: string | undefined;
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(async (content: string) => {
      sentPrompts.push(content);
      approvalDuringRun = useSettingsStore.getState().approvalMode;
      fakeAgentReply(`Done.\n\n${VERIFY_MARKER} npm test`);
    });

    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(approvalDuringRun, 'must not stop for approvals mid-build').toBe('fullAuto');
    expect(useSettingsStore.getState().approvalMode, 'must be restored afterwards').toBe('suggest');
  });

  it('actually RUNS the project to verify it, in the project directory', async () => {
    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(execCalls).toHaveLength(1);
    expect(execCalls[0]).toMatchObject({ command: 'npm test', cwd: '/home/me/ConeCode Projects/cli-tool' });
    expect(useAutopilotStore.getState().phase).toBe('done');
  });

  it('repairs and re-runs until it passes', async () => {
    // First run fails, second passes — exactly the "make it work" loop.
    execResults = [
      { success: false, stdout: '', stderr: 'FAIL 1 test failed', exitCode: 1 },
      { success: true, stdout: 'all good', stderr: '', exitCode: 0 },
    ];

    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(execCalls).toHaveLength(2);
    expect(sentPrompts).toHaveLength(2);
    // The repair prompt must carry the REAL failure, not a vague "it failed".
    expect(sentPrompts[1]).toContain('FAIL 1 test failed');
    expect(sentPrompts[1]).toContain('npm test');
    expect(useAutopilotStore.getState().phase).toBe('done');
  });

  it('gives up after repeated failures instead of looping forever', async () => {
    execResults = Array.from({ length: 5 }, () => ({ success: false, stdout: '', stderr: 'still broken', exitCode: 1 }));

    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(execCalls).toHaveLength(3); // MAX_REPAIR_ATTEMPTS
    expect(useAutopilotStore.getState().phase).toBe('failed');
    expect(useAutopilotStore.getState().error).toBe('verification-failed');
    // Even on failure the user gets their approval setting back.
    expect(useSettingsStore.getState().approvalMode).toBe('suggest');
  });

  it('falls back to the project layout when no command was declared', async () => {
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockImplementation(async () => {
      fakeAgentReply('I built the project.'); // no VERIFY line
    });

    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    // glob reports a package.json, so npm test is the implied check.
    expect(execCalls[0].command).toBe('npm test');
  });

  it('restores approvals even when something throws mid-run', async () => {
    vi.spyOn(useChatStore.getState(), 'sendMessage').mockRejectedValue(new Error('provider exploded'));

    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(useAutopilotStore.getState().phase).toBe('failed');
    expect(useAutopilotStore.getState().error).toContain('provider exploded');
    expect(useSettingsStore.getState().approvalMode).toBe('suggest');
  });

  it('binds the run to its own conversation and workspace', async () => {
    const rename = vi.spyOn(useChatStore.getState(), 'renameConversation');
    const openFolder = vi.spyOn(useWorkspaceStore.getState(), 'openFolderPath');

    await useAutopilotStore.getState().run(idea, 'p1', 'm1');

    expect(openFolder).toHaveBeenCalledWith('/home/me/ConeCode Projects/cli-tool');
    expect(rename).toHaveBeenCalledWith('c1', 'CLI Tool');
  });
});

describe('idea list', () => {
  it('shows the built-in ideas when no model is configured', async () => {
    await useAutopilotStore.getState().loadIdeas(undefined, undefined);
    expect(useAutopilotStore.getState().ideas.length).toBeGreaterThanOrEqual(5);
    expect(useAutopilotStore.getState().usingFallback).toBe(true);
  });

  it('falls back rather than showing nothing when the provider fails', async () => {
    (globalThis as any).window.electronAPI.chat.stream = async () => { throw new Error('offline'); };
    await useAutopilotStore.getState().loadIdeas('p1', 'm1');
    expect(useAutopilotStore.getState().ideas.length).toBeGreaterThanOrEqual(5);
    expect(useAutopilotStore.getState().usingFallback).toBe(true);
  });

  it('uses live suggestions when the model returns them', async () => {
    (globalThis as any).window.electronAPI.chat.stream = async () => ({
      choices: [{ message: { content: '{"ideas":[{"title":"Hot New Thing","description":"Very current.","stack":"Go"}]}' } }],
    });
    await useAutopilotStore.getState().loadIdeas('p1', 'm1', true);
    expect(useAutopilotStore.getState().ideas[0].title).toBe('Hot New Thing');
    expect(useAutopilotStore.getState().usingFallback).toBe(false);
  });
});

describe('ideas follow the selected model', () => {
  const live = (title: string) => ({
    choices: [{ message: { content: JSON.stringify({ ideas: [{ title, description: 'From the model.', stack: 'Go' }] }) } }],
  });

  it('re-asks once the user model finishes loading', async () => {
    // Models load asynchronously at startup, so the first render has none. The
    // fallback shown then must NOT stick once the real model arrives.
    await useAutopilotStore.getState().loadIdeas(undefined, undefined);
    expect(useAutopilotStore.getState().usingFallback).toBe(true);

    (globalThis as any).window.electronAPI.chat.stream = async () => live('Model Idea');
    await useAutopilotStore.getState().loadIdeas('p1', 'm1');

    expect(useAutopilotStore.getState().usingFallback).toBe(false);
    expect(useAutopilotStore.getState().ideas[0].title).toBe('Model Idea');
  });

  it('re-asks when the user switches model', async () => {
    (globalThis as any).window.electronAPI.chat.stream = async () => live('First Model');
    await useAutopilotStore.getState().loadIdeas('p1', 'm1');
    expect(useAutopilotStore.getState().ideas[0].title).toBe('First Model');

    (globalThis as any).window.electronAPI.chat.stream = async () => live('Second Model');
    await useAutopilotStore.getState().loadIdeas('p1', 'm2');
    expect(useAutopilotStore.getState().ideas[0].title).toBe('Second Model');
  });

  it('does not re-ask the same model over and over', async () => {
    let calls = 0;
    (globalThis as any).window.electronAPI.chat.stream = async () => { calls++; return live('Stable'); };
    await useAutopilotStore.getState().loadIdeas('p1', 'm1');
    await useAutopilotStore.getState().loadIdeas('p1', 'm1');
    await useAutopilotStore.getState().loadIdeas('p1', 'm1');
    expect(calls).toBe(1);
  });
});
