import { OpenAIAdapter } from './openai.adapter';
import type { ProviderConfig, SendMessageParams, StreamChunk } from '../../types';

export const FREE_PROVIDER_ID = 'conecode-free';
export const FREE_PROVIDER: ProviderConfig = {
  id: FREE_PROVIDER_ID, name: 'ConeCode Free', type: 'conecode-free',
  baseUrl: 'https://conellm.cc.cd', apiKey: '', defaultModel: '',
  timeout: 60000, enabled: true, createdAt: 0, updatedAt: 0,
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
  models: { id: string; name: string; context_window?: number; max_output_tokens?: number }[];
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
    applyFreeUsageReset(usageResetAt);
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
        ...(Number.isSafeInteger(m.context_window) && m.context_window > 0 ? { context_window: m.context_window } : {}),
        ...(Number.isSafeInteger(m.max_output_tokens) && m.max_output_tokens > 0 ? { max_output_tokens: m.max_output_tokens } : {}),
      })) : [],
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
  constructor(_config: ProviderConfig) { super({ ...FREE_PROVIDER }); }

  protected buildHeaders(): Record<string, string> { return { 'Content-Type': 'application/json' }; }

  protected async fetchWithTimeout(url: string, options: RequestInit): Promise<Response> {
    try {
      const response = await super.fetchWithTimeout(url, { ...options, redirect: 'error' });
      if (!response.ok) { await response.body?.cancel(); throw new Error(UNAVAILABLE); }
      return response;
    } catch (error) {
      if (options.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(UNAVAILABLE);
    }
  }

  async listModels() {
    const status = await freeStatus();
    return status.models.map((model) => this.mapModel(model));
  }

  async sendMessage(params: SendMessageParams) {
    try {
      const result = await super.sendMessage(params);
      if (result.error || !Array.isArray(result.choices)) throw new Error(UNAVAILABLE);
      return result;
    } catch {
      if (params.signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(UNAVAILABLE);
    }
  }

  protected async consumeStream(response: Response, onData: (chunk: string) => void, signal?: AbortSignal, idleMs?: number): Promise<string> {
    let pending = '';
    // Validate complete lines before the generic parser sees them. An SSE error
    // followed by [DONE] must never be mistaken for a successful empty answer.
    const forward = (line: string) => {
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data && data !== '[DONE]') {
          const parsed = JSON.parse(data);
          if (parsed.error || !Array.isArray(parsed.choices)) throw new Error(UNAVAILABLE);
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
      timer = setTimeout(() => { timedOut = true; cancel(); }, idleMs ?? 120000);
    };
    signal?.addEventListener('abort', cancel, { once: true });
    try {
      resetTimer();
      while (!signal?.aborted) {
        const { value, done } = await reader.read();
        if (done) break;
        resetTimer();
        pending += decoder.decode(value, { stream: true });
        if (pending.length > 1024 * 1024) throw new Error(UNAVAILABLE);
        const lines = pending.split('\n');
        pending = lines.pop() || '';
        for (const line of lines) forward(line);
      }
      if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
      if (timedOut) throw new Error(UNAVAILABLE);
      pending += decoder.decode();
      if (pending.trim()) forward(pending);
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
    catch {
      if (effectiveSignal?.aborted) throw new DOMException('Aborted', 'AbortError');
      throw new Error(UNAVAILABLE);
    }
  }

  async validateApiKey(): Promise<boolean> { return freeStatus().then((status) => status.available, () => false); }
}
