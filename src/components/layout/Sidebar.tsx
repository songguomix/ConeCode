import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { FiPlus, FiSettings, FiTrash2, FiGlobe, FiEdit3, FiMenu, FiTerminal, FiFileText, FiSmartphone, FiMonitor, FiCpu, FiGrid, FiShield, FiGitBranch, FiLoader, FiFolder, FiMessageSquare, FiBriefcase, FiChevronDown, FiChevronRight, FiClock, FiShare2 } from 'react-icons/fi';
import { useChatStore, useUIStore, useLanguageStore, usePreviewStore, useComputerStore, useModelStore, useCodeChangesStore, useWorkspaceStore, useAiHighlightsStore, useSettingsStore, LOCALES, type Locale } from '../../stores';
import { useBackgroundStore } from '../../stores/background.store';
import { groupConversationsByFolder } from '../../core/workspace/conversations';
import HandoffPanel from '../handoff/HandoffPanel';
import { mostUrgentDot, type DotKind } from './panelDot';
import FileTree from './FileTree';

interface PanelItem {
  key: string;
  icon: ReactNode;
  label: string;
  open: boolean;
  toggle: () => void;
  /** Live state worth showing even when the panel is closed. */
  dot?: DotKind | null;
}

function StatusDot({ kind, className = '' }: { kind: DotKind; className?: string }) {
  const style: Record<DotKind, string> = {
    'success': 'bg-[var(--success)]',
    'warning-pulse': 'bg-[var(--warning)] animate-pulse',
    'error': 'bg-[var(--error)]',
    'error-pulse': 'bg-[var(--error)] animate-pulse',
  };
  return <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${style[kind]} ${className}`} />;
}

export default function Sidebar() {
  const viewMode = useUIStore((s) => s.viewMode);
  const setViewMode = useUIStore((s) => s.setViewMode);
  const [panelsOpen, setPanelsOpen] = useState(false);
  // The panels menu lives in body coordinates (portal): sidebar width,
  // overflow, or backdrop-blur must never clip or squeeze it. Right-aligned
  // to the button, but clamped into the viewport — at the narrowest sidebar
  // the button sits too far left for a blind right-align (menu would run off
  // the screen's left edge), so it slides right instead of clipping.
  const panelsBtnRef = useRef<HTMLDivElement>(null);
  const [panelsPos, setPanelsPos] = useState<{ top: number; left: number } | null>(null);
  const sidebarWidthPx = useUIStore((s) => s.sidebarWidthPx);
  useEffect(() => {
    if (!panelsOpen) return;
    const place = () => {
      const r = panelsBtnRef.current?.getBoundingClientRect();
      if (!r) return;
      const W = 176; // w-44
      setPanelsPos({
        top: r.bottom + 4,
        left: Math.max(8, Math.min(r.right - W, window.innerWidth - W - 8)),
      });
    };
    place();
    window.addEventListener('resize', place);
    return () => window.removeEventListener('resize', place);
    // sidebarWidthPx: re-anchor while the user drags the sidebar under the menu.
  }, [panelsOpen, sidebarWidthPx]);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const [handoffOpen, setHandoffOpen] = useState(false);
  // Collapsed group keys. Default expanded — Codex shows the chats under each
  // mother folder without requiring a click first.
  const [collapsedGroups, setCollapsedGroups] = useState<Set<string>>(() => new Set());
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  // String keys are referentially stable across runs with the same members, so
  // token flushes that only rewrite streamingRuns[...].content don't re-render
  // the sidebar. Object.keys() alone allocated a new array every store tick.
  const runningKey = useChatStore((s) => Object.keys(s.streamingRuns).join('\0'));
  const runningConversationIds = useMemo(
    () => (runningKey ? runningKey.split('\0') : []),
    [runningKey],
  );
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const closeFolderGroup = useChatStore((s) => s.closeFolderGroup);
  const deleteConversation = useChatStore((s) => s.deleteConversation);
  const renameConversation = useChatStore((s) => s.renameConversation);
  const createConversation = useChatStore((s) => s.createConversation);
  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const changedFilesOpen = useUIStore((s) => s.changedFilesOpen);
  const toggleChangedFiles = useUIStore((s) => s.toggleChangedFiles);
  const reviewOpen = useUIStore((s) => s.reviewOpen);
  const toggleReview = useUIStore((s) => s.toggleReview);
  const worktreesOpen = useUIStore((s) => s.worktreesOpen);
  const toggleWorktrees = useUIStore((s) => s.toggleWorktrees);
  const remoteOpen = useUIStore((s) => s.remoteOpen);
  const toggleRemote = useUIStore((s) => s.toggleRemote);
  const previewOpen = useUIStore((s) => s.previewOpen);
  const togglePreview = useUIStore((s) => s.togglePreview);
  const previewState = usePreviewStore((s) => s.state);
  const computerOpen = useUIStore((s) => s.computerOpen);
  const toggleComputer = useUIStore((s) => s.toggleComputer);
  const computerEnabled = useComputerStore((s) => s.enabled);
  const backgroundOpen = useUIStore((s) => s.backgroundOpen);
  const toggleBackground = useUIStore((s) => s.toggleBackground);
  const bgTasks = useBackgroundStore((s) => s.tasks);
  const bgRunning = Object.values(bgTasks).some((task) => task.status === 'running');
  const bgUnseen = Object.values(bgTasks).filter((task) => task.unseen).length;
  const { locale, setLocale, t } = useLanguageStore();
  const changes = useCodeChangesStore((s) => s.changes);
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  // One folder holds many conversations: group the list by its bound folder so
  // it reads as "folder → its chats" instead of one flat, ambiguous list.
  const groups = useMemo(
    () => groupConversationsByFolder(conversations, rootPath),
    [conversations, rootPath],
  );

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Primary panels earn toolbar-menu slots; low-frequency tools live under a
  // second section so the list stays scannable (integration pass: 7 → 4 + more).
  const primaryPanels: PanelItem[] = [
    { key: 'terminal', icon: <FiTerminal size={15} />, label: t('terminal'), open: terminalOpen, toggle: toggleTerminal },
    { key: 'changed', icon: <FiFileText size={15} />, label: t('changedFiles'), open: changedFilesOpen, toggle: toggleChangedFiles },
    { key: 'review', icon: <FiShield size={15} />, label: t('codeReview'), open: reviewOpen, toggle: toggleReview },
    { key: 'preview', icon: <FiMonitor size={15} />, label: t('preview'), open: previewOpen, toggle: togglePreview, dot: previewState === 'idle' ? null : previewState === 'running' ? 'success' : previewState === 'starting' ? 'warning-pulse' : 'error' },
  ];
  const extraPanels: PanelItem[] = [
    { key: 'background', icon: <FiClock size={15} />, label: `${t('backgroundTasks')}${bgUnseen > 0 ? ` · ${bgUnseen}` : ''}`, open: backgroundOpen, toggle: toggleBackground, dot: bgUnseen > 0 ? 'warning-pulse' : bgRunning ? 'success' : null },
    { key: 'worktrees', icon: <FiGitBranch size={15} />, label: t('worktrees'), open: worktreesOpen, toggle: toggleWorktrees },
    { key: 'remote', icon: <FiSmartphone size={15} />, label: t('remoteControl'), open: remoteOpen, toggle: toggleRemote },
    { key: 'computer', icon: <FiCpu size={15} />, label: t('computerControl'), open: computerOpen, toggle: toggleComputer, dot: computerEnabled ? 'error-pulse' : null },
  ];
  const panels = [...primaryPanels, ...extraPanels];
  // Live state must survive being folded into a menu: a running dev server, and
  // above all the agent holding the real mouse, stay visible on the trigger.
  const triggerDot = mostUrgentDot(panels.map((p) => p.dot));
  const anyPanelOpen = panels.some((p) => p.open);

  const changedFileNames = (conversationId: string) => Array.from(new Set(
    changes
      .filter((change) => change.conversationId === conversationId && !change.filePath.startsWith('['))
      .map((change) => change.filePath.split('/').pop() || change.filePath),
  )).slice(0, 2);

  // Green AI marks currently live in the editor, grouped per file. A chat row
  // gets the dot when any file it touched still carries AI-written lines.
  const aiLines = useAiHighlightsStore((s) => s.lines);
  const aiCountFor = (conversationId: string) => {
    const touched = new Set(
      changes
        .filter((c) => c.conversationId === conversationId && (c.kind === 'edit' || c.kind === 'create'))
        .map((c) => c.filePath),
    );
    let n = 0;
    for (const f of touched) n += aiLines[f]?.length ?? 0;
    return n;
  };

  const handleRename = (id: string) => {
    if (editTitle.trim()) {
      renameConversation(id, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="w-full h-full flex flex-col bg-[var(--glass-surface)] backdrop-blur-3xl border-r border-[var(--glass-border)] min-h-0 relative shadow-[inset_-1px_0_0_0_var(--glass-border)]">
      {/* Clean drag spacer for macOS traffic lights with no corner badge */}
      <div className="h-[44px] shrink-0" style={{ WebkitAppRegion: 'drag' } as any} />
      {/* Toolbar — the row itself drags the window; buttons opt out. */}
      <div className="flex items-center gap-1.5 px-3 pb-2.5 shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
        <button onClick={toggleSidebar}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all">
          <FiMenu size={16} />
        </button>
        <div className="flex-1" />

        <div ref={panelsBtnRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button onClick={() => setPanelsOpen(!panelsOpen)}
            className={`relative w-8 h-8 rounded-xl flex items-center justify-center transition-all ${
              panelsOpen || anyPanelOpen
                ? 'text-[var(--accent)] bg-[var(--accent-soft)] shadow-2xs border border-[var(--accent)]/30'
                : 'text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] border border-transparent hover:border-[var(--glass-border)]'
            }`}
            title={t('panels')}
            aria-haspopup="menu"
            aria-expanded={panelsOpen}>
            <FiGrid size={15} />
            {triggerDot && <StatusDot kind={triggerDot} className="absolute top-1 right-1" />}
          </button>
          {panelsOpen && panelsPos && createPortal(
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPanelsOpen(false)} />
              <div role="menu"
                className="fixed w-48 bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-2xl shadow-2xl z-50 overflow-hidden py-1.5 anim-menu ring-1 ring-black/5 dark:ring-white/10"
                style={{ top: panelsPos.top, left: panelsPos.left }}>
                {primaryPanels.map((p) => (
                  <button key={p.key} role="menuitem" aria-pressed={p.open}
                    onClick={() => p.toggle()}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors ${
                      p.open ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]/60 hover:text-[var(--text-primary)]'
                    }`}>
                    {p.icon}
                    <span className="flex-1 text-left truncate">{p.label}</span>
                    {p.dot && <StatusDot kind={p.dot} />}
                  </button>
                ))}
                <div className="my-1.5 border-t border-[var(--glass-border)]" />
                <div className="px-3 pb-1 text-[10px] uppercase tracking-wider text-[var(--text-muted)] font-semibold">
                  {t('panelsMore')}
                </div>
                {extraPanels.map((p) => (
                  <button key={p.key} role="menuitem" aria-pressed={p.open}
                    onClick={() => p.toggle()}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors ${
                      p.open ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]/60 hover:text-[var(--text-primary)]'
                    }`}>
                    {p.icon}
                    <span className="flex-1 text-left truncate">{p.label}</span>
                    {p.dot && <StatusDot kind={p.dot} />}
                  </button>
                ))}
              </div>
            </>,
            document.body,
          )}
        </div>

        <button onClick={() => createConversation(selectedModel?.providerId || '', selectedModel?.id || '')}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all"
          title={t('newChat')}>
          <FiPlus size={16} />
        </button>
        <button onClick={() => setHandoffOpen(true)}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all"
          title={t('handoffButton')}>
          <FiShare2 size={15} />
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0 px-2 min-w-0 overflow-hidden">
        {/* Bound the conversation list so Chat cannot displace the file explorer. */}
        <div className="min-h-0 max-h-[50%] shrink-0 overflow-y-auto overscroll-contain">
        {/* Section 1 — Work folders followed by Chat. */}
        <div className="px-1 pt-1 pb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
          <FiMessageSquare size={10} />
          {t('conversations')} · {conversations.length}
        </div>
        <div className="space-y-2.5">
          {groups.map(([folderKey, items]) => {
            const isCurrent = !!folderKey && folderKey === rootPath;
            const collapsed = collapsedGroups.has(folderKey || '__nofolder__');
            return (
              <div key={folderKey || '__nofolder__'} className="min-w-0">
                {/* Folder badge — a floating card above its chats, not a chat row.
                    Single click closes the folder (→ home default); the chevron
                    only collapses the group. */}
                <div
                  onClick={folderKey ? () => void closeFolderGroup(folderKey) : undefined}
                  title={folderKey ? t('closeFolder') : undefined}
                  className={`flex items-center gap-1 px-2.5 py-2 rounded-xl min-w-0 border backdrop-blur-xl transition-all shadow-2xs hover:shadow-md ${
                    folderKey ? 'cursor-pointer' : ''
                  } ${
                    isCurrent
                      ? 'bg-[var(--accent-soft)]/80 border-[var(--accent)]/40 text-[var(--accent)] shadow-[0_2px_12px_rgba(201,100,66,0.12)]'
                      : 'bg-[var(--glass-card)] border-[var(--glass-border)] text-[var(--text-secondary)] hover:border-[var(--border)] hover:bg-[var(--bg-2)]/90'
                  }`}
                >
                  <button
                    onClick={(e) => { e.stopPropagation(); toggleGroup(folderKey || '__nofolder__'); }}
                    aria-expanded={!collapsed}
                    title={t('collapseAll')}
                    className="p-0.5 -ml-1 rounded-lg hover:bg-[var(--bg-3)]/80 text-[var(--text-muted)] shrink-0 transition-colors"
                  >
                    {collapsed ? <FiChevronRight size={12} /> : <FiChevronDown size={12} />}
                  </button>
                  {folderKey ? (
                    <FiFolder size={13} className="shrink-0 text-amber-500" />
                  ) : (
                    <FiMessageSquare size={13} className="shrink-0 text-[var(--accent)]" />
                  )}
                  <span className="flex-1 truncate text-[12px] font-bold uppercase tracking-wide min-w-0 font-serif">
                    {folderKey ? folderKey.split('/').pop() || folderKey : t('chat')}
                  </span>
                  <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                    isCurrent ? 'bg-[var(--accent)] text-white shadow-2xs' : 'bg-[var(--bg-3)] text-[var(--text-muted)]'
                  }`}>
                    {items.length}
                  </span>
                </div>
                {/* Chats hang under the floating folder badge, indented with a guide line. */}
                {!collapsed && (
                <div className="ml-3 pl-2.5 border-l border-[var(--border)] mt-1.5 space-y-0.5">
                  {items.map((conv) => (
                    <div key={conv.id}
                      onClick={() => {
                        if (editingId !== conv.id) {
                          setActiveConversation(conv.id);
                          setViewMode(conv.rootPath ? 'work' : 'chat');
                        }
                      }}
                      className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-xl cursor-pointer text-[13px] transition-all min-w-0 ${
                        activeConversationId === conv.id
                          ? 'bg-[var(--glass-card)] text-[var(--text-primary)] font-medium shadow-xs border border-[var(--glass-border)] ring-1 ring-[var(--accent)]/20'
                          : 'text-[var(--text-secondary)] hover:bg-[var(--glass-card)]/60 hover:text-[var(--text-primary)] border border-transparent'
                      }`}>
                      {editingId === conv.id ? (
                        <input
                          value={editTitle}
                          onChange={(e) => setEditTitle(e.target.value)}
                          onBlur={() => handleRename(conv.id)}
                          onKeyDown={(e) => {
                            if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) handleRename(conv.id);
                            if (e.key === 'Escape') setEditingId(null);
                          }}
                          className="flex-1 min-w-0 bg-[var(--bg-2)] border border-[var(--accent)] rounded-lg px-2 py-0.5 text-sm outline-none"
                          autoFocus
                          onClick={(e) => e.stopPropagation()}
                        />
                      ) : (
                        <div className="flex-1 min-w-0">
                          <div className="flex items-center gap-1.5 min-w-0">
                            <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${
                              runningConversationIds.includes(conv.id)
                                ? 'bg-[var(--accent)] animate-pulse'
                                : activeConversationId === conv.id
                                  ? 'bg-[var(--accent)]'
                                  : 'bg-[var(--border)]'
                            }`} />
                            <span className="truncate">{conv.title}</span>
                            {aiCountFor(conv.id) > 0 && (
                              <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0" title={t('aiChanges')} />
                            )}
                            {runningConversationIds.includes(conv.id) && (
                              <FiLoader size={11} className="shrink-0 text-[var(--accent)] animate-spin" />
                            )}
                          </div>
                          {changedFileNames(conv.id).length > 0 && (
                            <div className="mt-0.5 truncate text-[10px] font-normal text-[var(--text-muted)]">
                              {changedFileNames(conv.id).join(', ')}
                            </div>
                          )}
                        </div>
                      )}
                      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
                        <button onClick={(e) => { e.stopPropagation(); setEditingId(conv.id); setEditTitle(conv.title); }}
                          className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-4)]">
                          <FiEdit3 size={12} />
                        </button>
                        <button onClick={(e) => { e.stopPropagation(); deleteConversation(conv.id); }}
                          className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-4)]">
                          <FiTrash2 size={12} />
                        </button>
                      </div>
                    </div>
                  ))}
                </div>
                )}
              </div>
            );
          })}
          {conversations.length === 0 && (
            <p className="px-2 py-1 text-[11px] text-[var(--text-muted)]">{t('homeOpenFolderBody')}</p>
          )}
        </div>

        </div>

        {/* The file explorer keeps its own space and scroll position. */}
        <div className="flex-1 min-h-0 flex flex-col border-t border-[var(--border)] mt-3">
          <div className="shrink-0 px-1 pt-1.5 pb-0.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
            <FiFolder size={10} className="text-amber-500" />
            {t('files')}
          </div>
          <FileTree />
        </div>
      </div>

      <div className="p-2.5 border-t border-[var(--glass-border)] bg-[var(--glass-subtle)]/30">
        <div className="flex items-center gap-1.5">
          {/* Chat / Work capsule pill */}
          <div className="flex-1 flex items-center p-0.5 rounded-xl bg-[var(--bg-2)]/80 border border-[var(--glass-border)] shadow-2xs">
            <button
              onClick={() => {
                setViewMode('chat');
                const store = useChatStore.getState();
                const current = store.conversations.find((c) => c.id === store.activeConversationId);
                if (current?.rootPath) {
                  const unbound = store.conversations.find((c) => !c.rootPath);
                  if (unbound) {
                    store.setActiveConversation(unbound.id);
                  } else {
                    createConversation(selectedModel?.providerId || '', selectedModel?.id || '', null);
                  }
                }
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[12px] font-medium transition-all ${
                viewMode === 'chat'
                  ? 'bg-[var(--glass-card)] text-[var(--accent)] shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={t('chat')}
            >
              <FiMessageSquare size={13} className={viewMode === 'chat' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <span>{t('chat')}</span>
            </button>
            <button
              onClick={() => {
                setViewMode('work');
                const store = useChatStore.getState();
                const current = store.conversations.find((c) => c.id === store.activeConversationId);
                if (!current?.rootPath) {
                  const workConv = store.conversations.find((c) => !!c.rootPath);
                  if (workConv) {
                    store.setActiveConversation(workConv.id);
                  }
                }
              }}
              className={`flex-1 flex items-center justify-center gap-1.5 py-1.5 px-2 rounded-lg text-[12px] font-medium transition-all ${
                viewMode === 'work'
                  ? 'bg-[var(--glass-card)] text-[var(--accent)] shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={t('work')}
            >
              <FiBriefcase size={13} className={viewMode === 'work' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <span>{t('work')}</span>
            </button>
          </div>

          {/* Settings button */}
          <button
            onClick={toggleSettings}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] border border-transparent hover:border-[var(--glass-border)] transition-all shadow-2xs shrink-0"
            title={t('settings')}
          >
            <FiSettings size={15} />
          </button>
        </div>
      </div>
      {handoffOpen && <HandoffPanel onClose={() => setHandoffOpen(false)} />}
    </div>
  );
}
