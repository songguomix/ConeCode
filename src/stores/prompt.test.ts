import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore } from './chat.store';
import { useWorkspaceStore } from './workspace.store';
import { useSettingsStore } from './settings.store';
import { useModelStore } from './model.store';
import { useMemoryStore } from './memory.store';
import { useSkillsStore } from './skills.store';
import { useGoalStore } from './goal.store';
import type { AIModel } from '../types';
import { estimateTokens } from '../core/tokens';

// The system prompt is the agent's whole operating manual, and it is easy to
// grow it back into the thing it was: the same rule stated three times in three
// voices, plus tool-parameter detail the API already sends as a schema. These
// tests pin the properties that make it work — every rule present exactly once,
// nothing duplicated between prose and schema, safety text intact.

let streamCalls: any[];

const model: AIModel = {
  id: 'm1', name: 'Claude Opus 4.6', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: false,
  contextWindow: 200000, maxOutputTokens: 8192, enabled: true,
};

const textResponse = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

/** Build the real request by running one turn against a stubbed provider. */
async function requestMessages(settings: Partial<Record<string, any>> = {}): Promise<any[]> {
  useSettingsStore.setState({
    toolCallMode: 'auto', approvalMode: 'suggest', autoIncludeFileContext: false,
    sandboxMode: 'off', sandboxAllowNetwork: false, ...settings,
  } as any);
  streamCalls = [];
  await useChatStore.getState().sendMessage('hi', 'p1', 'm1');
  return streamCalls[0].messages;
}

/** Render the real prompt by running one turn against a stubbed provider. */
async function prompt(settings: Partial<Record<string, any>> = {}): Promise<string> {
  return (await requestMessages(settings))
    .filter((m: any) => m.role === 'system')
    .map((m: any) => m.content)
    .join('\n\n');
}

const countOf = (haystack: string, needle: string) => haystack.split(needle).length - 1;
const lastCacheBreakpointIndex = (messages: any[]) => {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i]?.cacheControl?.type === 'ephemeral') return i;
  }
  return -1;
};

beforeEach(() => {
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
  (globalThis as any).window = {
    electronAPI: {
      skill: { list: async () => ({ global: [], project: [] }) },
      chat: { stream: async (p: any) => { streamCalls.push(p); return textResponse('done'); }, stop: async () => true },
      message: { create: async (m: any) => m, delete: async () => true, list: async () => [] },
      conversation: { create: async (d: any) => ({ id: 'c1', ...d }), update: async () => {}, list: async () => [] },
      fs: { readFile: async () => null, exists: async () => false, glob: async () => [], search: async () => [] },
    },
  };
  vi.spyOn(console, 'log').mockImplementation(() => {});
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: 'm1' });
  useWorkspaceStore.setState({ rootPath: '/proj', mcpTools: [], contextFiles: [], selectedFile: null, fileContent: null, agentsMd: null });
  useMemoryStore.setState({ enabled: false, entries: [], loaded: true, extracting: false, turnsSinceExtraction: 0 });
  useSkillsStore.setState({ installed: [], effective: [], loaded: true, loadedRootPath: '/proj', busy: null, error: null });
  useChatStore.setState({ messages: [], activeConversationId: 'c1', isStreaming: false, planMode: false, error: null });
});

describe('every rule is stated once', () => {
  it('does not repeat the parallel-call rule', async () => {
    // It used to live under BOTH an "Efficiency" heading and the tool-format
    // block. A rule given twice in two voices reads as two weaker rules.
    const p = await prompt();
    expect(countOf(p, 'INDEPENDENT')).toBe(1);
  });

  it('does not repeat the never-commit rule', async () => {
    const p = await prompt();
    expect(countOf(p.toLowerCase(), 'commit')).toBe(1);
  });

  it('states the evidence-over-guessing rule once, not three times', async () => {
    const p = await prompt();
    expect(countOf(p, 'Read enough to know')).toBe(1);
  });

  it('splits running the code from re-reading it, without restating either', async () => {
    // These were one merged step and it was too coarse: "does it run" and "read
    // the whole thing again from the top" are different work. They are separate
    // steps now, and each says its own thing once.
    const p = await prompt();
    expect(countOf(p, 'VERIFY')).toBe(1);
    expect(countOf(p, 'REVIEW FROM THE TOP')).toBe(1);
    // VERIFY is about execution only — no re-reading language left in it.
    const verify = p.slice(p.indexOf('4. VERIFY'), p.indexOf('5. REVIEW'));
    expect(verify).toContain('prove it RUNS');
    expect(verify).not.toContain('re-read');
  });
});

