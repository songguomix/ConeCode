import { useState, useCallback, useRef, useEffect } from 'react';
import { FiX, FiPlus, FiChevronDown, FiCheck, FiTrash2, FiTerminal, FiEdit3 } from 'react-icons/fi';
import { useUIStore, useLanguageStore } from '../../stores';
import TerminalSession from './TerminalSession';

interface Tab {
  id: string;
  n: number;       // sequence number — drives the default, language-synced label
  name?: string;   // custom name set via "Rename terminal"
}

let seq = 0;
const newTab = (): Tab => {
  seq += 1;
  return { id: `term-${Date.now()}-${seq}`, n: seq };
};

export default function TerminalPanel() {
  const toggleTerminal = useUIStore((s) => s.toggleTerminal);
  const terminalOpen = useUIStore((s) => s.terminalOpen);
  const { t } = useLanguageStore();
  const [tabs, setTabs] = useState<Tab[]>(() => [newTab()]);
  const [activeId, setActiveId] = useState<string>(() => tabs[0].id);
  const [menuOpen, setMenuOpen] = useState(false);
  const [renaming, setRenaming] = useState(false);
  const [renameValue, setRenameValue] = useState('');
  const renameRef = useRef<HTMLInputElement>(null);

  const labelOf = (tab: Tab) => tab.name || `${t('terminal')} ${tab.n}`;
  const active = tabs.find((tab) => tab.id === activeId) ?? tabs[0];

  const addTab = useCallback(() => {
    const tab = newTab();
    setTabs((prev) => [...prev, tab]);
    setActiveId(tab.id);
    setMenuOpen(false);
  }, []);

  const closeTab = useCallback((id: string) => {
    const next = tabs.filter((tab) => tab.id !== id);
    if (next.length === 0) {
      // Deleting the last terminal: reset numbering and collapse the panel.
      // Re-opening spawns a fresh "Terminal 1" (see the effect below).
      seq = 0;
      setTabs([]);
      setMenuOpen(false);
      toggleTerminal();
      return;
    }
    setTabs(next);
    if (id === activeId) setActiveId(next[next.length - 1].id);
  }, [tabs, activeId, toggleTerminal]);

  // After all terminals were deleted, the next time the panel opens, start over
  // from the first terminal.
  useEffect(() => {
    if (terminalOpen && tabs.length === 0) {
      const tab = newTab();
      setTabs([tab]);
      setActiveId(tab.id);
    }
  }, [terminalOpen, tabs.length]);

  const startRename = useCallback(() => {
    setRenameValue(active.name || `${t('terminal')} ${active.n}`);
    setRenaming(true);
    setMenuOpen(false);
  }, [active, t]);

  useEffect(() => {
    if (renaming) {
      renameRef.current?.focus();
      renameRef.current?.select();
    }
  }, [renaming]);

  const commitRename = () => {
    const v = renameValue.trim();
    setTabs((prev) => prev.map((tab) => (tab.id === active.id ? { ...tab, name: v || undefined } : tab)));
    setRenaming(false);
  };

  // All terminals deleted — the panel is collapsed; render nothing until it
  // re-opens (the effect above will then spawn a fresh Terminal 1).
  if (tabs.length === 0 || !active) {
    return <div className="h-full bg-[var(--bg-0)] border-t border-[var(--border)]" />;
  }

  return (
    <div className="flex flex-col h-full bg-[var(--bg-0)] border-t border-[var(--border)]">
      {/* Tab bar */}
      <div className="flex items-center px-2 py-1.5 shrink-0 gap-1.5">
        <div className="relative">
          {renaming ? (
            <input
              ref={renameRef}
              value={renameValue}
              onChange={(e) => setRenameValue(e.target.value)}
              onBlur={commitRename}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) commitRename();
                if (e.key === 'Escape') setRenaming(false);
              }}
              className="px-2 py-1 w-40 rounded-lg bg-[var(--bg-2)] border border-[var(--accent)] text-[13px] outline-none"
            />
          ) : (
            <button
              onClick={() => setMenuOpen((v) => !v)}
              className={`flex items-center gap-1.5 pl-2.5 pr-2 py-1 rounded-lg text-[13px] transition-colors ${
                menuOpen ? 'bg-[var(--bg-3)] text-[var(--text-primary)]' : 'text-[var(--text-primary)] hover:bg-[var(--bg-3)]'
              }`}
            >
              <span className="truncate max-w-[160px]">{labelOf(active)}</span>
              <FiChevronDown size={12} className="text-[var(--text-muted)]" />
            </button>
          )}

          {menuOpen && (
            <>
              <div className="fixed inset-0 z-40" onClick={() => setMenuOpen(false)} />
              <div className="absolute bottom-full left-0 mb-1.5 w-60 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl shadow-xl z-50 overflow-hidden py-1.5">
                <div className="px-3 py-1 text-xs font-medium text-[var(--text-muted)]">{t('terminals')}</div>
                <div className="max-h-64 overflow-y-auto">
                  {tabs.map((tab) => (
                    <div
                      key={tab.id}
                      onClick={() => { setActiveId(tab.id); setMenuOpen(false); }}
                      className="group flex items-center gap-2 px-3 py-1.5 text-[13px] cursor-pointer text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors"
                    >
                      <span className="flex-1 truncate text-[var(--text-primary)]">{labelOf(tab)}</span>
                      {tab.id === activeId && <FiCheck size={14} className="text-[var(--accent)] shrink-0" />}
                      <button
                        onClick={(e) => { e.stopPropagation(); closeTab(tab.id); }}
                        className="p-0.5 rounded text-[var(--text-muted)] hover:text-[var(--error)] opacity-0 group-hover:opacity-100 transition-opacity shrink-0"
                        title={t('close')}
                      >
                        <FiTrash2 size={13} />
                      </button>
                    </div>
                  ))}
                </div>
                <div className="my-1 border-t border-[var(--border)]" />
                <button
                  onClick={addTab}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors"
                >
                  <FiTerminal size={13} className="text-[var(--text-muted)]" /> {t('newTerminal')}
                </button>
                <button
                  onClick={startRename}
                  className="w-full flex items-center gap-2 px-3 py-1.5 text-[13px] text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors"
                >
                  <FiEdit3 size={13} className="text-[var(--text-muted)]" /> {t('renameTerminal')}
                </button>
              </div>
            </>
          )}
        </div>

        <div className="w-px h-4 bg-[var(--border)]" />
        <button
          onClick={addTab}
          className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors"
          title={t('newTerminal')}
        >
          <FiPlus size={14} />
        </button>

        <div className="flex-1" />
        <button
          onClick={toggleTerminal}
          className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors"
          title={t('close')}
        >
          <FiX size={14} />
        </button>
      </div>

      {/* Sessions — all mounted so backgrounded shells keep running */}
      <div className="flex-1 min-h-0">
        {tabs.map((tab) => (
          <TerminalSession key={tab.id} id={tab.id} active={tab.id === activeId} />
        ))}
      </div>
    </div>
  );
}
