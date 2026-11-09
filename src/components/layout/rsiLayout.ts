import type { AgentMode } from '../../core/agents/modePrompts';
import type { ViewMode } from '../../stores/ui.store';

/**
 * Layout decisions for the workbench sidebar.
 *
 * RSI keeps its conversations separate from Work: the file explorer is hidden,
 * a compact folder hint replaces it, and every leftover pixel goes to the RSI
 * conversation list. Work groups chats under open projects, and Chat keeps
 * its full-height conversation list.
 */
export function rsiSidebarLayout({ agentMode, viewMode }: {
  agentMode: AgentMode;
  viewMode: ViewMode;
}) {
  const isRsi = agentMode === 'rsi';
  return {
    isRsi,
    showFolderHint: isRsi,
    showFileExplorer: false,
    /** Conversation list owns all the remaining sidebar height. */
    fillConversations: true,
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
