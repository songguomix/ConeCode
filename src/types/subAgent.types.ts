import type { ToolCall } from './provider.types';

export interface SubAgentRun {
  id: string;
  conversationId: string;
  task: string;
  startedAt: number;
  status: 'running' | 'completed' | 'failed' | 'interrupted' | 'limit';
  messages: {
    role: 'assistant' | 'tool';
    content: string;
    toolCalls?: ToolCall[];
    name?: string;
  }[];
  detail?: string;
}
