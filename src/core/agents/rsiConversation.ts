import type { AgentMode } from './modePrompts';

export type RsiConversationStatus = 'idle' | 'running' | 'failed' | 'completed';

export interface RsiDirectionConfig {
  objective: string;
  priorities: string;
  metrics: string;
  scope: string;
  constraints: string;
}

export interface RsiRunRef {
  id: string;
  status: 'running' | 'failed' | 'completed' | 'stopped';
  iteration: number;
  result: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface RsiConversationState {
  status: RsiConversationStatus;
  directionConfig: RsiDirectionConfig;
  runs: RsiRunRef[];
}

export const EMPTY_RSI_DIRECTION: RsiDirectionConfig = {
  objective: '', priorities: '', metrics: '', scope: '', constraints: '',
};

export function defaultRsiState(): RsiConversationState {
  return { status: 'idle', directionConfig: { ...EMPTY_RSI_DIRECTION }, runs: [] };
}

export function isRsiConversation(value: { agentMode?: AgentMode; rsi?: RsiConversationState }): boolean {
  return value.agentMode === 'rsi' && !!value.rsi;
}

/** Stable, filesystem-safe scope: one real RSI archive per conversation. */
export function rsiWorkspaceDir(workspaceRoot: string, conversationId: string): string {
  const safeId = conversationId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return `${workspaceRoot.replace(/[\\/]+$/, '')}/.conecode/rsi/conversations/${safeId}`;
}

/** Runtime evidence only: no synthetic success or locally guessed iteration. */
export function readRsiProgress(raw: string | null): { iteration: number; acceptedCount: number } | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    const state = parsed?.state;
    if (!Number.isInteger(state?.episodeIndex) || !Number.isInteger(state?.acceptedCount)) return null;
    return { iteration: Math.max(0, state.episodeIndex), acceptedCount: Math.max(0, state.acceptedCount) };
  } catch {
    return null;
  }
}

export function rsiDirectionPrompt(conversationId: string, workspaceRoot: string | null, config: RsiDirectionConfig): string {
  const archive = workspaceRoot ? rsiWorkspaceDir(workspaceRoot, conversationId) : '(open a workspace before execution)';
  const field = (label: string, value: string) => `${label}: ${value.trim() || '(not specified)'}`;
  return `RSI CONVERSATION CONTEXT\nConversation ID: ${conversationId}\nRSI archive: ${archive}\n\n${field('Objective', config.objective)}\n${field('Priorities', config.priorities)}\n${field('Evaluation metrics', config.metrics)}\n${field('Modification scope', config.scope)}\n${field('Constraints', config.constraints)}\n\nThis direction belongs only to this conversation. Use the archive above instead of the legacy shared .conecode/rsi directory. Keep the frozen goal-vector safety contract: if direction or metrics change during a run, stop and request explicit user confirmation before replacing the frozen goal. Continue discussing plans normally; execute only when the user asks to start or continue RSI execution.`;
}
