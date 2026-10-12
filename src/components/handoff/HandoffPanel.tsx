import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { FiX, FiShare2, FiCheck, FiFolder } from 'react-icons/fi';
import { useChatStore } from '../../stores/chat.store';
import { useLanguageStore } from '../../stores/language.store';
import { useModelStore } from '../../stores/model.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import {
  buildHandoffMarkdown, handoffFilename, handoffMessages, slugifyTitle,
} from '../../core/handoff/handoff';
import type { Message } from '../../types/chat.types';

/**
 * Handoff dialog: preview (turns, size, file name, the read-first prompt),
 * two content switches, export, and a success state pointing at the file.
 * The .md lands in Downloads and gets revealed in the Finder — the drag
 * into another agent starts there.
 */
export default function HandoffPanel({ onClose }: { onClose: () => void }) {
  const { t } = useLanguageStore();
  const conversations = useChatStore((s) => s.conversations);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  const conv = conversations.find((c) => c.id === activeConversationId);
  const selectedModel = getSelectedModel();

  const [messages, setMessages] = useState<Message[] | null>(null);
  const [fileName, setFileName] = useState('');
  const [includeTools, setIncludeTools] = useState(true);
  const [includeResults, setIncludeResults] = useState(true);
  const [phase, setPhase] = useState<'form' | 'busy' | 'done'>('form');
  const [savedPath, setSavedPath] = useState('');

  useEffect(() => {
    let live = true;
    setMessages(null);
    if (!conv) return;
    setFileName(handoffFilename(conv.title || 'Untitled'));
    void (window as any).electronAPI?.message?.list?.(conv.id)
      ?.catch(() => [])
      .then((all: Message[]) => {
        if (live) setMessages(all || []);
      });
    return () => { live = false; };
  }, [conv?.id]); // eslint-disable-line react-hooks/exhaustive-deps

  const turns = useMemo(() => handoffMessages(messages || []), [messages]);

  const preview = useMemo(() => {
    if (!conv) return '';
    return buildHandoffMarkdown({
      title: conv.title || 'Untitled',
      modelLabel: conv.providerId && conv.modelId
        ? `${conv.providerId}/${conv.modelId}`
        : (selectedModel ? `${selectedModel.providerId}/${selectedModel.id}` : '—'),
      projectPath: conv.rootPath || rootPath || '',
      exportedAt: Date.now(),
      prompt: t('handoffPrompt'),
      howTo: t('handoffHow'),
      messages: messages || [],
      includeTools,
      includeToolResults: includeResults,
    });
  }, [conv, messages, includeTools, includeResults, selectedModel, rootPath, t]);

  const sizeKb = useMemo(
    () => (preview ? Math.max(1, Math.round(new Blob([preview]).size / 1024)) : 0),
    [preview],
  );

  const exportNow = async () => {
    if (!conv || phase === 'busy' || turns.length === 0) return;
    setPhase('busy');
    try {
      const api = (window as any).electronAPI;
      const dir = await api?.app?.getPath?.('downloads');
      if (!dir) throw new Error('no downloads dir');
      const clean = slugifyTitle((fileName || conv.title || 'untitled').replace(/\.md$/i, ''));
      const file = `${dir}/${clean}.md`;
      await api?.fs?.writeFile?.(file, preview);
      setSavedPath(file);
      await api?.app?.openPath?.(file).catch(() => {});
      setPhase('done');
    } catch {
      setPhase('form');
    }
  };

  // Portal out of the sidebar: its backdrop-blur would otherwise trap
  // `fixed` positioning inside the 260px column instead of the viewport.
  return createPortal(
    <>
      <div className="fixed inset-0 z-50 bg-black/30" onClick={() => phase !== 'busy' && onClose()} />
      <div className="fixed inset-0 z-50 flex items-center justify-center p-4 pointer-events-none">
        <div className="pointer-events-auto w-[480px] max-w-full max-h-[calc(100vh-6rem)] flex flex-col rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] shadow-2xl overflow-hidden anim-menu">
          <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)] shrink-0">
            <div className="w-7 h-7 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] flex items-center justify-center shrink-0">
              <FiShare2 size={14} />
            </div>
            <div className="flex-1 min-w-0 text-[14px] font-medium truncate">{t('handoffButton')}</div>
            <button onClick={onClose} disabled={phase === 'busy'}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors disabled:opacity-50">
              <FiX size={15} />
            </button>
          </div>

          {phase === 'done' ? (
            <div className="p-5 text-center">
              <div className="w-11 h-11 rounded-2xl bg-[var(--success)]/15 text-[var(--success)] flex items-center justify-center mx-auto mb-3">
                <FiCheck size={20} />
              </div>
              <p className="text-[14px] font-medium text-[var(--text-primary)] mb-1">{t('handoffDoneTitle')}</p>
              <p className="text-[12px] font-mono text-[var(--text-muted)] truncate mb-1" title={savedPath}>{savedPath}</p>
              <p className="text-[12.5px] text-[var(--text-secondary)] mb-4">{t('handoffHow')}</p>
              <div className="flex gap-2 justify-center">
                <button
                  onClick={() => void (window as any).electronAPI?.app?.openPath?.(savedPath).catch(() => {})}
                  className="px-3.5 py-1.5 rounded-lg bg-[var(--bg-3)] text-[12.5px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors flex items-center gap-1.5"
                >
                  <FiFolder size={12} /> {t('handoffReveal')}
                </button>
                <button onClick={onClose}
                  className="px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12.5px] font-medium hover:bg-[var(--accent-hover)] transition-colors">
                  {t('dismiss')}
                </button>
              </div>
            </div>
          ) : (
            <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
              {messages === null ? (
                <p className="text-[12.5px] text-[var(--text-muted)]">…</p>
              ) : turns.length === 0 ? (
                <p className="text-[13px] text-[var(--text-secondary)]">{t('handoffEmpty')}</p>
              ) : (
                <>
                  <div className="px-3 py-2.5 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-[12.5px] text-[var(--text-secondary)]">
                    {turns.length} {t('handoffTurnsUnit')} · {sizeKb} KB · {conv?.title}
                  </div>
                  <div>
                    <label className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      {t('handoffFileLabel')}
                    </label>
                    <input
                      value={fileName}
                      onChange={(e) => setFileName(e.target.value)}
                      spellCheck={false}
                      className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-0)] border border-[var(--border)] text-[13px] font-mono outline-none focus:border-[var(--accent)]/50"
                    />
                  </div>
                  <div>
                    <label className="block px-1 mb-1 text-[11px] uppercase tracking-wider text-[var(--text-muted)]">
                      {t('handoffPromptLabel')}
                    </label>
                    <p className="px-3 py-2.5 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-[12px] text-[var(--text-secondary)] leading-relaxed">
                      {t('handoffPrompt')}
                    </p>
                  </div>
                  <div className="flex gap-2">
                    {([
                      [includeTools, setIncludeTools, 'handoffIncludeTools'],
                      [includeResults, setIncludeResults, 'handoffIncludeResults'],
                    ] as const).map(([on, set, key]) => (
                      <button key={key} onClick={() => set(!on)}
                        className={`flex-1 flex items-center gap-2 px-3 py-2 rounded-xl border text-[12.5px] transition-colors ${
                          on ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] text-[var(--accent)]'
                            : 'border-[var(--border)] text-[var(--text-muted)] hover:bg-[var(--bg-3)]'
                        }`}>
                        <span className={`w-4 h-4 rounded-md border flex items-center justify-center shrink-0 ${on ? 'bg-[var(--accent)] border-[var(--accent)] text-white' : 'border-[var(--border)]'}`}>
                          {on && <FiCheck size={11} />}
                        </span>
                        {t(key)}
                      </button>
                    ))}
                  </div>
                  <button
                    onClick={() => void exportNow()}
                    disabled={phase === 'busy'}
                    className="w-full px-3 py-2.5 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
                  >
                    {t('handoffExport')}
                  </button>
                </>
              )}
            </div>
          )}
        </div>
      </div>
    </>,
    document.body,
  );
}
