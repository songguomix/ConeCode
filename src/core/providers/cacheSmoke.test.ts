import { describe, it, expect, beforeEach, vi } from 'vitest';
import { useChatStore, resetNativeToolFallback } from '../../stores/chat.store';
import { useModelStore } from '../../stores/model.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useMemoryStore } from '../../stores/memory.store';
import { useTodosStore } from '../../stores/todos.store';
import { useCodeChangesStore } from '../../stores/codeChanges.store';
import { useComputerStore } from '../../stores/computer.store';
import { useUIStore } from '../../stores/ui.store';
import { OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { CustomAdapter } from './custom.adapter';
import { OpenRouterAdapter } from './openrouter.adapter';
import type { AIModel, ProviderConfig, SendMessageParams } from '../../types';

// ---------------------------------------------------------------------------
// Cache-hit smoke test harness:
// Simulates real provider prefix caching (OpenAI/DeepSeek implicit prefix
// cache & Anthropic/OpenRouter explicit breakpoint cache) over the ACTUAL
// wire payloads produced by chat.store + provider adapters.
// ---------------------------------------------------------------------------

/** Serialize a wire request prefix element to comparable canonical text. */
function serializePrefixItems(items: unknown[]): string[] {
  return items.map((item) => JSON.stringify(item));
}

/** Measure implicit longest-common-prefix hit ratio between two wire requests. */
function measureImplicitPrefixHit(prev: any, curr: any): { hitChars: number; totalChars: number; ratio: number } {
  const prevTools = JSON.stringify(prev.tools ?? null);
  const currTools = JSON.stringify(curr.tools ?? null);
  const prevMsgs = serializePrefixItems(prev.messages ?? []);
  const currMsgs = serializePrefixItems(curr.messages ?? []);

  const totalChars = currTools.length + currMsgs.reduce((s, m) => s + m.length, 0);
  if (prevTools !== currTools) return { hitChars: 0, totalChars, ratio: 0 };

  let hitChars = currTools.length;
  const limit = Math.min(prevMsgs.length, currMsgs.length);
  for (let i = 0; i < limit; i++) {
    if (prevMsgs[i] === currMsgs[i]) {
      hitChars += currMsgs[i].length;
    } else {
      break;
    }
  }
  return { hitChars, totalChars, ratio: totalChars > 0 ? hitChars / totalChars : 0 };
}

/**
 * Measure Anthropic/OpenRouter Claude explicit-breakpoint cache hit ratio.
 * Only content up to the last `cache_control` breakpoint (or end of messages
 * when top-level `cache_control` is set) is written to cache on the previous
 * request; changing `thinking` config or `tools` invalidates the entire cache.
 */
function measureAnthropicCacheHit(prev: any, curr: any): { hitChars: number; totalChars: number; ratio: number; reason?: string } {
  const stripCacheControl = (obj: any): any => {
    if (Array.isArray(obj)) return obj.map(stripCacheControl);
    if (obj && typeof obj === 'object') {
      const out: any = {};
      for (const [k, v] of Object.entries(obj)) {
        if (k === 'cache_control') continue;
        out[k] = stripCacheControl(v);
      }
      return out;
    }
    return obj;
  };

  const flattenBlocks = (body: any): { text: string; hasBp: boolean }[] => {
    const blocks: { text: string; hasBp: boolean }[] = [];
    if (body.tools) {
      blocks.push({ text: JSON.stringify(stripCacheControl(body.tools)), hasBp: false });
    }
    const sys = Array.isArray(body.system) ? body.system : [];
    for (const s of sys) {
      blocks.push({ text: JSON.stringify(stripCacheControl(s)), hasBp: !!s?.cache_control });
    }
    const msgs = Array.isArray(body.messages) ? body.messages : [];
    for (const m of msgs) {
      if (Array.isArray(m.content)) {
        for (const part of m.content) {
          blocks.push({ text: `${m.role}:${JSON.stringify(stripCacheControl(part))}`, hasBp: !!part?.cache_control });
        }
      } else {
        blocks.push({ text: `${m.role}:${JSON.stringify(stripCacheControl(m))}`, hasBp: false });
      }
    }
    if (body.cache_control && blocks.length > 0) {
      blocks[blocks.length - 1].hasBp = true;
    }
    return blocks;
  };

  const currBlocks = flattenBlocks(curr);
  const totalChars = currBlocks.reduce((s, b) => s + b.text.length, 0);

  // Anthropic invalidates the full cache when thinking config changes.
  if (JSON.stringify(prev.thinking ?? null) !== JSON.stringify(curr.thinking ?? null)) {
    return { hitChars: 0, totalChars, ratio: 0, reason: 'thinking_config_changed' };
  }

  const prevBlocks = flattenBlocks(prev);
  // Find the last breakpoint in prev — nothing after it was cached.
  let prevLastBp = -1;
  for (let i = prevBlocks.length - 1; i >= 0; i--) {
    if (prevBlocks[i].hasBp) { prevLastBp = i; break; }
  }
  if (prevLastBp === -1) return { hitChars: 0, totalChars, ratio: 0, reason: 'no_prev_breakpoint' };

  // Match prefix blocks up to prevLastBp.
  let hitChars = 0;
  const limit = Math.min(prevLastBp + 1, currBlocks.length);
  for (let i = 0; i < limit; i++) {
    if (prevBlocks[i].text === currBlocks[i].text) {
      hitChars += currBlocks[i].text.length;
    } else {
      break;
    }
  }
  return { hitChars, totalChars, ratio: totalChars > 0 ? hitChars / totalChars : 0 };
}

class OpenAIWireProbe extends OpenAIAdapter {
  wire(params: SendMessageParams) { return this.buildRequestBody(params); }
}

class CustomWireProbe extends CustomAdapter {
  wire(params: SendMessageParams) { return this.buildRequestBody(params); }
}

class OpenRouterWireProbe extends OpenRouterAdapter {
  wire(params: SendMessageParams) { return this.buildRequestBody(params); }
}

class AnthropicWireProbe extends AnthropicAdapter {
  async wire(params: SendMessageParams) {
    let captured: any = null;
    const spy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      captured = JSON.parse(String(init?.body));
      return new Response('{}');
    });
    try {
      await this.sendMessage(params);
    } finally {
      spy.mockRestore();
    }
    return captured;
  }
}

