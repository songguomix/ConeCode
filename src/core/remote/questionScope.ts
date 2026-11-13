import type { Message } from '../../types/chat.types';

type QuestionMessage = Pick<Message, 'id' | 'conversationId' | 'role' | 'isQuestion' | 'isToolResult'>;

/** Match ChatView: only the latest unanswered question in the active chat can accept a reply. */
export function remoteQuestion<T extends QuestionMessage>(messages: readonly T[], conversationId: string | null): T | null {
  if (!conversationId) return null;
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i];
    if (message.conversationId !== conversationId) continue;
    if (message.role === 'user' && !message.isToolResult) return null;
    if (message.isQuestion) return message;
  }
  return null;
}
