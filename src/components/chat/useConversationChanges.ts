import { useMemo } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { useChatStore, useCodeChangesStore } from '../../stores';
import { changesForActiveConversation } from '../../core/remote/approvalScope';

/** All file-change surfaces share the same conversation boundary. */
export function useConversationChanges() {
  const conversationId = useChatStore((s) => s.activeConversationId);
  const messages = useChatStore((s) => s.messages);
  const messageIds = useMemo(() => new Set(messages.filter((m) => m.conversationId === conversationId).map((m) => m.id)),
    [conversationId, messages]);
  return useCodeChangesStore(useShallow((s) => changesForActiveConversation(s.changes, conversationId, messageIds)));
}