const baseConfig: ProviderConfig = {
  id: 'p1', name: 'test', type: 'openai', baseUrl: 'https://api.openai.com/v1',
  apiKey: 'sk-test', defaultModel: 'gpt-4o', timeout: 1000, enabled: true, createdAt: 0, updatedAt: 0,
};

const model: AIModel = {
  id: 'claude-sonnet-4', name: 'Claude Sonnet 4', providerId: 'p1',
  supportsText: true, supportsVision: false, supportsImageGeneration: false,
  supportsAudioInput: false, supportsAudioOutput: false,
  supportsFunctionCalling: true, supportsReasoning: true,
  contextWindow: 200000, maxOutputTokens: 8192, enabled: true,
};

const gptModel: AIModel = {
  ...model,
  id: 'gpt-4o', name: 'GPT-4o', supportsVision: true, supportsReasoning: false,
  contextWindow: 128000, maxOutputTokens: 16384,
};

const toolCallResponse = (name: string, args: Record<string, any>, id: string, thinking?: string) => ({
  choices: [{
    message: {
      role: 'assistant',
      content: '',
      tool_calls: [{ id, type: 'function', function: { name, arguments: JSON.stringify(args) } }],
    },
    finish_reason: 'tool_calls',
  }],
  ...(thinking ? { thinking_blocks: [{ thinking, signature: `sig-${id}` }] } : {}),
});

const textResponse = (content: string) => ({
  choices: [{ message: { role: 'assistant', content }, finish_reason: 'stop' }],
});

let streamCalls: any[];
let queued: any[];
let files: Map<string, string>;