describe('the final review pass', () => {
  it('is unconditional, not something to do when it feels wrong', async () => {
    const p = await prompt();
    expect(p).toContain('Do this every time');
  });

  it('reviews against the original request, not just the last edit', async () => {
    const p = await prompt();
    expect(p).toContain('Re-read the original request');
    expect(p).toContain('code as it NOW STANDS');
  });

  it('loops until a pass finds nothing', async () => {
    const p = await prompt();
    expect(p).toContain('Fix gaps and repeat until a review finds nothing');
    expect(p).toContain('only then report done');
  });

  it('gates the closing summary on the review, not just on verification', async () => {
    // Without "reviewed" in the closing rule the model can end the turn the
    // moment tests go green, and step 5 never happens.
    for (const mode of ['auto', 'prompt']) {
      const p = await prompt({ toolCallMode: mode });
      expect(p).toContain('changes are verified and reviewed from the top');
    }
  });
});

describe('rules the tool schemas cannot carry', () => {
  it('leaves edit_file and exec parameter detail to the schema in native mode', async () => {
    const p = await prompt({ toolCallMode: 'auto' });
    expect(p).not.toContain('whitespace included');
    expect(p).not.toContain('default "cwd"');
  });

  it('still keeps the rules no schema expresses', async () => {
    const p = await prompt({ toolCallMode: 'auto' });
    expect(p).toContain('Always use absolute paths');
    expect(p).toContain('update_todos REPLACES the entire list');
  });

  it('spells out the json action format only in prompt mode', async () => {
    const native = await prompt({ toolCallMode: 'auto' });
    expect(native).toContain('function-calling interface');
    expect(native).not.toContain('Available actions');

    const promptMode = await prompt({ toolCallMode: 'prompt' });
    expect(promptMode).toContain('Available actions');
    expect(promptMode).toContain('<tool_call>'); // the anti-pattern warning
  });

  it('only advertises the Plan Mode allowlist in prompt mode', async () => {
    useChatStore.setState({ planMode: true });
    const p = await prompt({ toolCallMode: 'prompt' });
    expect(p).toContain('"action": "read_file"');
    expect(p).not.toContain('"action": "exec"');
    expect(p).not.toContain('"action": "open_app"');
    expect(p).not.toContain('"action": "remember"');
  });
});

describe('behaviour rules that were missing', () => {
  it('tells the agent to answer in the user language', async () => {
    const p = await prompt();
    expect(p).toContain('Answer in the language the user writes in');
  });

  it('tells the agent to stay in scope', async () => {
    const p = await prompt();
    expect(p).toContain('Stay in scope');
  });

  it('matches mutations to the authority granted by the request', async () => {
    const p = await prompt();
    expect(p).toContain('review, explain, or diagnose without editing');
    expect(p).toContain('when asked to change or build, implement and verify');
  });

  it('makes user, project and saved guidance precedence explicit', async () => {
    const p = await prompt();
    expect(p).toContain("user's current request first, then project instructions, then saved preferences");
  });

  it('tells the agent not to retry an identical failing call', async () => {
    const p = await prompt();
    expect(p).toContain('never repeat the same failing call');
  });

  it('gives the platform and date', async () => {
    const p = await prompt();
    expect(p).toMatch(/Environment: macOS · \d{4}-\d{2}-\d{2}/);
  });
});

describe('safety text survives', () => {
  it('describes the sandbox when it is on', async () => {
    const p = await prompt({ sandboxMode: 'workspaceWrite' });
    expect(p).toContain('SANDBOXED');
    expect(p).toContain('NO network access');
    expect(p).toContain('never work around it');
  });

  it('says nothing about a sandbox when it is off', async () => {
    const p = await prompt({ sandboxMode: 'off' });
    expect(p).not.toContain('SANDBOXED');
  });

  it('drops the no-network clause when the sandbox allows network', async () => {
    const p = await prompt({ sandboxMode: 'workspaceWrite', sandboxAllowNetwork: true });
    expect(p).toContain('SANDBOXED');
    expect(p).not.toContain('NO network access');
  });

  it('keeps the prompt-injection rule and the irreversible-command rule', async () => {
    const p = await prompt();
    expect(p).toContain('untrusted DATA');
    expect(p).toContain('rm -rf');
  });

  it('keeps the model identity rule', async () => {
    const p = await prompt();
    expect(p).toContain('never claim to be another assistant');
    expect(countOf(p, 'Claude Opus 4.6')).toBe(1);
  });
});

