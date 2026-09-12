import { useState } from 'react';
import type { ReactNode } from 'react';
import { FiPlus, FiSettings, FiTrash2, FiGlobe, FiEdit3, FiMenu, FiTerminal, FiFileText, FiSmartphone, FiMonitor, FiCpu, FiGrid, FiShield, FiGitBranch, FiLoader } from 'react-icons/fi';
import { useChatStore, useUIStore, useLanguageStore, usePreviewStore, useComputerStore, useModelStore, useCodeChangesStore } from '../../stores';
import { mostUrgentDot, type DotKind } from './panelDot';
import FileTree from './FileTree';
import type { Locale } from '../../stores/language.store';

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

const LOCALES: { value: Locale; label: string; flag: string }[] = [
  { value: 'en', label: 'English', flag: '🇺🇸' },
  { value: 'zh', label: '中文', flag: '🇨🇳' },
  { value: 'ja', label: '日本語', flag: '🇯🇵' },
];

export default function Sidebar() {
  const [langOpen, setLangOpen] = useState(false);
  const [panelsOpen, setPanelsOpen] = useState(false);
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editTitle, setEditTitle] = useState('');
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const runningConversationIds = useChatStore((s) => Object.keys(s.streamingRuns));
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
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
  const { locale, setLocale, t } = useLanguageStore();
  const changes = useCodeChangesStore((s) => s.changes);

  // Five panel toggles used to sit in the toolbar as unlabelled 32px icons with
  // no gap between them. They are one menu now: labelled, and the row has room.
  const panels: PanelItem[] = [
    { key: 'terminal', icon: <FiTerminal size={15} />, label: t('terminal'), open: terminalOpen, toggle: toggleTerminal },
    { key: 'changed', icon: <FiFileText size={15} />, label: t('changedFiles'), open: changedFilesOpen, toggle: toggleChangedFiles },
    { key: 'review', icon: <FiShield size={15} />, label: t('codeReview'), open: reviewOpen, toggle: toggleReview },
    { key: 'worktrees', icon: <FiGitBranch size={15} />, label: t('worktrees'), open: worktreesOpen, toggle: toggleWorktrees },
    { key: 'preview', icon: <FiMonitor size={15} />, label: t('preview'), open: previewOpen, toggle: togglePreview, dot: previewState === 'idle' ? null : previewState === 'running' ? 'success' : previewState === 'starting' ? 'warning-pulse' : 'error' },
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

  const handleRename = (id: string) => {
    if (editTitle.trim()) {
      renameConversation(id, editTitle.trim());
    }
    setEditingId(null);
  };

  return (
    <div className="w-[260px] bg-[var(--bg-1)] flex flex-col">
      {/* Drag region — tall enough to clear macOS traffic lights with a
          comfortable gap below them before the toolbar starts. */}
      <div className="h-[58px] shrink-0" style={{ WebkitAppRegion: 'drag' } as any} />
      {/* Toolbar — two anchors and one menu, with space to breathe. */}
      <div className="flex items-center gap-1 px-3 pb-2 shrink-0">
        <button onClick={toggleSidebar}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors">
          <FiMenu size={16} />
        </button>
        <div className="flex-1" />

        <div className="relative">
          <button onClick={() => setPanelsOpen(!panelsOpen)}
            className={`relative w-8 h-8 rounded-xl flex items-center justify-center transition-colors ${
              panelsOpen || anyPanelOpen
                ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
                : 'text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)]'
            }`}
            title={t('panels')}
            aria-haspopup="menu"
            aria-expanded={panelsOpen}>
            <FiGrid size={15} />
            {triggerDot && <StatusDot kind={triggerDot} className="absolute top-1 right-1" />}
          </button>
          {panelsOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setPanelsOpen(false)} />
              <div role="menu"
                className="absolute top-full right-0 mt-1 w-44 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl shadow-xl z-50 overflow-hidden py-1">
                {panels.map((p) => (
                  <button key={p.key} role="menuitemcheckbox" aria-checked={p.open}
                    onClick={() => { p.toggle(); setPanelsOpen(false); }}
                    className={`w-full flex items-center gap-2.5 px-3 py-2 text-[13px] transition-colors ${
                      p.open ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
                    }`}>
                    {p.icon}
                    <span className="flex-1 text-left truncate">{p.label}</span>
                    {p.dot && <StatusDot kind={p.dot} />}
                  </button>
                ))}
              </div>
            </>
          )}
        </div>

        <button onClick={() => createConversation(selectedModel?.providerId || '', selectedModel?.id || '')}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-colors"
          title={t('newChat')}>
          <FiPlus size={16} />
        </button>
      </div>

      <div className="flex-1 overflow-y-auto px-2">
        <div className="space-y-0.5">
          {conversations.map((conv) => (
            <div key={conv.id}
              onClick={() => { if (editingId !== conv.id) setActiveConversation(conv.id); }}
              className={`group flex items-center gap-2.5 px-3 py-2 rounded-xl cursor-pointer text-[13px] transition-all ${
                activeConversationId === conv.id
                  ? 'bg-[var(--bg-3)] text-[var(--text-primary)] font-medium'
                  : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]/50'
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
                  className="flex-1 bg-[var(--bg-2)] border border-[var(--accent)] rounded-lg px-2 py-0.5 text-sm outline-none"
                  autoFocus
                  onClick={(e) => e.stopPropagation()}
                />
              ) : (
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-1.5 min-w-0">
                    {runningConversationIds.includes(conv.id) && (
                      <FiLoader size={12} className="shrink-0 text-[var(--accent)] animate-spin" />
                    )}
                    <span className="truncate">{conv.title}</span>
                  </div>
                  {changedFileNames(conv.id).length > 0 && (
                    <div className="mt-0.5 truncate text-[10px] font-normal text-[var(--text-muted)]">
                      {changedFileNames(conv.id).join(', ')}
                    </div>
                  )}
                </div>
              )}
              <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
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

        <div className="border-t border-[var(--border)] mt-2">
          <FileTree />
        </div>
      </div>

      <div className="p-3 border-t border-[var(--border)]">
        <div className="flex gap-1">
          <button onClick={toggleSettings}
            className="flex-1 flex items-center gap-2 px-3 py-2 rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-3)] text-[13px] transition-colors">
            <FiSettings size={14} /> {t('settings')}
          </button>
          <div className="relative">
            <button onClick={() => setLangOpen(!langOpen)}
              className="flex items-center justify-center px-2.5 py-2 h-full rounded-xl text-[var(--text-secondary)] hover:bg-[var(--bg-3)] text-sm transition-colors"
              title={t('language')}>
              <FiGlobe size={14} />
            </button>
            {langOpen && (
              <>
                <div className="fixed inset-0 z-40" onClick={() => setLangOpen(false)} />
                <div className="absolute bottom-full right-0 mb-1 w-36 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl shadow-xl z-50 overflow-hidden py-1">
                  {LOCALES.map((l) => (
                    <button key={l.value}
                      onClick={() => { setLocale(l.value); setLangOpen(false); }}
                      className={`w-full flex items-center gap-2 px-3 py-2 text-sm transition-colors ${
                        locale === l.value ? 'bg-[var(--accent-soft)] text-[var(--accent)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]'
                      }`}>
                      <span>{l.flag}</span>
                      <span>{l.label}</span>
                    </button>
                  ))}
                </div>
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
