import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { BaseAdapter } from './base.adapter';
import { OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { buildToolset } from '../tools/definitions';
import { buildApiMessages } from '../../stores/chat.store';
import type { ProviderConfig } from '../../types';

// Runs the adapters against a REAL HTTP server so the request body and the SSE
// parsing are verified over the wire, not against a mock of our own shape.

let server: http.Server;
let baseUrl: string;
let lastBody: any = null;
let respondWith: (res: http.ServerResponse) => void = () => {};

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      try { lastBody = JSON.parse(Buffer.concat(chunks).toString() || '{}'); } catch { lastBody = null; }
      respondWith(res);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

function sse(res: http.ServerResponse, lines: string[]) {
  res.writeHead(200, { 'Content-Type': 'text/event-stream' });
  for (const l of lines) res.write(`data: ${l}\n\n`);
  res.end();
}

const config = (over: Partial<ProviderConfig> = {}): ProviderConfig => ({
  id: 'p', name: 'local', type: 'openai', baseUrl, apiKey: 'k',
  defaultModel: 'm', timeout: 5000, enabled: true, createdAt: 0, updatedAt: 0, ...over,
});

const tools = buildToolset().filter((t) => ['read_file', 'exec'].includes(t.name));

class ProbeAdapter extends BaseAdapter {
  async listModels(): Promise<any[]> { return []; }
  async sendMessage(): Promise<any> { return {}; }
  async streamMessage(): Promise<any> { return {}; }
  async validateApiKey(): Promise<boolean> { return true; }
  async read(response: Response, signal: AbortSignal | undefined, idleMs: number): Promise<string> {
    return this.consumeStream(response, () => {}, signal, idleMs);
  }
}

describe('stream idle timeout', () => {
  it('raises a retryable error when the response goes idle', async () => {
    const adapter = new ProbeAdapter(config());
    const response = new Response(new ReadableStream({
      start(controller) { controller.enqueue(new TextEncoder().encode('partial')); },
    }));

    await expect(adapter.read(response, undefined, 10)).rejects.toThrow('Stream idle timeout after 10ms');
  });

  it('keeps a user abort distinct from an idle timeout', async () => {
    const adapter = new ProbeAdapter(config());
    const controller = new AbortController();
    const response = new Response(new ReadableStream({
      start(stream) { setTimeout(() => { controller.abort(); stream.close(); }, 10); },
    }));

    await expect(adapter.read(response, controller.signal, 1000)).resolves.toBe('');
  });
});

describe('OpenAI over the wire', () => {
  it('puts the tool schemas in the request body', async () => {
    respondWith = (res) => sse(res, ['{"choices":[{"delta":{"content":"hi"}}]}', '[DONE]']);
    const adapter = new OpenAIAdapter(config());
    await adapter.streamMessage({ model: 'm', messages: [{ role: 'user', content: 'hi' }], tools }, () => {});

    expect(lastBody.tools).toHaveLength(2);
    expect(lastBody.tools[0]).toMatchObject({ type: 'function', function: { name: 'read_file' } });
    expect(lastBody.tools[0].function.parameters.required).toEqual(['path']);
    expect(lastBody.tool_choice).toBe('auto');
  });

  it('omits the tools field entirely when none are given', async () => {
    respondWith = (res) => sse(res, ['{"choices":[{"delta":{"content":"hi"}}]}', '[DONE]']);
    await new OpenAIAdapter(config()).streamMessage({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }, () => {});
    expect(lastBody).not.toHaveProperty('tools');
  });

  it('rejects a stream that closes without a completion marker', async () => {
    respondWith = (res) => sse(res, ['{"choices":[{"delta":{"content":"partial"}}]}']);
    await expect(new OpenAIAdapter(config()).streamMessage(
      { model: 'm', messages: [{ role: 'user', content: 'continue' }] }, () => {},
    )).rejects.toThrow('Incomplete model stream');
  });

  it('reassembles a tool call split across SSE deltas', async () => {
    // Exactly how OpenAI streams it: id+name first, then the arguments in pieces.
    respondWith = (res) => sse(res, [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"call_x","type":"function","function":{"name":"read_file","arguments":""}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"{\\"pa"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"th\\":\\"/a.ts\\"}"}}]}}]}',
      '{"choices":[{"finish_reason":"tool_calls","delta":{}}]}',
      '[DONE]',
    ]);
    const seen: string[] = [];
    const result: any = await new OpenAIAdapter(config()).streamMessage(
      { model: 'm', messages: [{ role: 'user', content: 'read it' }], tools },
      (c) => { if (c.type === 'tool_call' && c.toolName) seen.push(c.toolName); },
    );

    const call = result.choices[0].message.tool_calls[0];
    expect(call.id).toBe('call_x');
    expect(call.function.name).toBe('read_file');
    expect(JSON.parse(call.function.arguments)).toEqual({ path: '/a.ts' });
    expect(result.choices[0].finish_reason).toBe('tool_calls');
    // The UI is told which tool is being called while the args still stream.
    expect(seen).toEqual(['read_file']);
  });

  it('keeps two parallel tool calls separate', async () => {
    respondWith = (res) => sse(res, [
      '{"choices":[{"delta":{"tool_calls":[{"index":0,"id":"a","function":{"name":"read_file","arguments":"{\\"path\\":\\"/a\\"}"}}]}}]}',
      '{"choices":[{"delta":{"tool_calls":[{"index":1,"id":"b","function":{"name":"exec","arguments":"{\\"command\\":\\"ls\\"}"}}]}}]}',
      '[DONE]',
    ]);
    const result: any = await new OpenAIAdapter(config()).streamMessage(
      { model: 'm', messages: [{ role: 'user', content: 'go' }], tools }, () => {},
    );
    const calls = result.choices[0].message.tool_calls;
    expect(calls.map((c: any) => [c.id, c.function.name])).toEqual([['a', 'read_file'], ['b', 'exec']]);
  });
});

