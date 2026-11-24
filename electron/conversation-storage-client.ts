import { Worker } from 'node:worker_threads';
import type { ConversationStorageOperations } from './conversation-storage-worker';

type Channel = keyof ConversationStorageOperations;
type Reply = { id: number; ok: true; result: unknown } | { id: number; ok: false; error: string };
type PendingRequest = { resolve: (result: unknown) => void; reject: (error: unknown) => void };

export class ConversationStorageClient {
  private worker: Worker | null = null;
  private retiring: Promise<void> | null = null;
  private closed = false;
  private nextId = 0;
  private readonly pending = new Map<number, PendingRequest>();
  private readonly idleWaiters = new Set<() => void>();

  constructor(private readonly workerPath: string, private readonly dataDirectory: string) {}

  get hasPending(): boolean {
    return this.pending.size > 0;
  }

  whenIdle(): Promise<void> {
    if (!this.hasPending) return Promise.resolve();
    return new Promise((resolve) => this.idleWaiters.add(resolve));
  }

  request<K extends Channel>(
    channel: K,
    ...args: Parameters<ConversationStorageOperations[K]>
  ): Promise<ReturnType<ConversationStorageOperations[K]>> {
    if (this.closed) return Promise.reject(new Error('Conversation storage is closed'));
    const id = ++this.nextId;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve: (result) => resolve(result as ReturnType<ConversationStorageOperations[K]>), reject });
      const send = () => {
        if (!this.pending.has(id)) return;
        try {
          const worker = this.worker ?? this.startWorker();
          worker.ref();
          worker.postMessage({ id, channel, args });
        } catch (error) {
          this.pending.delete(id);
          reject(error);
          this.notifyIdle();
        }
      };
      // A protocol failure can require explicit termination. Do not start a
      // new writer while the retiring worker may still own the JSON files.
      if (this.retiring) void this.retiring.then(send);
      else send();
    });
  }

  close(): void {
    this.closed = true;
    const error = new Error('Conversation storage is closed');
    if (this.worker) this.failWorker(this.worker, error, true);
    else this.rejectPending(error);
  }

  private startWorker(): Worker {
    const worker = new Worker(this.workerPath, { workerData: this.dataDirectory });
    this.worker = worker;
    worker.on('message', (reply: Reply) => this.handleReply(worker, reply));
    worker.on('messageerror', (error) => this.failWorker(worker, error, true));
    worker.once('error', (error) => this.failWorker(worker, error, true));
    worker.once('exit', (code) => this.failWorker(worker, new Error(`Conversation storage worker exited (${code})`), false));
    return worker;
  }

  private handleReply(worker: Worker, reply: Reply): void {
    if (this.worker !== worker) return;
    if (!reply || !Number.isSafeInteger(reply.id) || (reply.ok !== true && reply.ok !== false)) {
      this.failWorker(worker, new Error('Invalid conversation storage worker reply'), true);
      return;
    }
    const request = this.pending.get(reply.id);
    if (!request) return;
    this.pending.delete(reply.id);
    if (reply.ok) request.resolve(reply.result);
    else request.reject(new Error(reply.error));
    this.notifyIdle();
  }

  private failWorker(worker: Worker, error: unknown, terminate: boolean): void {
    if (this.worker !== worker) return;
    this.worker = null;
    worker.unref();
    if (terminate) {
      const retiring = worker.terminate().then(() => {}, () => {});
      this.retiring = retiring;
      void retiring.then(() => { if (this.retiring === retiring) this.retiring = null; });
    }
    // A write may have committed just before the error. Report its unknown
    // outcome to the caller and never submit it again automatically.
    this.rejectPending(error);
  }

  private rejectPending(error: unknown): void {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.notifyIdle();
  }

  private notifyIdle(): void {
    if (this.hasPending) return;
    this.worker?.unref();
    for (const resolve of this.idleWaiters) resolve();
    this.idleWaiters.clear();
  }
}
