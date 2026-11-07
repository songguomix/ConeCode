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
  return `RSI CONVERSATION CONTEXT
Conversation ID: ${conversationId}
RSI archive: ${archive}

${field('Objective', config.objective)}
${field('Priorities', config.priorities)}
${field('Evaluation metrics', config.metrics)}
${field('Modification scope', config.scope)}
${field('Constraints', config.constraints)}

This direction belongs only to this conversation. Use the archive above instead of the legacy shared .conecode/rsi directory for GOAL_VECTOR.md, LOOP_STATE.json, iterations, trees, REFLECTIONS.md, DIRECTIONS.md, and EVOLUTION_LOG.md.
Treat these fields as the user's task contract, not evidence that any check ran or any improvement was accepted. A saved direction or selected RSI mode does not start execution: continue discussing plans normally; execute only when the user asks to implement, start, or continue RSI execution. Do not create a new episode merely to answer a question or report status.
On an authorized run, first read this archive's frozen goal and latest recorded evidence, then inspect the current working diff. Resume only from a state you can verify; do not import another conversation's scores or assume an archived patch is present. Preserve pre-existing user changes.
If no goal is frozen yet, use the configured objective and the latest user request to identify one useful outcome. Missing optional fields do not require a questionnaire: infer the narrowest supported scope from the project, disclose it, and choose runnable checks before editing. Ask only when a missing decision would change product scope or prevent external verification.
Translate metric descriptions into exact commands/fixtures and a minimum meaningful gain. Keep already-green checks as no-regression guards, and choose a primary improvement check with real headroom. Show before -> after evidence for the user benefit; additional test counts and judge praise alone cannot establish improvement.
Keep the frozen goal-vector safety contract: if direction or metrics change during a run, stop and request explicit user confirmation before replacing the frozen goal. Do not reinterpret a revised direction as permission to relabel old outcomes or overwrite the prior baseline.`;
}
