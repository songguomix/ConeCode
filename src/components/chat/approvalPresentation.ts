import type { CodeChange } from '../../stores/codeChanges.store';

export function isCommandChange(change: CodeChange): boolean {
  return (change.kind || 'edit') === 'exec';
}

/** Batch file actions must never bypass the dedicated command approval dialog. */
export function pendingFileChanges(changes: CodeChange[]): CodeChange[] {
  return changes.filter((change) => change.status === 'pending' && !isCommandChange(change));
}

/** Keep command dialogs scoped to the chat the user is currently viewing. */
export function commandsForConversation(
  changes: CodeChange[],
  conversationId: string | null,
  visibleMessageIds: Set<string>,
): CodeChange[] {
  return changes
    .filter((change) => isCommandChange(change) && (
      (conversationId !== null && change.conversationId === conversationId)
      || (!change.conversationId && !!change.messageId && visibleMessageIds.has(change.messageId))
    ))
    .sort((a, b) => a.createdAt - b.createdAt);
}
