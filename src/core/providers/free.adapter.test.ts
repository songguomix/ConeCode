import { afterEach, describe, expect, it, vi } from 'vitest';
import { FreeAdapter, FREE_PROVIDER, freeStatus } from './free.adapter';
import { ProviderRegistry } from './registry';

afterEach(() => vi.unstubAllGlobals());
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
});
