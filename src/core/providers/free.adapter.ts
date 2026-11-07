import { OpenAIAdapter } from './openai.adapter';
import type { ProviderConfig, SendMessageParams, StreamChunk } from '../../types';

export const FREE_PROVIDER_ID = 'conecode-free';
export const FREE_PROVIDER: ProviderConfig = {
  id: FREE_PROVIDER_ID, name: 'ConeCode Free', type: 'conecode-free',
  baseUrl: 'https://conellm.cc.cd', apiKey: '', defaultModel: '',
  timeout: 120000, enabled: true, createdAt: 0, updatedAt: 0,
};
import {
  FREE_WEEKLY_TOKEN_LIMIT,
  FREE_WEEKLY_LIMIT,
  WEEKLY_LIMIT,
  FREE_WEEKLY_CAP,
  FREE_WEEKLY_TOKEN_CAP,
  WEEKLY_TOKEN_LIMIT,
  FREE_USAGE_STORAGE_KEY,
  loadFreeWeeklyUsage,
  saveFreeWeeklyUsage,
  getFreeWeeklyUsed,
  recordFreeUsage,
  resetFreeWeeklyUsage,
  isFreeWeeklyLimitReached,
  applyFreeUsageReset,
} from './freeUsage';

export {
  FREE_WEEKLY_TOKEN_LIMIT,
  FREE_WEEKLY_LIMIT,
  WEEKLY_LIMIT,
  FREE_WEEKLY_CAP,
  FREE_WEEKLY_TOKEN_CAP,
  WEEKLY_TOKEN_LIMIT,
  FREE_USAGE_STORAGE_KEY,
  loadFreeWeeklyUsage,
  saveFreeWeeklyUsage,
  getFreeWeeklyUsed,
  recordFreeUsage,
  resetFreeWeeklyUsage,
  isFreeWeeklyLimitReached,
  applyFreeUsageReset,
};

const UNAVAILABLE = 'ConeCode Free 暂时不可用，请稍后重试。';
const DEFAULT_MAX_REQUEST_BYTES = 32 * 1024 * 1024;

// IPC preserves Error.message, but not custom properties. Keep a safe status
// in the message so the renderer can retry transient errors and downgrade tools.
// Never display upstream error text, URLs or credentials.
class FreeRelayError extends Error {
  constructor(readonly status = 503, readonly code = 'free_unavailable') {
    const message = code === 'free_tools_unsupported'
      ? 'ConeCode Free: tools are not supported by this model.'
      : status === 413
        ? 'ConeCode Free 请求过大，请缩小图片、减少附件或压缩对话后重试。'
        : status === 429
          ? 'ConeCode Free 请求过于频繁，请稍后重试。'
          : UNAVAILABLE;
    super(`${message} (HTTP ${status})`);
    this.name = 'FreeRelayError';
  }
}

function safeRelayError(error: unknown, status = 503): FreeRelayError {
  if (error instanceof FreeRelayError) return error;
  return new FreeRelayError(status);
}

function responseError(data: any, status = 502): FreeRelayError {
  const code = data?.error?.code;
  // SSE already has HTTP 200 headers; the relay carries the original status
  // in this controlled numeric field instead of exposing upstream messages.
  const streamStatus = data?.error?.status;
  if ([400, 401, 403, 404, 413, 422, 429, 500, 502, 503, 504].includes(streamStatus)) status = streamStatus;
  if (code === 'free_tools_unsupported') return new FreeRelayError(400, code);
  if (code === 'free_request_too_large') return new FreeRelayError(413, code);
  if (code === 'free_rate_limited') return new FreeRelayError(429, code);
  return new FreeRelayError(status);
}