function setupStore(openFileSize = 10000, selectedModel = model) {
  streamCalls = [];
  queued = [];
  files = new Map();
  for (let i = 0; i < 20; i++) {
    files.set(`/proj/src/mod${i}.ts`, `// Module ${i}\n` + `export const val${i} = "${'x'.repeat(1200)}";\n`);
  }
  const openFileContent = `// Open editor file\n` + 'const line = "editor context payload";\n'.repeat(Math.ceil(openFileSize / 40));

  (globalThis as any).window = {
    electronAPI: {
      chat: {
        stream: async (params: any) => {
          streamCalls.push(params);
          return queued.shift() ?? textResponse('done');
        },
        stop: async () => true,
      },
      message: { create: async (m: any) => m, delete: async () => true, list: async () => [] },
      conversation: { create: async (d: any) => ({ id: 'conv1', title: 'Test', ...d, createdAt: 0, updatedAt: 0 }), update: async () => {}, list: async () => [] },
      fs: {
        readFile: async (p: string) => files.get(p) ?? null,
        readDir: async () => [],
        exists: async (p: string) => files.has(p),
        stat: async () => ({ size: 1, isDirectory: false, isFile: true, createdAt: '', modifiedAt: '' }),
        search: async () => ({ matches: [], capped: false }),
        glob: async () => ({ files: [], capped: false }),
      },
      git: { status: async () => '', diff: async () => '' },
      app: { getSystemInfo: async () => ({ platform: 'darwin' }) },
    },
  };
  Object.defineProperty(globalThis, 'navigator', { value: { platform: 'MacIntel' }, configurable: true });
  resetNativeToolFallback();
  useUIStore.setState({ viewMode: 'work' });
  useModelStore.setState({ models: new Map([['p1', [selectedModel]]]), selectedModelId: selectedModel.id });
  useSettingsStore.setState({ toolCallMode: 'auto', approvalMode: 'suggest', autoIncludeFileContext: true, maxContextFileSize: 10000 });
  useWorkspaceStore.setState({
    rootPath: '/proj', mcpTools: [], contextFiles: [],
    selectedFile: '/proj/src/editor.ts', fileContent: openFileContent,
    agentsMd: 'Follow project coding standards.', agentsMdPath: '/proj/AGENTS.md', memoryFiles: [],
  });
  useTodosStore.getState().clearTodos();
  useMemoryStore.setState({ entries: [], enabled: false, extracting: false, loaded: true });
  useCodeChangesStore.setState({ changes: [] });
  useComputerStore.setState({ enabled: false, target: null, targetRevision: 0, frameId: null, lastShot: null, activity: [] });
  useChatStore.setState({
    messages: [],
    conversations: [{ id: 'conv1', title: 'Smoke', providerId: 'p1', modelId: selectedModel.id, createdAt: 0, updatedAt: 0 }],
    activeConversationId: 'conv1',
    isStreaming: false,
    planMode: false,
    reviewMode: false,
    agentMode: 'standard',
    reasoningEffort: 'auto',
    error: null,
    messageEdits: {},
    streamingRuns: {},
  });
}

