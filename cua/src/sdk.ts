import { readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type {
  ControlAction,
  CreateTaskInput,
  Event,
  Task,
  TaskSummary,
  UserInput,
} from './protocol/schemas.js';
import type { Metrics, TaskDetails } from './service/runtime-service.js';
import { EventSchema } from './protocol/schemas.js';
import type { WorkflowRecord } from './store/store.js';

export interface CuaClientOptions {
  baseUrl?: string;
  token?: string;
  tokenFile?: string;
  dataDir?: string;
  fetchImpl?: typeof fetch;
}

export class CuaClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'CuaClientError';
  }
}

/**
 * Typed client for the same local HTTP service used by the console, CLI and
 * MCP adapter. It intentionally does not bypass the service layer.
 */
export class CuaClient {
  private readonly options: CuaClientOptions;
  private resolved?: { baseUrl: string; token: string };

  constructor(options: CuaClientOptions = {}) {
    this.options = options;
  }

  private async auth(): Promise<{ baseUrl: string; token: string }> {
    if (this.resolved) return this.resolved;
    const dataDir = resolve(this.options.dataDir ?? process.env.CUA_DATA_DIR ?? join(process.cwd(), '.cua'));
    let baseUrl = this.options.baseUrl ?? process.env.CUA_API_URL;
    if (!baseUrl) {
      try {
        const server = JSON.parse(await readFile(join(dataDir, 'server.json'), 'utf8'));
        baseUrl = server.url;
      } catch {
        baseUrl = 'http://127.0.0.1:4317';
      }
    }
    const token =
      this.options.token ??
      process.env.CUA_TOKEN ??
      (await readFile(this.options.tokenFile ?? join(dataDir, 'server-token'), 'utf8').catch(() => '')).trim();
    if (!token) {
      throw new CuaClientError(0, 'UNAUTHORIZED', `No service token. Start the server or set CUA_TOKEN. Looked in ${dataDir}.`);
    }
    this.resolved = { baseUrl: baseUrl!.replace(/\/+$/, ''), token };
    return this.resolved;
  }

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    const { baseUrl, token } = await this.auth();
    const response = await (this.options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
      signal: AbortSignal.timeout(60_000),
    });
    const text = await response.text();
    let payload: any;
    try {
      payload = text ? JSON.parse(text) : undefined;
    } catch {
      payload = { error: { message: text } };
    }
    if (!response.ok) {
      const error = payload?.error;
      throw new CuaClientError(response.status, error?.code ?? 'HTTP_ERROR', error?.message ?? `HTTP ${response.status}`, error?.details);
    }
    return payload as T;
  }

  async health(): Promise<Record<string, unknown>> {
    return this.request('GET', '/api/health');
  }

  async metrics(): Promise<Metrics> {
    return this.request('GET', '/api/metrics');
  }

  async listWorkflows(): Promise<WorkflowRecord[]> {
    const result = await this.request<{ workflows: WorkflowRecord[] }>('GET', '/api/workflows');
    return result.workflows;
  }

  async deleteWorkflow(name: string): Promise<boolean> {
    const result = await this.request<{ schemaVersion: 1; deleted: boolean }>('DELETE', `/api/workflows/${encodeURIComponent(name)}`);
    return result.deleted;
  }

  async listTasks(limit = 100): Promise<TaskSummary[]> {
    const data = await this.request<{ tasks: TaskSummary[] }>('GET', `/api/tasks?limit=${limit}`);
    return data.tasks;
  }

  async createTask(input: CreateTaskInput): Promise<TaskSummary> {
    return this.request('POST', '/api/tasks', input);
  }

  async getTask(taskId: string): Promise<TaskDetails> {
    return this.request('GET', `/api/tasks/${encodeURIComponent(taskId)}`);
  }

  async control(taskId: string, action: ControlAction, reason?: string): Promise<Task> {
    return this.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/control`, { action, reason });
  }

  async submitInput(taskId: string, input: UserInput): Promise<Task> {
    return this.request('POST', `/api/tasks/${encodeURIComponent(taskId)}/input`, input);
  }

  async events(taskId?: string, since = 0): Promise<Event[]> {
    const path = taskId
      ? `/api/tasks/${encodeURIComponent(taskId)}/events?since=${since}`
      : `/api/events?since=${since}`;
    const data = await this.request<{ events: Event[] }>('GET', path);
    return data.events;
  }

  /** Stream server-sent events with bearer auth (EventSource cannot set headers). */
  async *stream(taskId: string | undefined, since = 0, signal?: AbortSignal): AsyncGenerator<Event> {
    const { baseUrl, token } = await this.auth();
    const path = taskId
      ? `/api/tasks/${encodeURIComponent(taskId)}/events?since=${since}&stream=1`
      : `/api/events?since=${since}&stream=1`;
    const response = await (this.options.fetchImpl ?? fetch)(`${baseUrl}${path}`, {
      headers: { authorization: `Bearer ${token}`, accept: 'text/event-stream' },
      signal,
    });
    if (!response.ok || !response.body) {
      throw new CuaClientError(response.status, 'SSE_ERROR', `Event stream failed with HTTP ${response.status}.`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) return;
        buffer += decoder.decode(value, { stream: true });
        let index: number;
        while ((index = buffer.search(/\r?\n\r?\n/)) >= 0) {
          const block = buffer.slice(0, index);
          const separatorLength = buffer.slice(index).startsWith('\r\n') ? 4 : 2;
          buffer = buffer.slice(index + separatorLength);
          const data = block
            .split('\n')
            .filter((line) => line.startsWith('data:'))
            .map((line) => line.slice(5).trim())
            .join('\n');
          if (!data) continue;
          if (/^event:\s*error\s*$/m.test(block)) {
            throw new CuaClientError(200, 'SSE_ERROR', 'The event stream reported an error. Reconnect with the last event sequence.');
          }
          let value: unknown;
          try { value = JSON.parse(data); }
          catch { throw new CuaClientError(200, 'PROTOCOL_INVALID', 'The event stream returned invalid JSON.'); }
          const parsed = EventSchema.safeParse(value);
          if (!parsed.success) throw new CuaClientError(200, 'PROTOCOL_INVALID', 'The event stream returned an invalid event.');
          yield parsed.data;
        }
      }
    } finally {
      try {
        await reader.cancel();
      } catch {
        // The stream may already be closed by the server.
      }
      reader.releaseLock();
    }
  }

  async artifactUrl(taskId: string, artifactId: string): Promise<string> {
    const { baseUrl } = await this.auth();
    return `${baseUrl}/api/artifacts/${encodeURIComponent(artifactId)}`;
  }

  /** Convenience: poll until the task leaves the running states. */
  async waitForTask(taskId: string, timeoutMs = 10 * 60_000): Promise<Task> {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const details = await this.getTask(taskId);
      if (['succeeded', 'failed', 'cancelled', 'needs_attention', 'paused', 'awaiting_user'].includes(details.task.status)) {
        return details.task;
      }
      await new Promise((r) => setTimeout(r, 300));
    }
    return (await this.getTask(taskId)).task;
  }
}
