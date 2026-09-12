export interface Conversation {
  id: string;
  title: string;
  providerId: string;
  modelId: string;
  // Workspace folder this conversation works in, persisted so switching back to
  // an old conversation restores its folder even after an app restart.
  rootPath?: string | null;
  /** Folders opened beside the primary one (see core/workspace/roots.ts). */
  extraRoots?: string[];
  createdAt: number;
  updatedAt: number;
}

export interface Message {
  id: string;
  conversationId: string;
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  reasoning_content?: string;
  // Native function calling: the structured calls this assistant turn made, and
  // — on the matching tool-result turns — which call each one answers. Persisted
  // so a reloaded conversation still replays a protocol-valid history.
  toolCalls?: import('./provider.types').ToolCall[];
  toolCallId?: string;
  toolName?: string;
  // Anthropic extended thinking blocks, kept verbatim (signature included) so a
  // tool-calling turn can be replayed to the API exactly as it was produced.
  thinkingBlocks?: import('./provider.types').ThinkingBlock[];
  modelId?: string;
  providerId?: string;
  tokensUsed?: number;
  createdAt: number;
  isQuestion?: boolean;
  questionOptions?: string[];
  isToolResult?: boolean;
  // Screenshots the agent took while driving the computer, as data URLs. Held in
  // memory only — they are megabytes each, so persistMessage strips them before
  // the transcript is written to disk, and a reloaded conversation just takes a
  // fresh screenshot if it needs to look again.
  images?: string[];
  // Local UI-only notices (e.g. /help output, /diff results) that are shown in
  // the transcript but NOT sent back to the model as conversation context.
  isLocalNotice?: boolean;
  // Context compaction. The summary message REPLACES the messages it covers in
  // what is sent to the model, but nothing is deleted — the covered messages
  // stay in the transcript so the conversation still reads continuously.
  isSummary?: boolean;
  /** Id of the last message this summary covers. */
  summaryUpToId?: string;
  // Time in milliseconds the model spent thinking/generating this response.
  thinkingTime?: number;
}

export interface ChatState {
  /** True while ANY conversation has a live agent run. */
  isStreaming: boolean;
  /** Live streaming state per conversation, keyed by conversation id. */
  streamingRuns: Record<string, {
    content: string;
    reasoningContent: string;
    status: 'thinking' | 'writing' | null;
    toolName: string | null;
  }>;
  error: string | null;
}
