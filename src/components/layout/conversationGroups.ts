import { normalizeRoot, rootLabel } from '../../core/workspace/roots';

export interface GroupableConversation {
  id: string;
  title: string;
  rootPath?: string | null;
  updatedAt: number;
}

export interface ConversationGroup {
  /** Stable React key: normalized folder path, or '' for the no-project group. */
  key: string;
  rootPath: string | null;
  /** Folder display name. Empty for the no-project group — UI fills i18n. */
  label: string;
  kind: 'folder' | 'none';
  conversations: GroupableConversation[];
}

/**
 * Codex-style sidebar order: one group per mother folder, chats nested under
 * it. Conversations with no folder share a single trailing group.
 *
 * Pure — the sidebar only renders what this returns, so sorting and grouping
 * stay testable without mounting React.
 */
export function groupConversationsByRoot(
  conversations: GroupableConversation[],
  labels?: Map<string, string>,
): ConversationGroup[] {
  const buckets = new Map<string, GroupableConversation[]>();
  for (const conv of conversations) {
    const key = normalizeRoot(conv.rootPath || '');
    const list = buckets.get(key);
    if (list) list.push(conv);
    else buckets.set(key, [conv]);
  }

  // All known folder paths, so two folders named "web" can be told apart in labels.
  const allRoots = [...buckets.keys()].filter(Boolean);

  const groups: ConversationGroup[] = [];
  for (const [key, list] of buckets) {
    const ordered = [...list].sort((a, b) => b.updatedAt - a.updatedAt);
    if (!key) {
      groups.push({
        key: '',
        rootPath: null,
        label: '',
        kind: 'none',
        conversations: ordered,
      });
      continue;
    }
    groups.push({
      key,
      rootPath: key,
      label: labels?.get(key) ?? rootLabel(key, allRoots),
      kind: 'folder',
      conversations: ordered,
    });
  }

  // Folder groups first (most recently active first); the no-project group last.
  groups.sort((a, b) => {
    if (a.kind !== b.kind) return a.kind === 'folder' ? -1 : 1;
    return (b.conversations[0]?.updatedAt ?? 0) - (a.conversations[0]?.updatedAt ?? 0);
  });
  return groups;
}
