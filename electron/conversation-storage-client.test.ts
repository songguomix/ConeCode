import { EventEmitter } from 'node:events';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Message } from '../src/types';
import { ConversationStorageClient } from './conversation-storage-client';

interface Request {
  id: number;
  channel: string;
  args: unknown[];
}

const workers = vi.hoisted(() => [] as Array<EventEmitter & {
  postMessage: ReturnType<typeof vi.fn<(request: Request) => void>>;
  ref: ReturnType<typeof vi.fn>;
  unref: ReturnType<typeof vi.fn>;
  terminate: ReturnType<typeof vi.fn<() => Promise<number>>>;
}>);

vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      postMessage = vi.fn<(request: Request) => void>();
      ref = vi.fn(() => this);
      unref = vi.fn(() => this);
      terminate = vi.fn(async () => 1);

      constructor() {
        super();
        workers.push(this);
      }
    },
  };
});

const clients: ConversationStorageClient[] = [];

function makeClient() {
  const client = new ConversationStorageClient('/fixture/conversation-storage-worker.js', '/fixture/storage');
  clients.push(client);
  return client;
}

async function postedTo(index: number, count: number) {
  await vi.waitFor(() => expect(workers[index]?.postMessage).toHaveBeenCalledTimes(count));
  return workers[index];
}

function message(id: string, conversationId: string): Message {
  return { id, conversationId, role: 'user', content: `Message ${id}`, createdAt: 1 };
}

afterEach(() => {
  for (const client of clients) client.close();
  clients.length = 0;
  workers.length = 0;
});

describe('conversation storage worker client', () => {
  it('matches concurrent requests to out-of-order results by request ID', async () => {
    const client = makeClient();
    const first = client.request('message:list', 'first');
    const second = client.request('message:list', 'second');
    const worker = await postedTo(0, 2);
    expect(workers).toHaveLength(1);
    const [[firstRequest], [secondRequest]] = worker.postMessage.mock.calls;
    expect(firstRequest).toMatchObject({ channel: 'message:list', args: ['first'] });
    expect(secondRequest).toMatchObject({ channel: 'message:list', args: ['second'] });
    expect(firstRequest.id).not.toBe(secondRequest.id);
    expect(client.hasPending).toBe(true);
    expect(worker.ref).toHaveBeenCalled();
    let idleReached = false;
    const idle = client.whenIdle().then(() => { idleReached = true; });

    const firstResult = [message('one', 'first')];
    const secondResult = [message('two', 'second')];
    worker.emit('message', { id: secondRequest.id, ok: true, result: secondResult });
    expect(client.hasPending).toBe(true);
    await Promise.resolve();
    expect(idleReached).toBe(false);
    worker.emit('message', { id: firstRequest.id, ok: true, result: firstResult });

    await expect(Promise.all([first, second])).resolves.toEqual([firstResult, secondResult]);
    await idle;
    expect(client.hasPending).toBe(false);
    expect(worker.unref).toHaveBeenCalled();
  });

  it('rejects just the operation that reports a repository error', async () => {
    const client = makeClient();
    const rejected = expect(client.request('message:list', 'first')).rejects.toThrow('synthetic storage error');
    const successful = client.request('message:list', 'second');
    const worker = await postedTo(0, 2);
    const [[firstRequest], [secondRequest]] = worker.postMessage.mock.calls;
    worker.emit('message', { id: firstRequest.id, ok: false, error: 'synthetic storage error' });
    worker.emit('message', { id: secondRequest.id, ok: true, result: [] });
    await rejected;
    await expect(successful).resolves.toEqual([]);
    expect(worker.terminate).not.toHaveBeenCalled();
  });

  it.each(['error', 'exit'] as const)('rejects in-flight requests on worker %s and restarts on demand without replaying writes', async (failure) => {
    const client = makeClient();
    const persisted = message('write-in-flight', 'thread');
    const read = client.request('message:list', 'thread');
    const write = client.request('message:create', persisted);
    const outcomes = Promise.allSettled([read, write]);
    const failedWorker = await postedTo(0, 2);
    expect(failedWorker.postMessage.mock.calls.map(([request]) => request.channel)).toEqual(['message:list', 'message:create']);

    // The worker may have applied this write before it was lost. Neither a
    // crash nor an exit acknowledges whether the operation reached storage.
    let finishTermination: ((code: number) => void) | undefined;
    if (failure === 'error') {
      failedWorker.terminate.mockReturnValueOnce(new Promise((resolve) => { finishTermination = resolve; }));
      failedWorker.emit('error', new Error('synthetic worker failure'));
    } else {
      failedWorker.emit('exit', 9);
    }
    const rejected = await outcomes;
    expect(rejected).toEqual([
      { status: 'rejected', reason: expect.any(Error) },
      { status: 'rejected', reason: expect.any(Error) },
    ]);
    expect(workers).toHaveLength(1);

    const recovered = client.request('message:list', 'thread');
    if (finishTermination) {
      await Promise.resolve();
      expect(workers).toHaveLength(1);
      finishTermination(9);
    }
    const replacement = await postedTo(1, 1);
    const [[recoveryRequest]] = replacement.postMessage.mock.calls;
    expect(recoveryRequest).toMatchObject({ channel: 'message:list', args: ['thread'] });

    failedWorker.emit('message', { id: recoveryRequest.id, ok: true, result: [] });
    if (failure === 'error') failedWorker.emit('exit', 9);
    replacement.emit('message', { id: recoveryRequest.id, ok: true, result: [persisted] });
    await expect(recovered).resolves.toEqual([persisted]);

    const submittedWrites = workers.flatMap((worker) => worker.postMessage.mock.calls
      .map(([request]) => request)
      .filter((request) => request.channel === 'message:create'));
    expect(submittedWrites).toHaveLength(1);
  });

  it('settles pending requests on close and rejects later work without starting another worker', async () => {
    const client = makeClient();
    const pending = expect(client.request('conversation:list')).rejects.toBeInstanceOf(Error);
    const worker = await postedTo(0, 1);
    client.close();
    await pending;
    await expect(client.request('conversation:list')).rejects.toBeInstanceOf(Error);
    expect(workers).toHaveLength(1);
    expect(worker.terminate).toHaveBeenCalledOnce();
  });
});
