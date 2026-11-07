import { CuaError } from '../protocol/errors.js';
import { setTimeout as delay } from 'node:timers/promises';
import type {
  ModelAdapter,
  ModelCapabilities,
  ModelMessage,
  ModelRequest,
  ModelResponse,
  ModelToolCall,
  ModelUsage,
} from './types.js';

export interface OpenAICompatibleConfig {
  model: string;
  baseUrl?: string;
  apiKeyEnv?: string;
  apiKey?: string;
  organization?: string;
  capabilities?: Partial<ModelCapabilities>;
  temperature?: number;
  /** Reasoning models can reject temperature; omit it unless explicitly configured. */
  timeoutMs?: number;
  maxRetries?: number;
  /** Some OpenAI-compatible gateways still require max_tokens, newer OpenAI models prefer max_completion_tokens. */
  tokenParameter?: 'max_tokens' | 'max_completion_tokens';
  pricing?: { inputPerMillionUsd: number; outputPerMillionUsd: number };
  headers?: Record<string, string>;
}

/**
 * A deliberately small OpenAI-compatible Chat Completions adapter. It is not
 * tied to a specific model; capabilities are explicit configuration. The
 * Responses-only native `computer` tool is not used by this runtime (our
 * function tools work across OpenAI-compatible providers).
 */
export class OpenAICompatibleAdapter implements ModelAdapter {
  readonly id: string;
  private readonly config: Required<Pick<OpenAICompatibleConfig, 'model' | 'baseUrl' | 'apiKeyEnv' | 'timeoutMs' | 'maxRetries' | 'tokenParameter'>> &
    OpenAICompatibleConfig;

  constructor(config: OpenAICompatibleConfig) {
    this.config = {
      ...config,
      model: config.model,
      baseUrl: (config.baseUrl ?? 'https://api.openai.com/v1').replace(/\/+$/, ''),
      apiKeyEnv: config.apiKeyEnv ?? 'OPENAI_API_KEY',
      timeoutMs: config.timeoutMs ?? 60_000,
      // RuntimeService counts each complete() request against the task budget.
      // Retries are opt-in for standalone callers, never hidden by default.
      maxRetries: config.maxRetries ?? 0,
      tokenParameter: config.tokenParameter ?? 'max_completion_tokens',
    };
    this.id = `openai-compat:${config.model}`;
  }

  capabilities(): ModelCapabilities {
    return {
      tools: this.config.capabilities?.tools ?? true,
      images: this.config.capabilities?.images ?? false,
      structuredOutput: this.config.capabilities?.structuredOutput ?? false,
      nativeComputerActions: false,
      notes: [
        'Capabilities are configured explicitly; an OpenAI-compatible API shape does not prove capability parity.',
        'This adapter implements function tools, not the native Responses computer tool.',
        ...(this.config.capabilities?.notes ?? []),
      ],
    };
  }

  private apiKey(): string {
    const key = this.config.apiKey ?? process.env[this.config.apiKeyEnv];
    if (!key) {
      throw new CuaError(
        'MODEL_CAPABILITY_MISSING',
        `Model credential is missing: set ${this.config.apiKeyEnv}. Deterministic local tests do not require it.`,
      );
    }
    return key;
  }

  async complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse> {
    if (!this.capabilities().tools && request.tools.length > 0) {
      throw new CuaError('MODEL_CAPABILITY_MISSING', 'This adapter is configured without tool-calling support.');
    }
    if (!this.capabilities().images && request.messages.some((m) => Array.isArray(m.content) && m.content.some((p) => p.type === 'image'))) {
      throw new CuaError('MODEL_CAPABILITY_MISSING', 'Image input was not enabled for this adapter.');
    }
    if (request.responseFormat && !this.capabilities().structuredOutput) {
      throw new CuaError('MODEL_CAPABILITY_MISSING', 'Structured output was not enabled for this adapter.');
    }
    const temperature = request.temperature ?? this.config.temperature;
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: request.messages.map((m) => this.toWireMessage(m)),
      ...(request.tools.length ? { tools: request.tools.map((tool) => ({
        type: 'function',
        function: { name: tool.name, description: tool.description, parameters: tool.parameters },
      })),
      tool_choice: 'auto',
      parallel_tool_calls: false } : {}),
      ...(temperature === undefined ? {} : { temperature }),
      [this.config.tokenParameter]: request.maxOutputTokens ?? 2_000,
    };
    if (request.responseFormat) {
      body.response_format = request.responseFormat.schema
        ? { type: 'json_schema', json_schema: { name: 'result', strict: true, schema: request.responseFormat.schema } }
        : { type: 'json_object' };
    }

