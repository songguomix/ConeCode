import { describe, expect, it } from 'vitest';
import { CuaClient } from '../src/sdk.js';
import { newId } from '../src/protocol/ids.js';
import { nowIso } from '../src/protocol/schemas.js';

function streamingClient(chunks: string[]) {
  const encoder = new TextEncoder();
  return new CuaClient({
    baseUrl: 'http://127.0.0.1:4317', token: 'test',
    fetchImpl: (async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
        controller.close();
      },
    }), { headers: { 'content-type': 'text/event-stream' } })) as typeof fetch,
  });
}

describe('SDK event stream protocol', () => {
  it('reads valid CRLF events even when the frame separator is split across chunks', async () => {
    const event = { schemaVersion: 1, seq: 7, id: newId('evt'), type: 'task.status', at: nowIso(), actor: 'system', payload: { status: 'paused' } };
    const stream = streamingClient([`: heartbeat\r\n\r\nid: 7\r\ndata: ${JSON.stringify(event)}\r`, '\n\r', '\n']).stream(undefined);
    expect(await stream.next()).toEqual({ done: false, value: event });
    expect((await stream.next()).done).toBe(true);
  });

  it('reports server error frames rather than yielding them as successful events', async () => {
    const stream = streamingClient(['event: error\ndata: {"message":"event poll failed"}\n\n']).stream(undefined);
    await expect(stream.next()).rejects.toMatchObject({ code: 'SSE_ERROR' });
  });

  it('rejects invalid JSON and invalid versioned event payloads', async () => {
    for (const payload of ['{not json}', '{"schemaVersion":99,"seq":1}']) {
      const stream = streamingClient([`data: ${payload}\n\n`]).stream(undefined);
      await expect(stream.next()).rejects.toMatchObject({ code: 'PROTOCOL_INVALID' });
    }
  });
});
