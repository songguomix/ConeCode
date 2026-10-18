import { useMemo } from 'react';
import { useChatStore, useCodeChangesStore } from '../../stores';
import { changesForActiveConversation } from '../../core/remote/approvalScope';

/** All file-change surfaces share the same conversation boundary. */
export function useConversationChanges() {
  const changes = useCodeChangesStore((s) => s.changes);
  const conversationId = useChatStore((s) => s.activeConversationId);
  const messages = useChatStore((s) => s.messages);
  return useMemo(() => changesForActiveConversation(changes, conversationId,
    new Set(messages.filter((m) => m.conversationId === conversationId).map((m) => m.id))),
  [changes, conversationId, messages]);
}
