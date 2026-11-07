import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { OpenAICompatibleAdapter } from '../src/model/openai-compat.js';

let server: Server;
let baseUrl: string;
let calls = 0;
let lastBody: any;

beforeAll(async () => {
  server = createServer(async (req, res) => {
    calls += 1;
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    lastBody = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    res.setHeader('content-type', 'application/json');
    if (calls === 1) {
      res.statusCode = 429;
      res.end(JSON.stringify({ error: { message: 'rate limited' } }));
      return;
    }
    if (lastBody.tool_choice === 'auto' && lastBody.tools?.length) {
      res.end(
        JSON.stringify({
          choices: [
            {
              finish_reason: 'tool_calls',
              message: {
                content: null,
                tool_calls: [
                  { id: 'call_1', type: 'function', function: { name: 'browser_click', arguments: '{"targetId":"1:main:1"}' } },
                ],
              },
            },
          ],
          usage: { prompt_tokens: 100, completion_tokens: 20 },
        }),
      );
      return;
    }
    res.end(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: 'done' } }], usage: { prompt_tokens: 1, completion_tokens: 1 } }));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('no address');
  baseUrl = `http://127.0.0.1:${address.port}`;
});
afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()));
});

describe('OpenAI-compatible model adapter', () => {
  it('sends typed tool definitions and parses tool calls, usage and cost', async () => {
    const adapter = new OpenAICompatibleAdapter({
      model: 'test-model',
      baseUrl,
      apiKey: 'test-key',
      maxRetries: 2,
      pricing: { inputPerMillionUsd: 1, outputPerMillionUsd: 2 },
    });
    const response = await adapter.complete({
      messages: [{ role: 'user', content: 'click save' }],
      tools: [{ name: 'browser_click', description: 'click', parameters: { type: 'object', properties: {} } }],
    });
    expect(calls).toBe(2); // 429 then retry
    expect(lastBody.model).toBe('test-model');
    expect(lastBody.tools[0].function.name).toBe('browser_click');
    expect(response.toolCalls[0]).toMatchObject({ id: 'call_1', name: 'browser_click' });
    expect(response.toolCalls[0]!.arguments).toContain('targetId');
    expect(response.usage.inputTokens).toBe(100);
    expect(response.usage.outputTokens).toBe(20);
    expect(response.usage.costUsd).toBeCloseTo(0.00014, 10);
    expect(adapter.capabilities().nativeComputerActions).toBe(false);
  });

  it('converts image content only when configured, and reports capability explicitly', async () => {
    calls = 10;
    const adapter = new OpenAICompatibleAdapter({
      model: 'vision-test',
      baseUrl,
      apiKey: 'test-key',
      capabilities: { images: true },
      tokenParameter: 'max_completion_tokens',
    });
    const response = await adapter.complete({
      messages: [
        {
          role: 'user',
          content: [
            { type: 'text', text: 'look' },
            { type: 'image', dataUrl: 'data:image/png;base64,AAAA', detail: 'high' },
          ],
        },
      ],
      tools: [],
    });
    expect(response.text).toBe('done');
    expect(lastBody.messages[0].content[1].type).toBe('image_url');
    expect(lastBody.max_completion_tokens).toBe(2_000);
    expect(lastBody.max_tokens).toBeUndefined();
    expect(adapter.capabilities().images).toBe(true);
  });

  it('fails clearly when a real credential is missing', async () => {
    const adapter = new OpenAICompatibleAdapter({ model: 'missing', baseUrl, apiKeyEnv: 'CUA_TEST_MISSING_KEY_12345' });
    await expect(
      adapter.complete({ messages: [{ role: 'user', content: 'hi' }], tools: [] }),
    ).rejects.toMatchObject({ code: 'MODEL_CAPABILITY_MISSING' });
  });

  it('rejects unconfigured image/structured capabilities before making a provider request', async () => {
    const adapter = new OpenAICompatibleAdapter({ model: 'test-model', baseUrl, apiKey: 'test-key' });
    const before = calls;
    await expect(adapter.complete({ messages: [{ role: 'user', content: [{ type: 'image', dataUrl: 'data:image/png;base64,AAAA' }] }], tools: [] }))
      .rejects.toMatchObject({ code: 'MODEL_CAPABILITY_MISSING' });
    await expect(adapter.complete({ messages: [], tools: [], responseFormat: { type: 'json_object' } }))
      .rejects.toMatchObject({ code: 'MODEL_CAPABILITY_MISSING' });
    expect(calls).toBe(before);
    expect(adapter.capabilities().structuredOutput).toBe(false);
  });

  it('omits tool and sampling fields for a text-only request', async () => {
    const adapter = new OpenAICompatibleAdapter({ model: 'test-model', baseUrl, apiKey: 'test-key' });
    await adapter.complete({ messages: [{ role: 'user', content: 'ready' }], tools: [] });
    expect(lastBody.tools).toBeUndefined();
    expect(lastBody.tool_choice).toBeUndefined();
    expect(lastBody.temperature).toBeUndefined();
    expect(lastBody.max_completion_tokens).toBe(2000);
  });

  it('cancels provider backoff without sending another request', async () => {
    calls = 0;
    const adapter = new OpenAICompatibleAdapter({ model: 'test-model', baseUrl, apiKey: 'test-key', maxRetries: 3 });
    const abort = new AbortController();
    const pending = adapter.complete({ messages: [{ role: 'user', content: 'ready' }], tools: [] }, abort.signal);
    const timer = setTimeout(() => abort.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: 'CANCELLED' });
    clearTimeout(timer);
    expect(calls).toBe(1);
  });

  const realEnabled = Boolean(process.env.OPENAI_API_KEY && process.env.CUA_REAL_MODEL) && process.env.CUA_RUN_REAL_MODEL === '1';
  it.skipIf(!realEnabled)('real model smoke call (explicitly enabled)', async () => {
    const adapter = new OpenAICompatibleAdapter({
      model: process.env.CUA_REAL_MODEL!,
      baseUrl: process.env.OPENAI_BASE_URL,
      apiKeyEnv: 'OPENAI_API_KEY',
      capabilities: { images: false },
      maxRetries: 0,
    });
    const response = await adapter.complete({
      messages: [{ role: 'user', content: 'Reply with the single word: ready' }],
      tools: [],
      maxOutputTokens: 20,
    });
    expect(response.text?.toLowerCase()).toContain('ready');
  });
});
