import { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import type { ReactNode } from 'react';
import { FiPlus, FiSettings, FiTrash2, FiGlobe, FiEdit3, FiMenu, FiTerminal, FiFileText, FiSmartphone, FiMonitor, FiCpu, FiGrid, FiShield, FiGitBranch, FiLoader, FiMessageSquare, FiBriefcase, FiChevronDown, FiChevronRight, FiClock, FiShare2, FiX, FiZap, FiPackage, FiFolder } from 'react-icons/fi';
import { useChatStore, useUIStore, useLanguageStore, usePreviewStore, useComputerStore, useModelStore, useCodeChangesStore, useWorkspaceStore, useAiHighlightsStore, useSettingsStore, LOCALES, type Locale } from '../../stores';
import { useBackgroundStore } from '../../stores/background.store';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import { groupConversationsByFolder, groupOpenProjectConversations, isChatConversation, isWorkConversation, isRsiConversation } from '../../core/workspace/conversations';
import { rootLabel } from '../../core/workspace/roots';
import HandoffPanel from '../handoff/HandoffPanel';
import { mostUrgentDot, type DotKind } from './panelDot';
import { rsiSidebarLayout } from './rsiLayout';
import RsiFolderHint from './RsiFolderHint';
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

/** Compact timestamp for conversation rows. */
function shortTime(ts: number): string {
  const d = new Date(ts);
  const now = new Date();
  return d.toDateString() === now.toDateString()
    ? d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
    : d.toLocaleDateString([], { month: 'short', day: 'numeric' });
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
      const W = 192; // w-48
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
  const newConversation = useChatStore((s) => s.newConversation);
  const newRsiConversation = useChatStore((s) => s.newRsiConversation);
  const agentMode = useChatStore((s) => s.agentMode);
  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const openMarket = useDshMarketStore((s) => s.openPanel);
  const toggleSidebar = useUIStore((s) => s.toggleSidebar);
  const fileTreeOpen = useUIStore((s) => s.fileTreeOpen);
  const toggleFileTree = useUIStore((s) => s.toggleFileTree);
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
  const extraRoots = useWorkspaceStore((s) => s.extraRoots);
  const addRootFromDialog = useWorkspaceStore((s) => s.addRootFromDialog);
  const closeRoot = useWorkspaceStore((s) => s.closeRoot);
  const sidebar = rsiSidebarLayout({ agentMode, viewMode });
  const openFolderPaths = useMemo(
    () => [rootPath, ...extraRoots.map((r) => r.path)].filter((p): p is string => !!p),
    [rootPath, extraRoots],
  );

  // Conversations are strictly isolated by mode:
  // - Chat mode only shows chat-mode/unbound conversations.
  // - Work mode only shows workspace-bound normal work conversations grouped by folder.
  // - RSI mode shows workspace-bound RSI recursive improvement conversations grouped by folder.
  const chatConversations = useMemo(
    () => conversations.filter(isChatConversation),
    [conversations],
  );

  const workConversations = useMemo(
    () => conversations.filter(isWorkConversation),
    [conversations],
  );

  const rsiConversations = useMemo(
    () => conversations.filter(isRsiConversation),
    [conversations],
  );

  const workGroups = useMemo(
    () => groupOpenProjectConversations(workConversations, openFolderPaths),
    [workConversations, openFolderPaths],
  );

  const rsiGroups = useMemo(
    () => groupConversationsByFolder(rsiConversations, rootPath),
    [rsiConversations, rootPath],
  );

  // Work keeps file browsing beside the project list; collapsing it hands the
  // whole column to the projects (the choice is remembered by the UI store).
  const filesOpen = sidebar.showFileExplorer && fileTreeOpen;
  const convAreaClass = !filesOpen || sidebar.fillConversations
    ? 'flex-1'
    : 'max-h-[50%] shrink-0';
  // Labels disambiguate against every listed project, closed ones included.
  const projectPaths = useMemo(() => workGroups.map(([path]) => path), [workGroups]);

  const toggleGroup = (key: string) => {
    setCollapsedGroups((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  // Keep every panel in one flat list: the toolbar menu stays compact and
  // live state is not split behind an extra section label.
  const panels: PanelItem[] = [
    { key: 'terminal', icon: <FiTerminal size={15} />, label: t('terminal'), open: terminalOpen, toggle: toggleTerminal },
    { key: 'background', icon: <FiClock size={15} />, label: `${t('backgroundTasks')}${bgUnseen > 0 ? ` · ${bgUnseen}` : ''}`, open: backgroundOpen, toggle: toggleBackground, dot: bgUnseen > 0 ? 'warning-pulse' : bgRunning ? 'success' : null },
    { key: 'changed', icon: <FiFileText size={15} />, label: t('changedFiles'), open: changedFilesOpen, toggle: toggleChangedFiles },
    { key: 'review', icon: <FiShield size={15} />, label: t('codeReview'), open: reviewOpen, toggle: toggleReview },
    { key: 'preview', icon: <FiMonitor size={15} />, label: t('preview'), open: previewOpen, toggle: togglePreview, dot: previewState === 'starting' ? 'warning-pulse' : previewState === 'error' ? 'error' : null },
    { key: 'worktrees', icon: <FiGitBranch size={15} />, label: t('worktrees'), open: worktreesOpen, toggle: toggleWorktrees },
    { key: 'remote', icon: <FiSmartphone size={15} />, label: t('remoteControl'), open: remoteOpen, toggle: toggleRemote },
    { key: 'computer', icon: <FiCpu size={15} />, label: t('computerControl'), open: computerOpen, toggle: toggleComputer, dot: computerEnabled ? 'error-pulse' : null },
  ];
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

  const [folderError, setFolderError] = useState<string | null>(null);
  const [projectBusy, setProjectBusy] = useState(false);

  const handleAddProject = async () => {
    setFolderError(null);
    setProjectBusy(true);
    try {
      const result = await addRootFromDialog();
      if (!result.ok && result.reason && result.reason !== 'empty') {
        setFolderError(t(`addFolder_${result.reason}`));
      }
    } catch {
      setFolderError(t('projectOperationFailed'));
    } finally {
      setProjectBusy(false);
    }
  };

  const handleProjectChat = async (openChat: () => Promise<string>) => {
    setFolderError(null);
    setProjectBusy(true);
    try {
      const id = await openChat();
      if (useChatStore.getState().activeConversationId !== id) return;
      const conversation = useChatStore.getState().conversations.find((item) => item.id === id);
      const path = conversation?.rootPath;
      if (!path) return;
      const workspace = useWorkspaceStore.getState();
      // A per-project + must also point the agent's workspace at that project.
      if (workspace.rootPath !== path && !await workspace.openFolderPath(path)) {
        throw new Error('Project folder is unavailable');
      }
      if (useChatStore.getState().activeConversationId !== id) return;
      // Keep the other open projects in the list when a chat restores its snapshot.
      let snapshotComplete = true;
      for (const openPath of openFolderPaths) {
        if (useWorkspaceStore.getState().allRoots().includes(openPath)) continue;
        const added = await workspace.addRoot(openPath);
        // A project nested in another one cannot be reopened; remember that so
        // the conversation keeps its saved snapshot instead of a truncated one.
        if (!added.ok) snapshotComplete = false;
      }
      if (useChatStore.getState().activeConversationId !== id) return;
      const extraPaths = useWorkspaceStore.getState().extraRoots.map((root) => root.path);
      const savedExtras = conversation.extraRoots ?? [];
      if (snapshotComplete && (extraPaths.length !== savedExtras.length || extraPaths.some((root, index) => root !== savedExtras[index]))) {
        await useChatStore.getState().setConversationFolder(path);
      }
      setCollapsedGroups((previous) => {
        const next = new Set(previous);
        next.delete(path);
        return next;
      });
    } catch {
      setFolderError(t('projectOperationFailed'));
    } finally {
      setProjectBusy(false);
    }
  };

  // RSI never lists files: picking a folder is the only workspace action it
  // exposes. Persist the binding so the active RSI chat keeps its folders.
  const handleAddRsiFolder = async () => {
    setFolderError(null);
    try {
      const result = await addRootFromDialog();
      if (result.ok) {
        await useChatStore.getState().setConversationFolder(useWorkspaceStore.getState().rootPath);
      } else if (result.reason && result.reason !== 'empty') {
        setFolderError(t(`addFolder_${result.reason}`));
      }
    } catch {
      setFolderError(t('rsiOperationFailed'));
    }
  };

  const handleRemoveRsiFolder = (path: string) => {
    setFolderError(null);
    closeRoot(path);
  };

  const renderConvRow = (conv: typeof conversations[number], isWork = false, isRsi = false) => {
    const isRunning = runningConversationIds.includes(conv.id) || (isRsi && conv.rsi?.status === 'running');
    const isCompleted = isRsi && conv.rsi?.status === 'completed';
    const isFailed = isRsi && conv.rsi?.status === 'failed';

    const dotClass = isRunning
      ? 'bg-[var(--accent)] animate-pulse'
      : isCompleted
        ? 'bg-[var(--success)]'
        : isFailed
          ? 'bg-[var(--error)]'
          : activeConversationId === conv.id
            ? 'bg-[var(--accent)]'
            : 'bg-[var(--border)]';

    return (
      <div key={conv.id}
        role="button" tabIndex={editingId === conv.id ? -1 : 0}
        aria-current={activeConversationId === conv.id ? 'page' : undefined}
        onKeyDown={(e) => {
          if (e.target !== e.currentTarget || editingId === conv.id || (e.key !== 'Enter' && e.key !== ' ')) return;
          e.preventDefault();
          if (isWork && !isRsi && projectBusy) return;
          if (isWork && !isRsi) {
            void handleProjectChat(async () => { await setActiveConversation(conv.id); return conv.id; });
          } else {
            void setActiveConversation(conv.id);
          }
        }}
        onClick={() => {
          if (isWork && !isRsi && projectBusy) return;
          if (editingId !== conv.id) {
            if (isWork && !isRsi) {
              void handleProjectChat(async () => { await setActiveConversation(conv.id); return conv.id; });
            } else {
              void setActiveConversation(conv.id);
            }
          }
        }}
        className={`group flex items-center gap-2 px-2.5 py-1.5 rounded-lg cursor-pointer text-[13px] transition-all min-w-0 ${
          activeConversationId === conv.id
            ? 'bg-[var(--accent-soft)] text-[var(--text-primary)] font-medium border border-[var(--accent-border)]'
            : 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] hover:text-[var(--text-primary)] border border-transparent'
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
              <span className={`shrink-0 w-1.5 h-1.5 rounded-full ${dotClass}`} />
              <span className="truncate">{conv.title}</span>
              {isRsi && (
                <span className="shrink-0 px-1 py-0.2 rounded text-[9px] font-semibold bg-[color-mix(in_srgb,var(--accent)_15%,transparent)] text-[var(--accent)] leading-tight">
                  RSI
                </span>
              )}
              {isWork && !isRsi && aiCountFor(conv.id) > 0 && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--success)] shrink-0" title={t('aiChanges')} />
              )}
              {isRunning && (
                <FiLoader size={11} className="shrink-0 text-[var(--accent)] animate-spin" />
              )}
              {isRsi && (
                <span className="ml-auto shrink-0 text-[10px] text-[var(--text-muted)] font-mono">
                  {shortTime(conv.updatedAt)}
                </span>
              )}
            </div>
            {isWork && !isRsi && changedFileNames(conv.id).length > 0 && (
              <div className="mt-0.5 truncate text-[10px] font-normal text-[var(--text-muted)]">
                {changedFileNames(conv.id).join(', ')}
              </div>
            )}
          </div>
        )}
        <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 transition-opacity shrink-0">
          <button onClick={(e) => { e.stopPropagation(); setEditingId(conv.id); setEditTitle(conv.title); }}
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-4)] cursor-pointer transition-colors"
            title={t('rename')}>
            <FiEdit3 size={12} />
          </button>
          <button onClick={(e) => { e.stopPropagation(); void deleteConversation(conv.id); }}
            className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-4)] cursor-pointer transition-colors"
            title={t('delete')}>
            <FiTrash2 size={12} />
          </button>
        </div>
      </div>
    );
  };

  return (
    <div className="workbench-sidebar w-full h-full flex flex-col bg-[var(--glass-surface)] backdrop-blur-3xl border-r border-[var(--glass-border)] min-h-0 relative">
      {/* Clean drag spacer for macOS traffic lights with no corner badge */}
      <div className="h-[44px] shrink-0" style={{ WebkitAppRegion: 'drag' } as any} />
      {/* Toolbar — the row itself drags the window; buttons opt out. */}
      <div className="flex items-center gap-1.5 px-3 pb-2.5 shrink-0" style={{ WebkitAppRegion: 'drag' } as any}>
        <button onClick={toggleSidebar} aria-label={t('toggleSidebar')} title={t('toggleSidebar')}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all cursor-pointer">
          <FiMenu size={16} />
        </button>
        <div className="flex-1" />

        <button onClick={() => void openMarket()}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all cursor-pointer"
          title={t('pluginMarket')}
          aria-label={t('pluginMarket')}>
          <FiPackage size={15} />
        </button>

        <div ref={panelsBtnRef} className="relative" style={{ WebkitAppRegion: 'no-drag' } as any}>
          <button onClick={() => setPanelsOpen(!panelsOpen)}
            className={`relative w-8 h-8 rounded-xl flex items-center justify-center transition-all cursor-pointer ${
              panelsOpen || anyPanelOpen
                ? 'text-[var(--accent)] bg-[var(--accent-soft)] shadow-2xs border border-[color-mix(in_srgb,var(--accent)_30%,transparent)]'
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
                {panels.map((p) => (
                  <button key={p.key} role="menuitem" aria-pressed={p.open}
                    onClick={() => { p.toggle(); setPanelsOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors cursor-pointer ${
                      p.open ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-medium' : 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:text-[var(--text-primary)]'
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

        {/* In Chat mode: creates a new Chat conversation. In RSI mode: creates
            a new RSI conversation. In Work mode: creates a work conversation. */}
        <button onClick={() => {
          if (agentMode === 'rsi') {
            void newRsiConversation(selectedModel?.providerId || '', selectedModel?.id || '');
          } else if (viewMode === 'chat') {
            void newConversation(selectedModel?.providerId || '', selectedModel?.id || '', null);
          } else {
            void newConversation(selectedModel?.providerId || '', selectedModel?.id || '', rootPath);
          }
        }}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all cursor-pointer"
          title={agentMode === 'rsi' ? (t('rsiConvNew') || '新建 RSI 对话') : t('newChat')}>
          <FiPlus size={16} />
        </button>
        <button onClick={() => setHandoffOpen(true)}
          style={{ WebkitAppRegion: 'no-drag' } as any}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] hover:shadow-2xs border border-transparent hover:border-[var(--glass-border)] transition-all cursor-pointer"
          title={t('handoffButton')}>
          <FiShare2 size={15} />
        </button>
      </div>

      <div className="flex-1 flex flex-col min-h-0 px-2 min-w-0 overflow-hidden">
        {sidebar.showFolderHint && (
          <RsiFolderHint
            t={t}
            paths={openFolderPaths}
            activePath={rootPath}
            error={folderError}
            onAdd={() => void handleAddRsiFolder()}
            onRemove={handleRemoveRsiFolder}
            onDismissError={() => setFolderError(null)}
          />
        )}
        {/* Work groups chats under open projects; RSI/Chat use the full list height. */}
        <div className={`min-h-0 overflow-y-auto overscroll-contain ${convAreaClass}`}>
          <div className="px-1 pt-1 pb-1 text-[11px] font-semibold tracking-wide text-[var(--text-muted)] flex items-center justify-between">
            <div className="flex items-center gap-1.5">
              {agentMode === 'rsi' ? (
                <>
                  <FiZap size={10} className="text-[var(--accent)]" />
                  <span className="text-[var(--accent)] font-bold">{t('rsiConvList')}</span>
                </>
              ) : viewMode === 'chat' ? (
                <>
                  <FiMessageSquare size={10} className="text-[var(--accent)]" />
                  <span>{t('conversations')}</span>
                </>
              ) : (
                <span>{t('sidebarProjects')}</span>
              )}
              {(sidebar.isRsi || viewMode === 'chat') && (
                <span>· {sidebar.isRsi ? rsiConversations.length : chatConversations.length}</span>
              )}
            </div>
            {!sidebar.isRsi && viewMode === 'work' && openFolderPaths.length > 0 && (
              <button onClick={() => void handleAddProject()} disabled={projectBusy}
                aria-label={t('addFolder')} title={t('addFolder')}
                className="p-1 rounded-md hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] disabled:opacity-50">
                <FiPlus size={14} />
              </button>
            )}
          </div>

          {agentMode === 'rsi' ? (
            <div className="space-y-2.5 mt-1">
              {rsiGroups.map(([folderKey, items]) => {
                const isCurrent = !!folderKey && folderKey === rootPath;
                const collapsed = collapsedGroups.has(`rsi:${folderKey}`);
                return (
                  <div key={`rsi:${folderKey}`} className="min-w-0">
                    <div
                      onClick={() => toggleGroup(`rsi:${folderKey}`)}
                      title={folderKey || t('unbound')}
                      className={`flex items-center gap-1 px-2.5 py-2 rounded-lg min-w-0 border transition-colors cursor-pointer ${
                        isCurrent
                          ? 'bg-[var(--accent-soft)] border-transparent text-[var(--accent)]'
                          : 'bg-[var(--glass-card)] border-[var(--glass-border)] text-[var(--text-secondary)] hover:border-[var(--border)] hover:bg-[color-mix(in_srgb,var(--bg-2)_90%,transparent)]'
                      }`}
                    >
                      <button
                        onClick={(e) => { e.stopPropagation(); toggleGroup(`rsi:${folderKey}`); }}
                        aria-expanded={!collapsed}
                        title={t('collapseAll')}
                        className="p-0.5 -ml-1 rounded-md hover:bg-[color-mix(in_srgb,var(--bg-3)_80%,transparent)] text-[var(--text-muted)] shrink-0 transition-colors"
                      >
                        {collapsed ? <FiChevronRight size={12} /> : <FiChevronDown size={12} />}
                      </button>
                      <FiZap size={13} className="shrink-0 text-[var(--accent)]" />
                      <span className="flex-1 truncate text-[12px] font-semibold tracking-wide min-w-0">
                        {folderKey ? (folderKey.split('/').pop() || folderKey) : t('unbound')}
                      </span>
                      <span className={`shrink-0 text-[10px] px-1.5 py-0.5 rounded-full font-medium ${
                        isCurrent ? 'bg-[var(--accent)] text-white shadow-2xs' : 'bg-[var(--bg-3)] text-[var(--text-muted)]'
                      }`}>
                        {items.length}
                      </span>
                    </div>
                    {!collapsed && (
                      <div className="ml-3 pl-2.5 border-l border-[var(--border)] mt-1.5 space-y-0.5">
                        {items.map((conv) => renderConvRow(conv, true, true))}
                      </div>
                    )}
                  </div>
                );
              })}
              {rsiConversations.length === 0 && (
                <div className="px-2 py-4 text-center">
                  <p className="text-[11px] text-[var(--text-muted)]">{t('rsiConvEmpty')}</p>
                  <button
                    onClick={() => void newRsiConversation(selectedModel?.providerId || '', selectedModel?.id || '')}
                    className="mt-2 inline-flex items-center gap-1 px-2.5 py-1 text-xs rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors cursor-pointer"
                  >
                    <FiPlus size={12} />
                    <span>{t('rsiConvNew')}</span>
                  </button>
                </div>
              )}
            </div>
          ) : viewMode === 'chat' ? (
            <div className="space-y-0.5 mt-1">
              {chatConversations.map((conv) => renderConvRow(conv, false, false))}
              {chatConversations.length === 0 && (
                <p className="px-2 py-3 text-[11px] text-[var(--text-muted)] text-center">{t('chatConvEmpty')}</p>
              )}
            </div>
          ) : (
            <div className="space-y-2.5 mt-1">
              {folderError && (
                <div role="alert" className="px-2 py-1.5 text-xs text-[var(--error)]">{folderError}</div>
              )}
              {openFolderPaths.length === 0 && (
                <button onClick={() => void handleAddProject()} disabled={projectBusy}
                  className="w-full px-2.5 py-2 rounded-lg text-[12px] font-medium text-[var(--accent)] bg-[var(--accent-soft)] hover:bg-[var(--glass-card)] disabled:opacity-50 transition-colors">
                  {t('openFolder')}
                </button>
              )}
              {workGroups.map(([folderKey, items]) => {
                const collapsed = collapsedGroups.has(folderKey);
                const label = rootLabel(folderKey, projectPaths);
                const isOpen = openFolderPaths.includes(folderKey);
                const isCurrent = folderKey === rootPath;
                return (
                  <div key={folderKey} className="min-w-0">
                    <div className={`group flex items-center gap-0.5 px-1 py-1 rounded-lg hover:bg-[var(--glass-card)] ${
                      isCurrent ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)]'}`}>
                      <button onClick={() => toggleGroup(folderKey)} title={folderKey}
                        aria-expanded={!collapsed} aria-current={isCurrent ? 'true' : undefined}
                        className={`flex flex-1 min-w-0 items-center gap-1.5 px-1 py-1 text-left text-[12px] font-medium ${
                          isOpen ? 'hover:text-[var(--text-primary)]' : 'text-[var(--text-muted)]'}`}>
                        {collapsed ? <FiChevronRight size={12} className="shrink-0" /> : <FiChevronDown size={12} className="shrink-0" />}
                        <span className="truncate">{label}</span>
                      </button>
                      <button onClick={() => void handleProjectChat(() => newConversation(selectedModel?.providerId || '', selectedModel?.id || '', folderKey))} disabled={projectBusy}
                        aria-label={`${t('newChat')} · ${label}`} title={t('newChat')}
                        className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] disabled:opacity-50 cursor-pointer">
                        <FiPlus size={13} />
                      </button>
                      {/* A closed project has nothing to close: opening one of its
                          chats (or the + above) reopens the folder again. */}
                      {isOpen && (
                        <button onClick={() => void closeFolderGroup(folderKey)} disabled={projectBusy}
                          aria-label={`${t('closeFolder')} · ${label}`} title={t('closeFolder')}
                          className="p-1 rounded-md text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] disabled:opacity-50 cursor-pointer">
                          <FiX size={13} />
                        </button>
                      )}
                    </div>
                    {!collapsed && (
                      <div className="ml-3 pl-2 border-l border-[var(--border)] mt-0.5 space-y-0.5">
                        {items.map((conv) => renderConvRow(conv, true, false))}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </div>

        {/* RSI never shows files — only its folder hint. Work keeps the tree,
            collapsible from its header so projects can take the whole column. */}
        {sidebar.showFileExplorer && (
          <div className={`shrink-0 min-h-0 flex flex-col border-t border-[var(--border)] mt-2 ${fileTreeOpen ? 'flex-1' : ''}`}>
            <button onClick={toggleFileTree} aria-expanded={fileTreeOpen} aria-controls="sidebar-files"
              title={t('files')}
              className="shrink-0 w-full px-1 pt-1.5 pb-1 text-[11px] font-semibold tracking-wide text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer flex items-center gap-1.5">
              {fileTreeOpen
                ? <FiChevronDown size={11} className="shrink-0" />
                : <FiChevronRight size={11} className="shrink-0" />}
              <FiFolder size={10} className="text-amber-500 shrink-0" />
              <span className="truncate">{t('files')}</span>
            </button>
            {fileTreeOpen && (
              <div id="sidebar-files" className="flex-1 min-h-0 flex flex-col">
                <FileTree />
              </div>
            )}
          </div>
        )}
      </div>

      <div className="p-2.5 border-t border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-subtle)_30%,transparent)]">
        <div className="flex items-center gap-1.5">
          {/* Chat / Work / RSI capsule pill */}
          <div className="flex-1 flex items-center p-0.5 rounded-xl bg-[color-mix(in_srgb,var(--bg-2)_80%,transparent)] border border-[var(--glass-border)] shadow-2xs">
            <button
              onClick={() => {
                setViewMode('chat');
                const store = useChatStore.getState();
                // Leaving RSI already hands off to a non-RSI conversation;
                // running the lookup below too would create a second blank one.
                if (store.agentMode === 'rsi') {
                  store.setAgentMode('standard');
                  return;
                }
                const current = store.conversations.find((c) => c.id === store.activeConversationId);
                if (!current || !isChatConversation(current)) {
                  const chatConv = store.conversations.find(isChatConversation);
                  if (chatConv) {
                    void store.setActiveConversation(chatConv.id);
                  } else {
                    void store.newConversation(selectedModel?.providerId || '', selectedModel?.id || '', null);
                  }
                }
              }}
              className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[12px] font-medium transition-all cursor-pointer ${
                viewMode === 'chat' && agentMode !== 'rsi'
                  ? 'bg-[var(--glass-card)] text-[var(--accent)] shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={t('chat')}
            >
              <FiMessageSquare size={12} className={viewMode === 'chat' && agentMode !== 'rsi' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <span>{t('chat')}</span>
            </button>
            <button
              onClick={() => {
                setViewMode('work');
                const store = useChatStore.getState();
                // Same hand-off guard as the Chat tab: setAgentMode already
                // selects/creates the Work conversation when leaving RSI.
                if (store.agentMode === 'rsi') {
                  store.setAgentMode('standard');
                  return;
                }
                const current = store.conversations.find((c) => c.id === store.activeConversationId);
                if (!current || !isWorkConversation(current)) {
                  const workConv = store.conversations.find(isWorkConversation);
                  if (workConv) {
                    void store.setActiveConversation(workConv.id);
                  } else if (useWorkspaceStore.getState().rootPath) {
                    void store.newConversation(selectedModel?.providerId || '', selectedModel?.id || '', useWorkspaceStore.getState().rootPath);
                  } else {
                    void store.ensureWorkFolder();
                  }
                }
              }}
              className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[12px] font-medium transition-all cursor-pointer ${
                viewMode === 'work' && agentMode !== 'rsi'
                  ? 'bg-[var(--glass-card)] text-[var(--accent)] shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={t('work')}
            >
              <FiBriefcase size={12} className={viewMode === 'work' && agentMode !== 'rsi' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <span>{t('work')}</span>
            </button>
            <button
              onClick={() => {
                // setAgentMode('rsi') reopens the newest RSI conversation (or
                // creates the first one); doing the same lookup here as well
                // used to spawn a duplicate blank conversation.
                useChatStore.getState().setAgentMode('rsi');
              }}
              className={`flex-1 min-w-0 flex items-center justify-center gap-1 py-1.5 px-1.5 rounded-lg text-[12px] font-medium transition-all cursor-pointer ${
                agentMode === 'rsi'
                  ? 'bg-[var(--glass-card)] text-[var(--accent)] shadow-xs font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
              }`}
              title={t('rsiTitle')}
            >
              <FiZap size={12} className={agentMode === 'rsi' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
              <span>RSI</span>
            </button>
          </div>

          {/* Settings button */}
          <button
            onClick={toggleSettings}
            className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-secondary)] hover:bg-[var(--glass-card)] hover:text-[var(--text-primary)] border border-transparent hover:border-[var(--glass-border)] transition-all shadow-2xs shrink-0 cursor-pointer"
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
