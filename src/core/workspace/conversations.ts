import type { Conversation } from '../../types';
import { isRsiConversation } from '../agents/rsiConversation';

export { isRsiConversation };

/**
 * Chat conversation: dialogue-only, unbound from any project workspace,
 * and never an RSI session.
 */
export function isChatConversation(conv: Conversation): boolean {
  return !isRsiConversation(conv) && conv.agentMode !== 'rsi' && (Boolean(conv.isChatMode) || !conv.rootPath);
}

/**
 * Work conversation: bound to a project workspace directory,
 * not flagged as chat-only, and never an RSI session.
 */
export function isWorkConversation(conv: Conversation): boolean {
  return !isRsiConversation(conv) && conv.agentMode !== 'rsi' && !conv.isChatMode && Boolean(conv.rootPath);
}

/**
 * Group conversations by their bound folder so one folder can hold many chats.
 * Pure helper — extracted for testing and to keep Sidebar rendering cheap.
 * Order: current folder first, then most-recent Work folders, with unbound
 * Chat always last. Conversations keep their incoming order inside each group.
 */
export function groupConversationsByFolder(
  conversations: Conversation[],
  currentRootPath: string | null,
): [folderKey: string, items: Conversation[]][] {
  const map = new Map<string, Conversation[]>();
  for (const conv of conversations) {
    const key = conv.rootPath || '';
    const list = map.get(key);
    if (list) list.push(conv);
    else map.set(key, [conv]);
  }
  const entries = Array.from(map.entries());
  const latest = (items: Conversation[]) =>
    items.reduce((m, c) => Math.max(m, c.updatedAt), 0);
  entries.sort((a, b) => {
    if (!a[0]) return 1;
    if (!b[0]) return -1;
    if (a[0] && a[0] === currentRootPath) return -1;
    if (b[0] && b[0] === currentRootPath) return 1;
    return latest(b[1]) - latest(a[1]);
  });
  return entries;
}

export function folderDisplayName(folderKey: string): string {
  if (!folderKey) return '';
  return folderKey.split('/').pop() || folderKey;
}

/**
 * Open directories define the project list, including projects with no chats.
 * Closed projects keep their chats in the list (after the open ones, newest
 * first) so closing a folder never orphans a conversation: closing is
 * memory-only, and opening one of its chats reopens the folder.
 */
export function groupOpenProjectConversations(
  conversations: Conversation[],
  openRoots: string[],
): [folderKey: string, items: Conversation[]][] {
  const groups = new Map<string, Conversation[]>(
    [...new Set(openRoots.filter(Boolean))].map((path) => [path, []]),
  );
  const closed = new Map<string, Conversation[]>();
  for (const conversation of conversations) {
    if (!isWorkConversation(conversation)) continue;
    const key = conversation.rootPath!;
    const open = groups.get(key);
    if (open) {
      open.push(conversation);
      continue;
    }
    const list = closed.get(key);
    if (list) list.push(conversation);
    else closed.set(key, [conversation]);
  }
  const latest = (items: Conversation[]) => items.reduce((m, c) => Math.max(m, c.updatedAt), 0);
  return [
    ...groups.entries(),
    ...Array.from(closed.entries()).sort((a, b) => latest(b[1]) - latest(a[1])),
  ];
}

/**
 * A conversation that has never been used: no messages, still carries the
 * default title, and — for RSI — no configured direction or run history.
 * Renaming or configuring an empty conversation marks it as intentional work,
 * so it is never silently reopened by the "+" button.
 */
export function isBlankConversation(conv: Conversation, messageCount: number): boolean {
  if (messageCount > 0) return false;
  if (conv.title && conv.title !== 'New Chat') return false;
  if (isRsiConversation(conv) && conv.rsi) {
    if (conv.rsi.status !== 'idle' || conv.rsi.runs.length > 0) return false;
    if (Object.values(conv.rsi.directionConfig).some((value) => value.trim())) return false;
  }
  return true;
}

/**
 * Pick an existing unused conversation for the requested mode and folder.
 *
 * `messageCounts` is the persisted count per conversation. When it is null
 * (older main process / tests), only the active conversation's in-memory
 * transcript is trusted; every other conversation is treated as used so we
 * never reopen a transcript whose contents we cannot verify.
 */
export function pickReusableConversation(
  conversations: Conversation[],
  mode: 'chat' | 'work' | 'rsi',
  rootPath: string | null,
  activeConversationId: string | null,
  activeMessageCount: number,
  messageCounts: Record<string, number> | null,
): Conversation | null {
  const candidates = conversations.filter((conv) => {
    if (mode === 'rsi') {
      if (!isRsiConversation(conv)) return false;
    } else {
      if (isRsiConversation(conv) || conv.agentMode === 'rsi') return false;
      if (mode === 'chat' ? !isChatConversation(conv) : !isWorkConversation(conv)) return false;
    }
    if ((conv.rootPath || null) !== (rootPath || null)) return false;
    const count = conv.id === activeConversationId
      ? activeMessageCount
      : messageCounts
        ? (messageCounts[conv.id] ?? 0)
        : 1;
    return isBlankConversation(conv, count);
  });

  // The conversation already on screen wins (clicking + becomes a no-op);
  // otherwise prefer the most recently touched blank row.
  return candidates.sort((a, b) => {
    if (a.id === activeConversationId) return -1;
    if (b.id === activeConversationId) return 1;
    return b.updatedAt - a.updatedAt;
  })[0] ?? null;
}
