import type { Conversation } from '../../types';

/**
 * Group conversations by their bound folder so one folder can hold many chats.
 * Pure helper — extracted for testing and to keep Sidebar rendering cheap.
 * Order: current folder first, then most-recent group first; chats keep their
 * incoming order inside each group.
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