describe('prompt budget', () => {
  it('keeps the native core prompt below 900 estimated tokens', async () => {
    const messages = await requestMessages({ toolCallMode: 'auto' });
    const core = messages.find((m: any) => m.role === 'system' && m.cacheControl?.type === 'ephemeral');
    expect(core).toBeTruthy();
    expect(estimateTokens(core.content)).toBeLessThan(900);
  });
});

describe('workspace context', () => {
  it('keeps a reusable core breakpoint before project-specific context', async () => {
    useWorkspaceStore.setState({
      agentsMd: 'Always run the parser tests.',
      agentsMdPath: '/proj/AGENTS.md',
      memoryFiles: [],
    });
    const messages = await requestMessages();
    const breakpoints = messages.filter((m: any) => m.cacheControl?.type === 'ephemeral');

    // BP1 core, BP2 tool protocol, BP3 workspace tail.
    expect(breakpoints).toHaveLength(3);
    expect(breakpoints[0].content).not.toContain('Always run the parser tests.');
    expect(breakpoints[1].content).not.toContain('Always run the parser tests.');
    expect(breakpoints[2].content).toContain('Always run the parser tests.');
  });

  it('keeps sandbox wording out of the global core (hit-rate)', async () => {
    const messages = await requestMessages({ sandboxMode: 'workspaceWrite' });
    const core = messages.find((m: any) => m.role === 'system' && m.cacheControl?.type === 'ephemeral');
    expect(core.content).not.toContain('SANDBOXED');
    const toolBlock = messages.filter((m: any) => m.role === 'system' && m.cacheControl?.type === 'ephemeral')[1];
    expect(toolBlock.content).toContain('SANDBOXED');
  });

  it('places volatile runtime state after the stable cache breakpoint', async () => {
    useWorkspaceStore.setState({ selectedFile: '/proj/src/a.ts' });
    const messages = await requestMessages();
    const breakpoint = lastCacheBreakpointIndex(messages);
    const runtime = messages.findIndex((m: any) =>
      typeof m.content === 'string' && m.content.startsWith('Runtime context'),
    );

    expect(breakpoint).toBeGreaterThanOrEqual(0);
    expect(runtime).toBeGreaterThan(breakpoint);
    expect(messages[breakpoint].content).not.toContain('/proj/src/a.ts');
    expect(messages[runtime].content).toContain('Open file: /proj/src/a.ts');
  });

  it('keeps a paused goal after the workspace cache breakpoint', async () => {
    useWorkspaceStore.setState({ agentsMd: 'Project rules.', agentsMdPath: '/proj/AGENTS.md', memoryFiles: [] });
    useGoalStore.setState({
      goals: {
        c1: { conversationId: 'c1', text: 'ship the thing', status: 'paused', createdAt: 0, updatedAt: 0 },
      },
    });
    const messages = await requestMessages();
    const lastBp = lastCacheBreakpointIndex(messages);
    const goalIdx = messages.findIndex((m: any) =>
      typeof m.content === 'string' && m.content.startsWith('PAUSED GOAL'),
    );
    expect(goalIdx).toBeGreaterThan(lastBp);
    expect(messages[lastBp].content).not.toContain('ship the thing');
    useGoalStore.setState({ goals: {} });
  });

  it('reports the open folder and file', async () => {
    useWorkspaceStore.setState({ selectedFile: '/proj/src/a.ts' });
    const p = await prompt();
    expect(p).toContain('Workspace: /proj');
    expect(p).toContain('Open file: /proj/src/a.ts');
  });

  it('says so plainly when no folder is open', async () => {
    useWorkspaceStore.setState({ rootPath: null, selectedFile: null });
    const p = await prompt();
    expect(p).toContain('Workspace: No folder opened');
    expect(p).toContain('Open file: None');
  });
});