describe('Anthropic over the wire', () => {
  it('sends input_schema tools and parses streamed tool_use', async () => {
    respondWith = (res) => sse(res, [
      '{"type":"message_start","message":{"usage":{"input_tokens":10}}}',
      '{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"read_file"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"path\\":"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\\"/a.ts\\"}"}}',
      '{"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":5}}',
      '{"type":"message_stop"}',
    ]);

    const result: any = await new AnthropicAdapter(config({ type: 'anthropic' })).streamMessage(
      { model: 'm', messages: [{ role: 'user', content: 'read it' }], tools }, () => {},
    );

    expect(lastBody.tools[0]).toMatchObject({ name: 'read_file' });
    expect(lastBody.tools[0].input_schema.type).toBe('object');
    expect(lastBody.tool_choice).toEqual({ type: 'auto' });
    expect(lastBody.cache_control).toEqual({ type: 'ephemeral' });

    const toolUse = result.content.find((b: any) => b.type === 'tool_use');
    expect(toolUse).toMatchObject({ id: 'toolu_1', name: 'read_file', input: { path: '/a.ts' } });
    expect(result.stop_reason).toBe('tool_use');
    expect(result.usage.output_tokens).toBe(5);
  });

  it('sends stable and volatile system blocks separately', async () => {
    respondWith = (res) => sse(res, ['{"type":"message_stop"}']);

    await new AnthropicAdapter(config({ type: 'anthropic' })).streamMessage({
      model: 'm',
      messages: [
        { role: 'system', content: 'stable', cacheControl: { type: 'ephemeral' } },
        { role: 'system', content: 'runtime A' },
        { role: 'user', content: 'go' },
      ],
    }, () => {});

    expect(lastBody.system).toEqual([
      { type: 'text', text: 'stable', cache_control: { type: 'ephemeral' } },
      { type: 'text', text: 'runtime A' },
    ]);
  });
});

describe('Gemini over the wire', () => {
  it('sends functionDeclarations and parses a functionCall part', async () => {
    respondWith = (res) => sse(res, [
      '{"candidates":[{"content":{"parts":[{"text":"looking"},{"functionCall":{"name":"read_file","args":{"path":"/a.ts"}}}]},"finishReason":"STOP"}],"usageMetadata":{"totalTokenCount":42}}',
    ]);

    const result: any = await new GeminiAdapter(config({ type: 'gemini' })).streamMessage(
      { model: 'm', messages: [{ role: 'user', content: 'read it' }], tools }, () => {},
    );

    const decls = lastBody.tools[0].functionDeclarations;
    expect(decls.map((d: any) => d.name).sort()).toEqual(['exec', 'read_file']);
    expect(lastBody.toolConfig.functionCallingConfig.mode).toBe('AUTO');

    const parts = result.candidates[0].content.parts;
    expect(parts.find((p: any) => p.functionCall)).toMatchObject({
      functionCall: { name: 'read_file', args: { path: '/a.ts' } },
    });
    // Text that arrived alongside the call is not lost.
    expect(parts.find((p: any) => p.text)?.text).toBe('looking');
    expect(result.usageMetadata.totalTokenCount).toBe(42);
  });
});

