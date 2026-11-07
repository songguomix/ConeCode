export interface ModelCapabilities {
  /** Function/tool calling. */
  tools: boolean;
  /** Image inputs (screenshots) can be sent to the model. */
  images: boolean;
  /** The provider can return strict JSON/structured output. */
  structuredOutput: boolean;
  /** The provider has a native computer-use action tool. This runtime does not depend on it. */
  nativeComputerActions: boolean;
  notes: string[];
}

export interface ModelTool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
}

export interface ModelToolCall {
  id: string;
  name: string;
  arguments: string;
}

export type ModelContentPart =
  | { type: 'text'; text: string }
  | { type: 'image'; dataUrl: string; detail?: 'low' | 'high' | 'auto' };

export interface ModelMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string | ModelContentPart[];
  toolCallId?: string;
  toolCalls?: ModelToolCall[];
  name?: string;
}

export interface ModelRequest {
  messages: ModelMessage[];
  tools: ModelTool[];
  temperature?: number;
  maxOutputTokens?: number;
  responseFormat?: { type: 'json_object'; schema?: Record<string, unknown> };
}

export interface ModelUsage {
  inputTokens: number;
  outputTokens: number;
  costUsd?: number;
}

export interface ModelResponse {
  text?: string;
  toolCalls: ModelToolCall[];
  usage: ModelUsage;
  stopReason: 'stop' | 'tool_calls' | 'length' | 'content_filter' | 'error' | 'unknown';
  raw?: unknown;
}

export interface ModelAdapter {
  readonly id: string;
  capabilities(): ModelCapabilities;
  complete(request: ModelRequest, signal?: AbortSignal): Promise<ModelResponse>;
}

export function textOf(message: ModelMessage): string {
  if (typeof message.content === 'string') return message.content;
  return message.content.filter((p) => p.type === 'text').map((p) => p.text).join('\n');
}

export function imagesOf(message: ModelMessage): string[] {
  if (typeof message.content === 'string') return [];
  return message.content.filter((p) => p.type === 'image').map((p) => p.dataUrl);
}
