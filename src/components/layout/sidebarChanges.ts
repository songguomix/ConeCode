import type { CodeChange } from '../../stores/codeChanges.store';

interface SidebarChangeSummary {
  fileNames: string[];
  hasAiChanges: boolean;
}

/** Index the badges for the conversation list using the store's newest-first order. */
export function indexSidebarChanges(
  changes: readonly Pick<CodeChange, 'conversationId' | 'filePath' | 'kind'>[],
  highlightedFiles: readonly string[],
): Map<string, SidebarChangeSummary> {
  const highlights = new Set(highlightedFiles);
  const byConversation = new Map<string, SidebarChangeSummary>();

  for (const { conversationId, filePath, kind } of changes) {
    if (!conversationId) continue;
    const realFile = !filePath.startsWith('[');
    const hasAiChanges = (kind === 'edit' || kind === 'create') && highlights.has(filePath);
    if (!realFile && !hasAiChanges) continue;

    let summary = byConversation.get(conversationId);
    if (!summary) {
      summary = { fileNames: [], hasAiChanges: false };
      byConversation.set(conversationId, summary);
    }
    if (realFile && summary.fileNames.length < 2) {
      const name = filePath.slice(filePath.lastIndexOf('/') + 1) || filePath;
      if (!summary.fileNames.includes(name)) summary.fileNames.push(name);
    }
    summary.hasAiChanges ||= hasAiChanges;
  }

  return byConversation;
}