describe('Cache hit rate smoke test', () => {
  beforeEach(() => {
    vi.spyOn(console, 'log').mockImplementation(() => {});
  });

  it('Scenario 1: OpenAI caches the open file without dropping context or fresh tool results', async () => {
    setupStore(10000);
    for (let i = 0; i < 4; i++) queued.push(toolCallResponse('read_file', { path: `/proj/src/mod${i}.ts` }, `c${i}`));
    queued.push(textResponse('all read'));

    await useChatStore.getState().sendMessage('Read the 4 modules and summarize them', 'p1', model.id);

    const probe = new OpenAIWireProbe(baseConfig);
    const wires = streamCalls.map((call) => probe.wire({
      model: call.modelId, messages: call.messages, tools: call.tools,
      toolChoice: call.toolChoice, conversationId: call.conversationId, reasoningEffort: call.reasoningEffort,
    }));

    expect(wires[0].prompt_cache_key).toBe('conv1');
    const editorIndex = wires[0].messages.findIndex((message: { content: unknown }) =>
      typeof message.content === 'string' && message.content.includes('// Open editor file'));
    expect(editorIndex).toBeGreaterThanOrEqual(0);
    for (const wire of wires.slice(1)) {
      expect(wire.messages[editorIndex]).toEqual(wires[0].messages[editorIndex]);
      expect(wire.messages[wire.messages.length - 1].role).toBe('tool');
    }
    const firstContinuation = wires[1].messages;
    expect(firstContinuation[firstContinuation.length - 1].content).toContain(files.get('/proj/src/mod0.ts'));

    const ratios: number[] = [];
    for (let i = 1; i < wires.length; i++) {
      ratios.push(measureImplicitPrefixHit(wires[i - 1], wires[i]).ratio);
    }
    console.info('[Smoke S1 OpenAI tool loop + 10KB open file] hit ratios:', ratios.map((r) => `${(r * 100).toFixed(1)}%`));
    // On tool continuations, prefix hit ratio should be high (>= 80%), not tanked by re-sending 10KB uncached open file.
    expect(ratios[ratios.length - 1]).toBeGreaterThanOrEqual(0.8);
  });

  it('keeps GPT-4o’s editor and tool history prefix across new user turns', async () => {
    setupStore(10000, gptModel);
    const date = vi.spyOn(Date, 'now').mockReturnValue(new Date(2026, 10, 24, 10, 1).getTime());
    try {
      const chat = useChatStore.getState();
      queued.push(
        toolCallResponse('read_file', { path: '/proj/src/mod0.ts' }, 'cached-read'),
        textResponse('I read the module and compared it with the editor.'),
      );
      await chat.sendMessage('Compare the open file with the first module.', 'p1', gptModel.id);

      date.mockReturnValue(new Date(2026, 10, 24, 10, 3).getTime());
      await chat.sendMessage('Which differences are important?', 'p1', gptModel.id);

      date.mockReturnValue(new Date(2026, 10, 24, 10, 5).getTime());
      useWorkspaceStore.setState({ fileContent: '// Updated editor file\nexport const replacement = 42;' });
      await chat.sendMessage('Review the updated editor version.', 'p1', gptModel.id);
    } finally {
      date.mockRestore();
    }

    expect(streamCalls).toHaveLength(4);
    const probe = new OpenAIWireProbe(baseConfig);
    const [first, continuation, followUp, changed] = streamCalls.map((call) => probe.wire({
      model: call.modelId, messages: call.messages, tools: call.tools,
      toolChoice: call.toolChoice, conversationId: call.conversationId, reasoningEffort: call.reasoningEffort,
      maxTokens: call.maxTokens,
    }));

    const firstToolResult = continuation.messages.at(-1);
    expect(firstToolResult).toEqual({
      role: 'tool', tool_call_id: 'cached-read', content: expect.stringContaining(files.get('/proj/src/mod0.ts')!),
    });
    expect(JSON.stringify(continuation.messages)).toContain('// Open editor file');
    expect(continuation.messages.some((message: { content: unknown }) =>
      typeof message.content === 'string' && message.content.includes('Environment:'))).toBe(false);
    expect(continuation.messages.slice(0, first.messages.length - 1)).toEqual(first.messages.slice(0, -1));
    expect(followUp.messages.slice(0, continuation.messages.length)).toEqual(continuation.messages);
    expect(followUp.messages.filter((message: { content: unknown }) =>
      typeof message.content === 'string' && message.content.includes('// Open editor file'))).toHaveLength(1);
    expect(followUp.tools).toEqual(continuation.tools);
    expect(followUp.prompt_cache_key).toBe(continuation.prompt_cache_key);

    expect(first.messages.at(-1).content).toContain('Environment: macOS · 2026-11-24 10:01');
    expect(followUp.messages.at(-1).content).toContain('Environment: macOS · 2026-11-24 10:03');
    expect(changed.messages.at(-1).content).toContain('Environment: macOS · 2026-11-24 10:05');
    expect(JSON.stringify(changed.messages)).toContain('// Updated editor file');
    expect(JSON.stringify(changed.messages)).not.toContain('// Open editor file');
  });

  it.each([20, 10_500])('preserves recent GPT history when the editor changes after six replies of %i characters', async (size) => {
    setupStore(10000, gptModel);
    const send = (index: number) => useChatStore.getState().sendMessage(`Turn ${index}`, 'p1', gptModel.id);
    for (let i = 0; i < 6; i++) {
      queued.push(textResponse(`Reply ${i} ${'x'.repeat(size)}`));
      await send(i);
    }
    useWorkspaceStore.setState({ fileContent: '// Revised file' });
    await send(6);

    const probe = new OpenAIWireProbe(baseConfig);
    const [prior, revised] = streamCalls.slice(-2).map((call) => probe.wire({
      model: call.modelId, messages: call.messages, tools: call.tools, conversationId: call.conversationId,
    }));
    // Short replies may share the previous turn's editor snapshot. For a long
    // reply the transcript takes priority and must match through the latest turn.
    const lastReusable = prior.messages.findIndex((m: { content: unknown }) =>
      m.content === (size > 10000 ? 'Turn 5' : 'Turn 4'));
    expect(lastReusable).toBeGreaterThan(0);
    expect(revised.messages.slice(0, lastReusable + 1)).toEqual(prior.messages.slice(0, lastReusable + 1));
    expect(JSON.stringify(revised.messages)).not.toContain('// Open editor file');
    expect(JSON.stringify(revised.messages)).toContain('// Revised file');
  });

  it('keeps the GPT-5 prompt-mode tool prefix stable after reasoning', async () => {
    const reasoningModel = { ...gptModel, id: 'gpt-5', name: 'GPT-5', supportsReasoning: true };
    setupStore(10000, reasoningModel);
    useSettingsStore.setState({ toolCallMode: 'prompt' });
    const saveMessage = vi.spyOn(window.electronAPI.message, 'create');
    const reasoning = ['The first module is needed for comparison.', 'Now read the second module.'];
    for (const [index, reasoningContent] of reasoning.entries()) {
      queued.push({ choices: [{
        message: {
          role: 'assistant',
          content: `\`\`\`json\n{"action":"read_file","path":"/proj/src/mod${index}.ts"}\n\`\`\``,
          reasoning_content: reasoningContent,
        },
        finish_reason: 'stop',
      }] });
    }
    queued.push(textResponse('Both modules have been read.'));

    await useChatStore.getState().sendMessage('Read and compare the first two modules.', 'p1', reasoningModel.id);

    expect(streamCalls).toHaveLength(3);
    const probe = new CustomWireProbe({ ...baseConfig, type: 'custom', baseUrl: 'https://gateway.example.test/v1' });
    const [, firstContinuation, secondContinuation] = streamCalls.map((call) => probe.wire({
      model: call.modelId, messages: call.messages, tools: call.tools, conversationId: call.conversationId,
      reasoningEffort: call.reasoningEffort, maxTokens: call.maxTokens,
    }));

    expect(firstContinuation.messages.at(-1).content).toContain(files.get('/proj/src/mod0.ts'));
    expect(secondContinuation.messages.at(-1).content).toContain(files.get('/proj/src/mod1.ts'));
    expect(secondContinuation.messages.slice(0, firstContinuation.messages.length)).toEqual(firstContinuation.messages);
    expect(secondContinuation.messages.some((message: { reasoning_content?: string }) =>
      message.reasoning_content !== undefined)).toBe(false);
    expect(saveMessage.mock.calls.map(([message]) => message.reasoning_content).filter(Boolean)).toEqual(reasoning);
  });

  it('Scenario 2: OpenRouter Claude caches tool-call history across multi-step tool loop', async () => {
    setupStore(0);
    useSettingsStore.setState({ autoIncludeFileContext: false });
    useWorkspaceStore.setState({ contextFiles: [{ path: '/proj/requirements.md', content: 'Keep the attached requirements visible.' }] });
    for (let i = 0; i < 5; i++) queued.push(toolCallResponse('read_file', { path: `/proj/src/mod${i}.ts` }, `c${i}`));
    queued.push(textResponse('done'));

    await useChatStore.getState().sendMessage('Inspect 5 modules', 'p1', model.id);

    const probe = new OpenRouterWireProbe({ ...baseConfig, type: 'openrouter', baseUrl: 'https://openrouter.ai/api/v1' });
    const wires = streamCalls.map((call) => probe.wire({
      model: 'anthropic/claude-sonnet-4', messages: call.messages, tools: call.tools,
      toolChoice: call.toolChoice, conversationId: call.conversationId, reasoningEffort: call.reasoningEffort,
    }));

    const lastWire = wires[wires.length - 1];
    expect(lastWire.cache_control).toEqual({ type: 'ephemeral' });
    expect(JSON.stringify(lastWire.messages)).toContain('Keep the attached requirements visible.');
    expect(lastWire.messages[lastWire.messages.length - 1].role).toBe('tool');
    const ratios: number[] = [];
    for (let i = 1; i < wires.length; i++) {
      ratios.push(measureAnthropicCacheHit(wires[i - 1], wires[i]).ratio);
    }
    console.info('[Smoke S2 OpenRouter Claude tool loop] hit ratios:', ratios.map((r) => `${(r * 100).toFixed(1)}%`));
    expect(ratios[ratios.length - 1]).toBeGreaterThanOrEqual(0.8);
  });

  it('Scenario 3: Anthropic Direct preserves tool continuation cache with open file + extended thinking', async () => {
    setupStore(10000);
    useChatStore.setState({ reasoningEffort: 'medium' });
    for (let i = 0; i < 4; i++) queued.push(toolCallResponse('read_file', { path: `/proj/src/mod${i}.ts` }, `c${i}`, `thinking step ${i}`));
    queued.push(textResponse('done'));

    await useChatStore.getState().sendMessage('Read the 4 modules', 'p1', model.id);

    const probe = new AnthropicWireProbe({ ...baseConfig, type: 'anthropic', baseUrl: 'https://api.anthropic.com' });
    const wires = [];
    for (const call of streamCalls) {
      wires.push(await probe.wire({
        model: 'claude-sonnet-4', messages: call.messages, tools: call.tools,
        toolChoice: call.toolChoice, conversationId: call.conversationId, reasoningEffort: call.reasoningEffort,
      }));
    }

    const lastMessages = wires[wires.length - 1].messages;
    expect(JSON.stringify(lastMessages)).toContain('// Open editor file');
    const toolResult = lastMessages[lastMessages.length - 1];
    expect(toolResult.content.map((block: { type: string }) => block.type)).toEqual(['tool_result']);
    const ratios: number[] = [];
    for (let i = 1; i < wires.length; i++) {
      ratios.push(measureAnthropicCacheHit(wires[i - 1], wires[i]).ratio);
    }
    console.info('[Smoke S3 Anthropic Direct + 10KB open file + thinking] hit ratios:', ratios.map((r) => `${(r * 100).toFixed(1)}%`));
    expect(ratios[ratios.length - 1]).toBeGreaterThanOrEqual(0.8);
  });

  it('Scenario 4: Anthropic multi-turn conversation with auto reasoningEffort does not bust cache on short follow-up', async () => {
    setupStore(0);
    useSettingsStore.setState({ autoIncludeFileContext: false });
    useChatStore.setState({ reasoningEffort: 'auto' });

    queued = [textResponse('Here is my detailed analysis of the cache architecture.')];
    await useChatStore.getState().sendMessage('请帮我分析一下这个架构的缓存命中率问题', 'p1', model.id);
    queued = [textResponse('Sure, applying the fix now.')];
    await useChatStore.getState().sendMessage('好的，继续', 'p1', model.id);

    const probe = new AnthropicWireProbe({ ...baseConfig, type: 'anthropic', baseUrl: 'https://api.anthropic.com' });
    const w0 = await probe.wire({
      model: 'claude-sonnet-4', messages: streamCalls[0].messages, tools: streamCalls[0].tools,
      toolChoice: streamCalls[0].toolChoice, conversationId: streamCalls[0].conversationId, reasoningEffort: streamCalls[0].reasoningEffort,
    });
    const w1 = await probe.wire({
      model: 'claude-sonnet-4', messages: streamCalls[1].messages, tools: streamCalls[1].tools,
      toolChoice: streamCalls[1].toolChoice, conversationId: streamCalls[1].conversationId, reasoningEffort: streamCalls[1].reasoningEffort,
    });

    const hit = measureAnthropicCacheHit(w0, w1);
    console.info('[Smoke S4 Anthropic auto effort across turns] hit:', `${(hit.ratio * 100).toFixed(1)}%`, hit.reason ?? '');
    expect(hit.ratio).toBeGreaterThanOrEqual(0.8);

    const switched = { ...model, id: 'another-model' };
    useModelStore.setState({ models: new Map([['p1', [model, switched]]]), selectedModelId: switched.id });
    queued = [textResponse('Continuing on the new model.')];
    await useChatStore.getState().sendMessage('继续', 'p1', switched.id);
    expect(streamCalls[streamCalls.length - 1]).toMatchObject({ modelId: switched.id, reasoningEffort: 'low' });
  });

  it('Scenario 5: Long 12-tool-call session maintains prefix stability without mid-session cache cliff at tool #9', async () => {
    setupStore(0);
    useSettingsStore.setState({ autoIncludeFileContext: false });
    for (let i = 0; i < 12; i++) queued.push(toolCallResponse('read_file', { path: `/proj/src/mod${i}.ts` }, `c${i}`));
    queued.push(textResponse('all 12 done'));

    await useChatStore.getState().sendMessage('Read all 12 modules', 'p1', model.id);

    const probe = new OpenAIWireProbe(baseConfig);
    const wires = streamCalls.map((call) => probe.wire({
      model: call.modelId, messages: call.messages, tools: call.tools,
      toolChoice: call.toolChoice, conversationId: call.conversationId, reasoningEffort: call.reasoningEffort,
    }));

    const ratios: number[] = [];
    for (let i = 1; i < wires.length; i++) {
      ratios.push(measureImplicitPrefixHit(wires[i - 1], wires[i]).ratio);
    }
    console.info('[Smoke S5 12-step tool loop prefix stability] min hit:', `${(Math.min(...ratios) * 100).toFixed(1)}%`, 'ratios:', ratios.map((r) => `${(r * 100).toFixed(0)}%`));
    expect(Math.min(...ratios)).toBeGreaterThanOrEqual(0.75);
  });
});
