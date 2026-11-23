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

function setupStore(openFileSize = 10000) {
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
  useModelStore.setState({ models: new Map([['p1', [model]]]), selectedModelId: model.id });
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
    conversations: [{ id: 'conv1', title: 'Smoke', providerId: 'p1', modelId: model.id, createdAt: 0, updatedAt: 0 }],
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
