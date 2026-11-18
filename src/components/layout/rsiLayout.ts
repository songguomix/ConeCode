import type { AgentMode } from '../../core/agents/modePrompts';
import type { ViewMode } from '../../stores/ui.store';

export function rsiSidebarLayout({ agentMode, viewMode }: {
  agentMode: AgentMode;
  viewMode: ViewMode;
}) {
  const isRsi = agentMode === 'rsi';
  return {
    isRsi,
    showFolderHint: isRsi || viewMode === 'work',
  };
}

/**
 * While RSI is armed the editor must not split the center column: the entire
 * area, including its left half, belongs to the conversation. The selected
 * file is only hidden, never cleared — switching back to Work restores it.
 */
export function workbenchVisible({ agentMode, selectedFile }: {
  agentMode: AgentMode;
  selectedFile: string | null;
}) {
  return !!selectedFile && agentMode !== 'rsi';
}
