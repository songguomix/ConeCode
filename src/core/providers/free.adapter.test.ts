import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeAdapter, FREE_PROVIDER, freeStatus } from './free.adapter';
import { ProviderRegistry } from './registry';

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
describe('ConeCode Free boundary', () => {
  it('ignores any client supplied URL/key and exposes model names from server status', async () => {
    const fetcher = vi.fn(async (_url: string, _options?: RequestInit) => new Response(JSON.stringify({ available: true, mode: 'on', models: [{ id: 'gift', name: 'Gift' }], apiKey: 'never-accept', upstreamUrl: 'https://private.test' })));
    vi.stubGlobal('fetch', fetcher);
    const registry = new ProviderRegistry();
    registry.register({ ...FREE_PROVIDER, baseUrl: 'https://attacker.test', apiKey: 'bad-key' });
    const models = await registry.getModelsForProvider(FREE_PROVIDER.id);
    expect(models[0].name).toBe('Gift');
    expect(fetcher.mock.calls[0][0]).toBe('https://conellm.cc.cd/status');
    expect(JSON.stringify(await freeStatus())).not.toMatch(/private|never-accept/);
    expect(registry.getAdapter(FREE_PROVIDER.id).config.apiKey).toBe('');
  });

  it('shares live status and model requests and uses the same transport for chat', async () => {
    const fetcher = vi.fn(async (_url: string, _options: RequestInit) => Response.json({
      available: true, models: [{ id: 'gift', name: 'Gift' }],
    }));
    const registry = new ProviderRegistry(fetcher);
    registry.register(FREE_PROVIDER);
    const adapter = registry.getAdapter(FREE_PROVIDER.id) as FreeAdapter;

    const [catalog, models] = await Promise.all([adapter.loadCatalog(), adapter.listModels()]);
    expect(catalog.status.models.map((model) => model.id)).toEqual(['gift']);
    expect(models).toEqual(catalog.models);
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`${FREE_PROVIDER.baseUrl}/status`, expect.objectContaining({
      cache: 'no-store', credentials: 'omit', redirect: 'error', signal: expect.any(AbortSignal),
    }));

    fetcher.mockResolvedValueOnce(Response.json({ available: false }));
    await expect(adapter.listModels()).resolves.toEqual([]);

    fetcher.mockResolvedValueOnce(Response.json({ choices: [{ message: { content: 'hello' } }] }));
    await expect(adapter.sendMessage({ model: 'gift', messages: [] })).resolves.toHaveProperty('choices');
    expect(fetcher).toHaveBeenLastCalledWith(`${FREE_PROVIDER.baseUrl}/v1/chat/completions`, expect.objectContaining({
      method: 'POST', credentials: 'omit', redirect: 'error', headers: { 'Content-Type': 'application/json' },
    }));
  });

  it('hides network and upstream response errors, including streamed errors', async () => {
    const adapter = new FreeAdapter(FREE_PROVIDER);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('https://private.test sk-secret', { status: 500 })));
    await expect(adapter.sendMessage({ model: 'gift', messages: [] })).rejects.toThrow('ConeCode Free');
    await expect(adapter.streamMessage({ model: 'gift', messages: [] }, () => {})).rejects.not.toThrow(/private|sk-secret|https?:/);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"error":{"message":"https://private.test sk-secret"}}\n\ndata: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } })));
    const chunks: unknown[] = [];
    await expect(adapter.streamMessage({ model: 'gift', messages: [] }, (c) => chunks.push(c))).rejects.toThrow('ConeCode Free');
    expect(JSON.stringify(chunks)).not.toMatch(/private|sk-secret/);
  });
  it('cancels and releases a stream immediately when a server-side SSE error arrives', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode('data: {"error":{"message":"private failure"}}\n\n')); },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    await expect(new FreeAdapter(FREE_PROVIDER).streamMessage({ model: 'gift', messages: [] }, () => {})).rejects.toThrow('ConeCode Free');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
  it('returns no models when closed and preserves user cancellation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({ available: false, models: [{ id: 'stale' }] }))));
    expect(await new FreeAdapter(FREE_PROVIDER).listModels()).toEqual([]);
    const controller = new AbortController();
    controller.abort();
    vi.stubGlobal('fetch', vi.fn(async () => { throw new DOMException('Aborted', 'AbortError'); }));
    await expect(new FreeAdapter(FREE_PROVIDER).streamMessage({ model: 'gift', messages: [] }, () => {}, controller.signal)).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('uses the website vision flag in both directions, even for familiar model names', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      available: true, mode: 'on', models: [
        { id: 'custom-picture-model', name: 'Custom', supportsVision: true },
        { id: 'gpt-4o', name: 'Text only', supportsVision: false },
        { id: 'gemini-legacy', name: 'Legacy' },
      ],
    }))));
    const models = await new FreeAdapter(FREE_PROVIDER).listModels();
    expect(models.map((m) => m.supportsVision)).toEqual([true, false, false]);
  });

  it.each([400, 401, 403, 404, 413, 422, 429, 502, 503, 504])('preserves HTTP %s without displaying upstream details', async (status) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { message: 'https://private.test sk-secret' },
    }), { status })));
    const failure = await new FreeAdapter(FREE_PROVIDER).streamMessage({ model: 'gift', messages: [] }, () => {}).catch((e) => e);
    expect(failure.message).toContain(`HTTP ${status}`);
    expect(failure.message).not.toMatch(/private|sk-secret|https?:/);
  });

  it('retains a safe unsupported-tools signal for prompt-mode fallback, including SSE errors', async () => {
    const error = { error: { code: 'free_tools_unsupported', message: 'sk-secret https://private.test' } };
    const adapter = new FreeAdapter(FREE_PROVIDER);
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify(error), { status: 400 })));
    await expect(adapter.streamMessage({ model: 'gift', messages: [] }, () => {})).rejects.toThrow('tools are not supported');
    vi.stubGlobal('fetch', vi.fn(async () => new Response(`data: ${JSON.stringify(error)}\n\n`)));
    const failure = await adapter.streamMessage({ model: 'gift', messages: [] }, () => {}).catch((e) => e);
    expect(failure.message).toContain('tools are not supported');
    expect(failure.message).not.toMatch(/sk-secret|private/);
  });

  it('keeps permanent SSE failures permanent despite the HTTP 200 stream response', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"error":{"code":"free_unavailable","status":401,"message":"sk-secret"}}\n\n')));
    const failure = await new FreeAdapter(FREE_PROVIDER).streamMessage({ model: 'gift', messages: [] }, () => {}).catch((e) => e);
    expect(failure.message).toContain('HTTP 401');
    expect(failure.message).not.toContain('sk-secret');
  });

  it.each([
    ['relay_concurrency', 'relay', '当前并发已满'],
    ['relay_rate_limit', 'relay', '当前请求频率已达限制'],
    ['upstream', 'upstream', '上游模型服务限流'],
  ] as const)('preserves a safe %s cooldown through the IPC message', async (reason, source, message) => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'free_rate_limited', status: 429, reason, source, retryAfterMs: 45000, message: 'https://private.test sk-secret' },
    }), { status: 429 })));
    const failure = await new FreeAdapter(FREE_PROVIDER).streamMessage({ model: 'gift', messages: [] }, () => {}).catch((e) => e);
    // Electron transmits this message, not custom Error properties.
    const ipcFailure = new Error(`Error invoking remote method 'chat:stream': ${failure.message}`);
    expect(ipcFailure.message).toContain(message);
    expect(ipcFailure.message).toContain('HTTP 429');
    expect(ipcFailure.message).toContain('[Retry-After-Ms: 45000]');
    expect(ipcFailure.message).not.toMatch(/private|sk-secret|https?:/);
  });

  it.each([
    ['45', undefined, 45000],
    ['Wed, 18 Nov 2026 00:01:00 GMT', undefined, 60000],
    ['30', 90000, 90000],
    ['90', 30000, 90000],
    ['3600', undefined, 3600000],
    ['0', undefined, 0],
  ] as const)('reads Retry-After %s and never shortens a longer body cooldown', async (header, bodyDelay, expected) => {
    vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-11-18T00:00:00Z'));
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'free_rate_limited', retryAfterMs: bodyDelay },
    }), { status: 429, headers: { 'retry-after': header } })));
    const failure = await new FreeAdapter(FREE_PROVIDER).sendMessage({ model: 'gift', messages: [] }).catch((e) => e);
    expect(failure.message).toContain(`[Retry-After-Ms: ${expected}]`);
  });

  it('keeps Retry-After on a non-JSON proxy error and ignores malformed metadata', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('https://private.test sk-secret', {
      status: 429, headers: { 'retry-after': '60' },
    })));
    const adapter = new FreeAdapter(FREE_PROVIDER);
    const proxyFailure = await adapter.sendMessage({ model: 'gift', messages: [] }).catch((e) => e);
    expect(proxyFailure.message).toContain('[Retry-After-Ms: 60000]');
    expect(proxyFailure.message).not.toMatch(/private|sk-secret|https?:/);

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { code: 'free_rate_limited', source: 'sk-secret', reason: 'https://private.test', retryAfterMs: '1000] sk-secret' },
    }), { status: 429, headers: { 'retry-after': '-1' } })));
    const invalidFailure = await adapter.sendMessage({ model: 'gift', messages: [] }).catch((e) => e);
    expect(invalidFailure.message).toContain('请求过于频繁');
    expect(invalidFailure.message).not.toMatch(/Retry-After-Ms|private|sk-secret|https?:/);
  });

  it('retains a streamed 429 cooldown and does not apply it to other statuses', async () => {
    const adapter = new FreeAdapter(FREE_PROVIDER);
    vi.stubGlobal('fetch', vi.fn(async () => new Response('data: {"error":{"code":"free_rate_limited","status":429,"source":"upstream","retryAfterMs":90000}}\n\n')));
    const limited = await adapter.streamMessage({ model: 'gift', messages: [] }, () => {}).catch((e) => e);
    expect(limited.message).toContain('上游模型服务限流');
    expect(limited.message).toContain('[Retry-After-Ms: 90000]');

    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      error: { status: 503, retryAfterMs: 90000 },
    }), { status: 503, headers: { 'retry-after': '90' } })));
    const unavailable = await adapter.sendMessage({ model: 'gift', messages: [] }).catch((e) => e);
    expect(unavailable.message).toContain('HTTP 503');
    expect(unavailable.message).not.toContain('Retry-After-Ms');
  });

  it('rejects oversized UTF-8 requests locally using the website limit', async () => {
    const fetcher = vi.fn(async () => new Response(JSON.stringify({
      available: true, models: [{ id: 'gift', name: 'Gift' }],
      limits: { maxRequestBytes: 300, streamIdleTimeoutMs: 120000 },
    })));
    vi.stubGlobal('fetch', fetcher);
    const adapter = new FreeAdapter(FREE_PROVIDER);
    await adapter.listModels();
    await expect(adapter.sendMessage({ model: 'gift', messages: [{ role: 'user', content: '图'.repeat(100) }] })).rejects.toThrow('请求过大');
    expect(fetcher).toHaveBeenCalledOnce();
  });

  it('finishes and cancels the reader at DONE even when the upstream leaves the connection open', async () => {
    const cancel = vi.fn();
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('data: {"choices":[{"delta":{"content":"finished"},"finish_reason":"stop"}]}\n\ndata: [DONE]\n\n'));
      },
      cancel,
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
    const result = await new FreeAdapter(FREE_PROVIDER).streamMessage({ model: 'gift', messages: [] }, () => {});
    expect(result.choices[0].message.content).toBe('finished');
    expect(cancel).toHaveBeenCalledOnce();
    expect(body.locked).toBe(false);
  });
});