async function readResponseError(response: Response): Promise<FreeRelayError> {
  const reader = response.body?.getReader();
  if (!reader) return new FreeRelayError(response.status);
  let text = '';
  let bytes = 0;
  const decoder = new TextDecoder();
  // Bound untrusted error bodies even when a proxy sends HTML instead of JSON.
  const timer = setTimeout(() => { void reader.cancel().catch(() => {}); }, 5000);
  try {
    while (bytes <= 65536) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 65536) break;
      text += decoder.decode(value, { stream: true });
    }
    if (bytes <= 65536) {
      text += decoder.decode();
      try { return responseError(JSON.parse(text), response.status); } catch {}
    }
    return new FreeRelayError(response.status);
  } catch {
    return new FreeRelayError(response.status);
  } finally {
    clearTimeout(timer);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

export interface FreeUsage {
  /** Tokens consumed this week. */
  used: number;
  usedTokens: number;
  tokensUsed: number;
  weeklyUsed: number;
  /** Weekly cap (defaults to FREE_WEEKLY_TOKEN_LIMIT). */
  limit: number;
  weeklyLimit: number;
  tokenLimit: number;
  /** When the weekly window resets. */
  resetsAt: string | null;
  resetAt: string | null;
}

export interface FreeStatus {
  available: boolean;
  mode: 'off' | 'on' | 'scheduled';
  startsAt: string | null;
  endsAt: string | null;
  models: { id: string; name: string; supportsVision?: boolean; context_window?: number; max_output_tokens?: number }[];
  limits?: { maxRequestBytes: number; streamIdleTimeoutMs: number };
  /** Weekly usage for the gifted model. Absent for self-provided providers. */
  usage?: FreeUsage;
  /** Convenience mirrors (also present on `usage`). */
  usedTokens?: number;
  weeklyUsed?: number;
  weeklyLimit?: number;
  resetsAt?: string | null;
  /** Server timestamp when weekly usage was manually or periodically reset. */
  usageResetAt?: string | null;
}

export async function freeStatus(): Promise<FreeStatus> {
  try {
    const response = await fetch(`${FREE_PROVIDER.baseUrl}/status`, { signal: AbortSignal.timeout(10000), redirect: 'error', cache: 'no-store' });
    if (!response.ok) throw new Error(UNAVAILABLE);
    const data = await response.json();
    const date = (value: unknown) => typeof value === 'string' && Number.isFinite(Date.parse(value)) ? new Date(value).toISOString() : null;
    const num = (value: unknown) => (typeof value === 'number' && Number.isFinite(value) && value >= 0) ? value : undefined;
    const usageSource = (data && typeof data.usage === 'object' && data.usage !== null) ? data.usage : data;
    const used = num(usageSource?.used)
      ?? num(usageSource?.usedTokens)
      ?? num(usageSource?.tokensUsed)
      ?? num(usageSource?.weeklyUsed)
      ?? num(usageSource?.usageTokens)
      ?? num(data?.used)
      ?? num(data?.usedTokens)
      ?? num(data?.tokensUsed)
      ?? num(data?.weeklyUsed)
      ?? 0;
    const limit = num(usageSource?.limit)
      ?? num(usageSource?.weeklyLimit)
      ?? num(usageSource?.tokenLimit)
      ?? num(usageSource?.cap)
      ?? num(data?.limit)
      ?? num(data?.weeklyLimit)
      ?? num(data?.tokenLimit)
      ?? num(data?.cap)
      ?? FREE_WEEKLY_TOKEN_LIMIT;
    const resetsAt = date(usageSource?.resetsAt)
      ?? date(usageSource?.resetAt)
      ?? date(usageSource?.weeklyResetAt)
      ?? date(data?.resetsAt)
      ?? date(data?.resetAt)
      ?? date(data?.weeklyResetAt)
      ?? null;
    const usageResetAt = date(data?.usageResetAt) ?? date(usageSource?.usageResetAt) ?? null;
    // NOTE: the reset itself is applied by the renderer via `free:usage:sync`
    // into the durable main-process file store — freeStatus only reports the
    // marker. (The old in-main applyFreeUsageReset call was a silent no-op:
    // the main process has no localStorage.)
    const usage: FreeUsage = {
      used, usedTokens: used, tokensUsed: used, weeklyUsed: used,
      limit, weeklyLimit: limit, tokenLimit: limit,
      resetsAt, resetAt: resetsAt,
    };
    return {
      available: data.available === true,
      mode: data.mode === 'scheduled' ? 'scheduled' : data.mode === 'on' ? 'on' : 'off',
      startsAt: date(data.startsAt), endsAt: date(data.endsAt),
      models: data.available === true && Array.isArray(data.models) ? data.models.slice(0, 100).filter((m: any) => typeof m.id === 'string' && typeof m.name === 'string').map((m: any) => ({
        id: m.id, name: m.name,
        supportsVision: m.supportsVision === true,
        ...(Number.isSafeInteger(m.context_window) && m.context_window > 0 ? { context_window: m.context_window } : {}),
        ...(Number.isSafeInteger(m.max_output_tokens) && m.max_output_tokens > 0 ? { max_output_tokens: m.max_output_tokens } : {}),
      })) : [],
      limits: {
        maxRequestBytes: Number.isSafeInteger(data.limits?.maxRequestBytes) && data.limits.maxRequestBytes > 0
          ? data.limits.maxRequestBytes : DEFAULT_MAX_REQUEST_BYTES,
        streamIdleTimeoutMs: Number.isSafeInteger(data.limits?.streamIdleTimeoutMs) && data.limits.streamIdleTimeoutMs > 0
          ? data.limits.streamIdleTimeoutMs : 120000,
      },
      usage,
      usedTokens: used,
      weeklyUsed: used,
      weeklyLimit: limit,
      resetsAt,
      usageResetAt,
    };
  } catch { throw new Error(UNAVAILABLE); }
}

/** Fixed relay boundary: no user-configured endpoint or credential is accepted. */
export class FreeAdapter extends OpenAIAdapter {
  private maxRequestBytes = DEFAULT_MAX_REQUEST_BYTES;
  private streamIdleTimeoutMs = 120000;
  constructor(_config: ProviderConfig) { super({ ...FREE_PROVIDER }); }

  protected buildHeaders(): Record<string, string> { return { 'Content-Type': 'application/json' }; }

  protected async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    try {
      if (typeof options.body === 'string' && new TextEncoder().encode(options.body).byteLength > this.maxRequestBytes) {
        throw new FreeRelayError(413, 'free_request_too_large');
      }
      const response = await super.fetchWithTimeout(url, { ...options, redirect: 'error' });
      if (!response.ok) throw await readResponseError(response);
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw safeRelayError(error);
    }
  }

  async listModels() {
    const status = await freeStatus();
    this.maxRequestBytes = status.limits?.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES;
    this.streamIdleTimeoutMs = status.limits?.streamIdleTimeoutMs ?? 120000;
    return status.models.map((model) => this.mapModel(model, { supportsVision: model.supportsVision === true }));
  }

  async sendMessage(params: SendMessageParams) {
    try {
      const result = await super.sendMessage(params);
      if (result.error || !Array.isArray(result.choices)) throw responseError(result);
      return result;
    } catch (error) {
      if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw safeRelayError(error, 502);
    }
  }

  protected async consumeStream(response: Response, onData: (chunk: string) => void, signal?: AbortSignal, idleMs?: number): Promise<string> {
    let pending = '';
    let completed = false;
    // Validate complete lines before the generic parser sees them. An SSE error
    // followed by [DONE] must never be mistaken for a successful empty answer.
    const forward = (line: string) => {
      const trimmed = line.trimStart();
      if (trimmed.startsWith('data:')) {
        const data = trimmed.slice(5).trim();
        if (data === '[DONE]') completed = true;
        if (data && data !== '[DONE]') {
          const parsed = JSON.parse(data);
          if (parsed.error || !Array.isArray(parsed.choices)) throw responseError(parsed);
        }
      }
      onData(`${line}\n`);
    };
    const reader = response.body?.getReader();
    if (!reader) throw new Error(UNAVAILABLE);
    const decoder = new TextDecoder();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const cancel = () => { void reader.cancel().catch(() => {}); };
    const resetTimer = () => {
      clearTimeout(timer);
      timer = setTimeout(() => { timedOut = true; cancel(); }, idleMs ?? this.streamIdleTimeoutMs);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      resetTimer();
      while (!signal?.aborted && !completed) {
        const { value, done } = await reader.read();
        if (done) break;
        resetTimer();
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 1024 * 1024) throw new Error(UNAVAILABLE);
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) {
          forward(line);
          if (completed) break;
        }
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timedOut) throw new FreeRelayError(504);
      pending += decoder.decode();
      if (!completed && pending.trim()) forward(pending);
      return '';
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener('abort', cancel);
      await reader.cancel().catch(() => {});
      reader.releaseLock();
    }
  }

  async streamMessage(params: SendMessageParams, onChunk: (chunk: StreamChunk) => void, signal?: AbortSignal) {
    const effectiveSignal = signal || params.signal;
    try { return await super.streamMessage(params, onChunk, effectiveSignal); }
    catch (error) {
      if (effectiveSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw safeRelayError(error, 502);
    }
  }

  async validateApiKey(): Promise<boolean> { return freeStatus().then((status) => status.available, () => false); }
}
