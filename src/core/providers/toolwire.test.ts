import { describe, it, expect } from 'vitest';
import { OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import type { ChatMessage, ProviderConfig, SendMessageParams } from '../../types';

const config: ProviderConfig = {
  id: 'p1', name: 'test', type: 'openai', baseUrl: 'https://example.test',
  apiKey: 'k', defaultModel: 'm', timeout: 1000, enabled: true, createdAt: 0, updatedAt: 0,
};

// Subclasses expose the protected wire-format builders so the conversion can be
// asserted without making a network call.
class OpenAIProbe extends OpenAIAdapter {
  clean(messages: ChatMessage[]) { return this.cleanMessages(messages); }
  tools(params: SendMessageParams) { const body: any = {}; this.applyTools(body, params); return body; }
  finalize(acc: Map<number, { id: string; name: string; args: string }>) { return this.finalizeToolCalls(acc); }
  model(raw: any) { return this.mapModel(raw); }
}
class AnthropicProbe extends AnthropicAdapter {
  build(messages: ChatMessage[]) { return this.buildMessages(messages); }
  system(messages: ChatMessage[]) { return this.buildSystem(messages); }
}
class GeminiProbe extends GeminiAdapter {
  build(params: SendMessageParams) { return this.buildContents(params); }
}

const openai = new OpenAIProbe(config);
const anthropic = new AnthropicProbe({ ...config, type: 'anthropic' });
const gemini = new GeminiProbe({ ...config, type: 'gemini' });

const exchange: ChatMessage[] = [
  { role: 'system', content: 'be helpful' },
  { role: 'user', content: 'read the file' },
  { role: 'assistant', content: '', tool_calls: [{ id: 'c1', name: 'read_file', arguments: { path: '/a' }, rawArguments: '{"path":"/a"}' }] },
  { role: 'tool', content: 'file body', tool_call_id: 'c1', name: 'read_file' },
  { role: 'assistant', content: 'done' },
];

describe('OpenAI wire format', () => {
  it('reads context and output limits from common API metadata shapes', () => {
    const camelCase = openai.model({
      id: 'camel',
      inputTokenLimit: '262144',
      outputTokenLimit: 16384,
    });
    expect(camelCase.contextWindow).toBe(262144);
    expect(camelCase.maxOutputTokens).toBe(16384);

    const nested = openai.model({
      id: 'nested',
      limits: { maxInputTokens: 1_000_000, maxOutputTokens: 32_000 },
    });
    expect(nested.contextWindow).toBe(1_000_000);
    expect(nested.maxOutputTokens).toBe(32_000);
  });

  it('surfaces reasoning effort levels declared by model metadata', () => {
    const declared = openai.model({
      id: 'efforts',
      supported_parameters: ['reasoning_effort:low', 'reasoning_effort:high'],
    });
    expect(declared.reasoningEfforts).toEqual(['low', 'high']);
    // No metadata → the field stays off so the UI shows the full ladder.
    expect(openai.model({ id: 'quiet' }).reasoningEfforts).toBeUndefined();
  });

  it('encodes assistant tool_calls and tool results', () => {
    const out = openai.clean(exchange);
    const assistant = out[2];
    expect(assistant.tool_calls[0]).toEqual({
      id: 'c1', type: 'function', function: { name: 'read_file', arguments: '{"path":"/a"}' },
    });
    // A tool-only turn must still carry a content field.
    expect(assistant.content).toBeNull();
    expect(out[3]).toEqual({ role: 'tool', tool_call_id: 'c1', content: 'file body' });
  });

  it('serializes arguments when no raw JSON was captured', () => {
    const out = openai.clean([
      { role: 'assistant', content: '', tool_calls: [{ id: 'c', name: 'search', arguments: { query: 'x' } }] },
    ]);
    expect(out[0].tool_calls[0].function.arguments).toBe('{"query":"x"}');
  });

  it('only attaches tools when the caller supplies them', () => {
    expect(openai.tools({ model: 'm', messages: [] }).tools).toBeUndefined();
    const withTools = openai.tools({
      model: 'm', messages: [],
      tools: [{ name: 'read_file', description: 'read', parameters: { type: 'object', properties: {} } }],
    });
    expect(withTools.tools[0].function.name).toBe('read_file');
    expect(withTools.tool_choice).toBe('auto');
  });

  it('assembles fragmented streaming deltas into whole calls', () => {
    // Mirrors how OpenAI streams: id+name first, then arguments in pieces.
    const acc = new Map([
      [0, { id: 'c1', name: 'read_file', args: '{"path":' + '"/a"}' }],
      [1, { id: 'c2', name: 'list_dir', args: '{"path":"/b"}' }],
    ]);
    const calls = openai.finalize(acc);
    expect(calls.map((c: any) => c.function.name)).toEqual(['read_file', 'list_dir']);
    expect(calls[0].function.arguments).toBe('{"path":"/a"}');
  });

  it('drops a call fragment that never received a name', () => {
    expect(openai.finalize(new Map([[0, { id: 'x', name: '', args: '{}' }]]))).toHaveLength(0);
  });
});

describe('Anthropic wire format', () => {
  it('preserves explicit cache breakpoints on stable system blocks', () => {
    const out = anthropic.system([
      { role: 'system', content: 'stable instructions', cacheControl: { type: 'ephemeral' } },
      { role: 'system', content: 'volatile runtime context' },
      { role: 'user', content: 'go' },
    ]);
    expect(out).toEqual([
      { type: 'text', text: 'stable instructions', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'volatile runtime context' },
    ]);
  });

  it('puts tool_use in the assistant turn and tool_result in the next user turn', () => {
    const out = anthropic.build(exchange);
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'read the file' }] });
    expect(out[1].role).toBe('assistant');
    expect(out[1].content[0]).toEqual({ type: 'tool_use', id: 'c1', name: 'read_file', input: { path: '/a' } });
    expect(out[2]).toEqual({ role: 'user', content: [{ type: 'tool_result', tool_use_id: 'c1', content: 'file body' }] });
  });

  it('merges consecutive tool results into one user turn (roles must alternate)', () => {
    const out = anthropic.build([
      { role: 'user', content: 'go' },
      { role: 'assistant', content: '', tool_calls: [
        { id: 'a', name: 'read_file', arguments: { path: '/a' } },
        { id: 'b', name: 'read_file', arguments: { path: '/b' } },
      ] },
      { role: 'tool', content: 'A', tool_call_id: 'a' },
      { role: 'tool', content: 'B', tool_call_id: 'b' },
    ]);
    expect(out).toHaveLength(3);
    expect(out[2].content).toHaveLength(2);
    // No two adjacent turns share a role.
    for (let i = 1; i < out.length; i++) expect(out[i].role).not.toBe(out[i - 1].role);
  });

  it('converts data-URL images into base64 image blocks', () => {
    const out = anthropic.build([
      { role: 'user', content: [
        { type: 'image_url', image_url: { url: 'data:image/png;base64,AAAB' } },
        { type: 'text', text: 'what is this' },
      ] },
    ]);
    expect(out[0].content[0]).toEqual({ type: 'image', source: { type: 'base64', media_type: 'image/png', data: 'AAAB' } });
  });

  it('drops empty text blocks and a leading assistant turn', () => {
    const out = anthropic.build([
      { role: 'assistant', content: 'stale opener' },
      { role: 'user', content: '   ' },
      { role: 'user', content: 'real question' },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toEqual({ role: 'user', content: [{ type: 'text', text: 'real question' }] });
  });
});

describe('Gemini wire format', () => {
  it('uses functionCall / functionResponse parts', () => {
    const { contents, system } = gemini.build({ model: 'm', messages: exchange });
    expect(system).toBe('be helpful');
    expect(contents[1].parts[0]).toEqual({ functionCall: { name: 'read_file', args: { path: '/a' } } });
    expect(contents[2].parts[0]).toEqual({
      functionResponse: { name: 'read_file', response: { result: 'file body' } },
    });
  });

  it('maps assistant turns to the model role and merges same-role turns', () => {
    const { contents } = gemini.build({ model: 'm', messages: [
      { role: 'user', content: 'a' },
      { role: 'assistant', content: 'b' },
      { role: 'assistant', content: 'c' },
    ] });
    expect(contents.map((c: any) => c.role)).toEqual(['user', 'model']);
    expect(contents[1].parts).toHaveLength(2);
  });

  it('inlines image data', () => {
    const { contents } = gemini.build({ model: 'm', messages: [
      { role: 'user', content: [{ type: 'image_url', image_url: { url: 'data:image/jpeg;base64,ZZZ' } }] },
    ] });
    expect(contents[0].parts[0]).toEqual({ inline_data: { mime_type: 'image/jpeg', data: 'ZZZ' } });
  });
});
