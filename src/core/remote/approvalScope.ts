import type { CodeChange } from '../../stores/codeChanges.store';

/** Pending/history cards on the phone must belong to the chat it mirrors. */
export function changesForActiveConversation(
  changes: CodeChange[],
  activeConversationId: string | null,
  visibleMessageIds: Set<string>,
): CodeChange[] {
  if (!activeConversationId) return [];
  return changes.filter((change) =>
    change.conversationId === activeConversationId
    || (!change.conversationId && !!change.messageId && visibleMessageIds.has(change.messageId)),
  );
}

/** Commands remain explicit one-by-one approvals on desktop and phone. */
export function bulkApprovableChanges(changes: CodeChange[]): CodeChange[] {
  return changes.filter((change) => change.status === 'pending' && change.kind !== 'exec');
}
