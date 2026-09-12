import type { AIModel } from './model.types';
import type { Message } from './chat.types';

export type ProviderType = 'openai' | 'anthropic' | 'gemini' | 'deepseek' | 'openrouter' | 'custom';

export interface ProviderConfig {
  id: string;
  name: string;
  type: ProviderType;
  baseUrl: string;
  apiKey: string;
  defaultModel: string;
  timeout: number;
  enabled: boolean;
  createdAt: number;
  updatedAt: number;
}

export interface ProviderAdapter {
  readonly config: ProviderConfig;
  listModels(): Promise<AIModel[]>;
  sendMessage(params: SendMessageParams): Promise<Message>;
  streamMessage(params: SendMessageParams, onChunk: (chunk: StreamChunk) => void, signal?: AbortSignal): Promise<Message>;
  validateApiKey(): Promise<boolean>;
}

export interface SendMessageParams {
  model: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  signal?: AbortSignal;
  reasoningEffort?: 'low' | 'medium' | 'high';
  // Native function-calling: when present, the adapter advertises these tools to
  // the API and returns any structured tool calls the model emits. Omitted for
  // models/endpoints without function calling — those fall back to the
  // prompt-based ```json protocol.
  tools?: ToolDefinitionWire[];
  toolChoice?: 'auto' | 'none' | 'required';
}

/**
 * Provider-agnostic tool definition as it crosses the IPC boundary (a plain
 * JSON-schema object — see core/tools/definitions.ts for the catalog).
 */
export interface ToolDefinitionWire {
  name: string;
  description: string;
  parameters: { type: 'object'; properties?: Record<string, any>; required?: string[] };
}

/** One structured tool call, normalized across providers. */
export interface ToolCall {
  /** Provider-assigned id; results must be returned against it. */
  id: string;
  name: string;
  /** Parsed arguments. Adapters parse the JSON so callers never re-parse. */
  arguments: Record<string, any>;
  /** Raw argument JSON, kept for round-tripping back to the provider verbatim. */
  rawArguments?: string;
}

export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string; detail?: 'low' | 'high' | 'auto' } };

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ContentPart[];
  // Provider-agnostic cache breakpoint. Adapters that support explicit prompt
  // caching translate this to their wire format; the others safely ignore it.
  cacheControl?: { type: 'ephemeral'; ttl?: '5m' | '1h' };
  reasoning_content?: string;
  // Assistant turns that called tools carry them here; the adapter re-encodes
  // them in the provider's wire format so the model sees its own calls.
  tool_calls?: ToolCall[];
  // Tool-result turns (role 'tool') answer exactly one call by id.
  tool_call_id?: string;
  name?: string;
  // Anthropic extended thinking: the VERBATIM thinking blocks (text + provider
  // signature) from the turn that made these tool calls. The API rejects a
  // tool_result follow-up whose assistant turn dropped them, so they have to
  // round-trip unmodified.
  thinking_blocks?: ThinkingBlock[];
}

export interface ThinkingBlock {
  thinking: string;
  signature?: string;
}

export interface StreamChunk {
  type: 'thinking' | 'text' | 'reasoning' | 'error' | 'done' | 'tool_call';
  content: string;
  reasoning_content?: string;
  // Why generation ended (OpenAI-compatible `finish_reason`): 'stop', 'length'
  // (hit max_tokens — often truncated mid-reasoning), 'tool_calls', etc.
  finishReason?: string;
  // Set on 'tool_call' chunks: the name of the tool the model just started
  // calling, so the UI can show live "calling X…" status mid-stream.
  toolName?: string;
}