describe('Anthropic extended thinking + tools', () => {
  it('replays signed thinking blocks so the tool_result turn is accepted', async () => {
    // Anthropic REJECTS a tool_result follow-up whose assistant turn dropped its
    // thinking blocks. With thinking on by default at medium effort, losing them
    // broke every Claude tool sequence on its second turn.
    respondWith = (res) => sse(res, ['{"type":"message_stop"}']);

    await new AnthropicAdapter(config({ type: 'anthropic' })).streamMessage({
      model: 'm',
      reasoningEffort: 'medium',
      tools,
      messages: [
        { role: 'user', content: 'read it' },
        {
          role: 'assistant', content: '',
          tool_calls: [{ id: 'tu1', name: 'read_file', arguments: { path: '/a.ts' } }],
          thinking_blocks: [{ thinking: 'I should read the file', signature: 'sig-abc' }],
        },
        { role: 'tool', content: 'file body', tool_call_id: 'tu1' },
      ],
    }, () => {});

    const assistant = lastBody.messages[1];
    expect(assistant.content[0]).toEqual({ type: 'thinking', thinking: 'I should read the file', signature: 'sig-abc' });
    expect(assistant.content.some((b: any) => b.type === 'tool_use')).toBe(true);
  });

  it('omits thinking blocks when extended thinking is off', async () => {
    // Sending them with thinking disabled is itself an error.
    respondWith = (res) => sse(res, ['{"type":"message_stop"}']);
    await new AnthropicAdapter(config({ type: 'anthropic' })).streamMessage({
      model: 'm',
      reasoningEffort: 'low',
      messages: [
        { role: 'user', content: 'go' },
        { role: 'assistant', content: 'ok', thinking_blocks: [{ thinking: 't', signature: 's' }] },
      ],
    }, () => {});
    expect(lastBody.messages[1].content.some((b: any) => b.type === 'thinking')).toBe(false);
  });

  it('captures thinking text and signature off the stream', async () => {
    respondWith = (res) => sse(res, [
      '{"type":"content_block_start","index":0,"content_block":{"type":"thinking","thinking":""}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"thinking_delta","thinking":"step one"}}',
      '{"type":"content_block_delta","index":0,"delta":{"type":"signature_delta","signature":"sig123"}}',
      '{"type":"message_stop"}',
    ]);
    const result: any = await new AnthropicAdapter(config({ type: 'anthropic' })).streamMessage(
      { model: 'm', reasoningEffort: 'medium', messages: [{ role: 'user', content: 'go' }] }, () => {},
    );
    expect(result.thinking_blocks).toEqual([{ thinking: 'step one', signature: 'sig123' }]);
  });
});

describe('a compacted history reaches the provider', () => {
  // Regression: the summary used to go in as an ASSISTANT turn, which made it
  // the first message once everything before it was covered — and both these
  // providers drop a leading assistant turn, so the model was handed an empty
  // history right after /compact.
  const compacted = buildApiMessages([
    { id: 'm1', conversationId: 'c', role: 'user', content: 'the original conversation', createdAt: 0 },
    { id: 'm2', conversationId: 'c', role: 'assistant', content: 'lots of prior work', createdAt: 0 },
    { id: 's', conversationId: 'c', role: 'assistant', content: 'SUMMARY: we built the parser', createdAt: 0, isSummary: true, summaryUpToId: 'm2' },
  ] as any);

  it('Anthropic gets the summary, and never an empty message list', async () => {
    respondWith = (res) => sse(res, ['{"type":"message_stop"}']);
    await new AnthropicAdapter(config({ type: 'anthropic' })).streamMessage(
      { model: 'm', messages: compacted }, () => {},
    );
    expect(JSON.stringify(lastBody.system)).toContain('SUMMARY: we built the parser');
    expect(lastBody.messages.length).toBeGreaterThan(0);
    expect(lastBody.messages[0].role).toBe('user');
  });

  it('Gemini gets the summary, and never an empty contents list', async () => {
    respondWith = (res) => sse(res, ['{"candidates":[{"content":{"parts":[{"text":"ok"}]}}]}']);
    await new GeminiAdapter(config({ type: 'gemini' })).streamMessage(
      { model: 'm', messages: compacted }, () => {},
    );
    expect(JSON.stringify(lastBody.systemInstruction)).toContain('SUMMARY: we built the parser');
    expect(lastBody.contents.length).toBeGreaterThan(0);
    expect(lastBody.contents[0].role).toBe('user');
  });

  it('OpenAI gets the summary as a system message', async () => {
    respondWith = (res) => sse(res, ['{"choices":[{"delta":{"content":"ok"}}]}', '[DONE]']);
    await new OpenAIAdapter(config()).streamMessage({ model: 'm', messages: compacted }, () => {});
    const system = lastBody.messages.filter((m: any) => m.role === 'system').map((m: any) => m.content).join('');
    expect(system).toContain('SUMMARY: we built the parser');
  });
});
