import { EventEmitter } from 'node:events';
import { afterEach, expect, it, vi } from 'vitest';
import { DshRuntimeManager } from './runtime-manager';

const workers = vi.hoisted(() => [] as Array<EventEmitter & {
  terminate: ReturnType<typeof vi.fn>;
  postMessage: ReturnType<typeof vi.fn>;
}>);
vi.mock('node:worker_threads', async () => {
  const { EventEmitter } = await import('node:events');
  return {
    Worker: class extends EventEmitter {
      terminate = vi.fn(async () => 1);
      postMessage = vi.fn(({ id, type }) => {
        if (type === 'init' || type === 'shutdown') queueMicrotask(() => this.emit('message', {
          id, ok: true, result: { llmReady: true, storage: { ready: true } },
        }));
      });
      constructor() { super(); workers.push(this); }
    },
  };
});
afterEach(() => { vi.useRealTimers(); workers.length = 0; });

it('retires an unresponsive worker and ignores late errors and exits after restart', async () => {
  const manager = new DshRuntimeManager();
  vi.spyOn(manager as any, 'locateWorker').mockReturnValue('/worker.js');
  await Promise.all([manager.ensureStarted('a', '/first'), manager.ensureStarted('a', '/first', true)]);
  expect(workers).toHaveLength(1);
  const first = workers[0];
  vi.useFakeTimers();
  const stalled = expect(manager.contributions()).rejects.toThrow('timed out');
  const other = expect(manager.listSkills()).rejects.toThrow('timed out');
  await vi.advanceTimersByTimeAsync(30_000);
  await Promise.all([stalled, other]);
  vi.useRealTimers();
  expect(first.terminate).toHaveBeenCalledOnce();
  expect(manager.getInfo()).toMatchObject({ available: false, llmReady: false, storage: { ready: false } });

  await manager.ensureStarted('b', '/next');
  const second = workers[1];
  const pending = manager.listSkills();
  first.emit('error', new Error('late error'));
  first.emit('exit', 1);
  expect(manager.getInfo()).toMatchObject({ available: true, llmReady: true, profileId: 'b', lastError: null });
  const [{ id }] = second.postMessage.mock.lastCall!;
  second.emit('message', { id, ok: true, result: [] });
  expect(await pending).toEqual([]);
  await manager.shutdown();
  expect(second.terminate).toHaveBeenCalledOnce();
});