    let lastError: unknown;
    for (let attempt = 0; attempt <= this.config.maxRetries; attempt++) {
      if (signal?.aborted) throw new CuaError('CANCELLED', 'Model request cancelled.');
      try {
        const response = await fetch(`${this.config.baseUrl}/chat/completions`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            authorization: `Bearer ${this.apiKey()}`,
            ...(this.config.organization ? { 'openai-organization': this.config.organization } : {}),
            ...(this.config.headers ?? {}),
          },
          body: JSON.stringify(body),
          signal: AbortSignal.any([AbortSignal.timeout(this.config.timeoutMs), ...(signal ? [signal] : [])]),
        });
        if (!response.ok) {
          const text = await response.text().catch(() => '');
          const detail = text.slice(0, 2_000);
          if (response.status === 429) {
            throw new CuaError('MODEL_RATE_LIMITED', `Model provider rate-limited the request: ${detail}`, {
              retryable: true,
              details: { status: response.status, retryAfter: response.headers.get('retry-after') },
            });
          }
          throw new CuaError('MODEL_ERROR', `Model provider returned HTTP ${response.status}: ${detail}`, {
            retryable: response.status >= 500,
            details: { status: response.status },
          });
        }
        const json = (await response.json()) as any;
        return this.parseResponse(json);
      } catch (error) {
        if (signal?.aborted) throw new CuaError('CANCELLED', 'Model request cancelled.');
        lastError = error;
        const retryable =
          error instanceof CuaError ? error.retryable : error instanceof Error && /fetch failed|timeout/i.test(error.message);
        if (!retryable || attempt >= this.config.maxRetries) break;
        // Provider requests are retried, UI actions are never replayed here.
        const retryAfter = error instanceof CuaError ? Number(error.details?.retryAfter) : NaN;
        const waitMs = Math.min(30_000, Math.max(500 * 2 ** attempt, Number.isFinite(retryAfter) ? retryAfter * 1_000 : 0));
        try { await delay(waitMs, undefined, { signal }); }
        catch { throw new CuaError('CANCELLED', 'Model retry cancelled.'); }
      }
    }
    if (lastError instanceof CuaError) throw lastError;
    throw new CuaError('MODEL_ERROR', `Model request failed: ${lastError instanceof Error ? lastError.message : String(lastError)}`, {
      cause: lastError,
      retryable: true,
    });
  }

  private toWireMessage(message: ModelMessage): Record<string, unknown> {
    if (message.role === 'tool') {
      return {
        role: 'tool',
        tool_call_id: message.toolCallId ?? 'unknown',
        content: typeof message.content === 'string' ? message.content : JSON.stringify(message.content),
      };
    }
    if (message.role === 'assistant' && message.toolCalls?.length) {
      return {
        role: 'assistant',
        content: typeof message.content === 'string' ? message.content : null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: call.arguments },
        })),
      };
    }
    if (typeof message.content === 'string') {
      return { role: message.role, content: message.content };
    }
    return {
      role: message.role,
      content: message.content.map((part) =>
        part.type === 'text'
          ? { type: 'text', text: part.text }
          : { type: 'image_url', image_url: { url: part.dataUrl, detail: part.detail ?? 'auto' } },
      ),
    };
  }

  private parseResponse(json: any): ModelResponse {
    const choice = json?.choices?.[0];
    if (!choice) {
      throw new CuaError('MODEL_ERROR', 'Model response had no choices.', { details: { json: json?.error ?? undefined } });
    }
    const message = choice.message ?? {};
    const toolCalls: ModelToolCall[] = Array.isArray(message.tool_calls)
      ? message.tool_calls.map((call: any) => ({
          id: String(call.id ?? `call_${Math.random().toString(36).slice(2)}`),
          name: String(call.function?.name ?? ''),
          arguments:
            typeof call.function?.arguments === 'string'
              ? call.function.arguments
              : JSON.stringify(call.function?.arguments ?? {}),
        }))
      : [];
    const usage = this.usage(json.usage);
    return {
      text: typeof message.content === 'string' ? message.content : undefined,
      toolCalls,
      usage,
      stopReason:
        choice.finish_reason === 'tool_calls'
          ? 'tool_calls'
          : choice.finish_reason === 'length'
            ? 'length'
            : choice.finish_reason === 'content_filter'
              ? 'content_filter'
              : choice.finish_reason === 'stop'
                ? 'stop'
                : 'unknown',
      raw: json,
    };
  }

  private usage(raw: any): ModelUsage {
    const inputTokens = Number(raw?.prompt_tokens ?? raw?.input_tokens ?? 0);
    const outputTokens = Number(raw?.completion_tokens ?? raw?.output_tokens ?? 0);
    const pricing = this.config.pricing;
    return {
      inputTokens,
      outputTokens,
      ...(pricing
        ? {
            costUsd:
              (inputTokens / 1_000_000) * pricing.inputPerMillionUsd +
              (outputTokens / 1_000_000) * pricing.outputPerMillionUsd,
          }
        : {}),
    };
  }
}
