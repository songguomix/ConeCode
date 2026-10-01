import { useEffect, useRef, useState } from 'react';
import { FiAlertTriangle, FiCheck, FiLoader, FiRotateCcw, FiTerminal, FiX } from 'react-icons/fi';
import { useCodeChangesStore, useLanguageStore } from '../../stores';
import type { CodeChange } from '../../stores/codeChanges.store';

interface CommandApprovalModalProps {
  change: CodeChange;
  onClose: () => void;
}

export default function CommandApprovalModal({ change, onClose }: CommandApprovalModalProps) {
  const applyChange = useCodeChangesStore((state) => state.applyChange);
  const revertChange = useCodeChangesStore((state) => state.revertChange);
  const { t } = useLanguageStore();
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dialogRef = useRef<HTMLDivElement>(null);
  const pending = change.status === 'pending';

  useEffect(() => {
    dialogRef.current?.focus();
  }, [change.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && !busy) onClose();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, onClose]);

  const execute = async () => {
    setBusy(true);
    setError(null);
    const response = await applyChange(change.id);
    setResult(response.result || null);
    if (!response.success) setError(response.result || t('commandFailed'));
    setBusy(false);
    window.dispatchEvent(new Event('conecode:scrollChatBottom'));
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    const response = await revertChange(change.id);
    setBusy(false);
    if (!response.success) {
      setError(response.error || t('revertFailed'));
      return;
    }
    onClose();
  };

  const status = change.status === 'applied'
    ? <span className="inline-flex items-center gap-1 text-[11px] text-green-600 dark:text-green-400"><FiCheck size={11} /> {t('applied')}</span>
    : change.status === 'failed'
      ? <span className="inline-flex items-center gap-1 text-[11px] text-[var(--error)]"><FiAlertTriangle size={11} /> {t('changeFailed')}</span>
    : change.status === 'reverted'
      ? <span className="inline-flex items-center gap-1 text-[11px] text-[var(--text-muted)]"><FiRotateCcw size={11} /> {t('reverted')}</span>
      : <span className="text-[11px] text-yellow-600 dark:text-yellow-400">{t('pendingApproval')}</span>;

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/45 backdrop-blur-sm p-4 anim-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="command-approval-title"
        tabIndex={-1}
        className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--bg-1)] shadow-2xl overflow-hidden outline-none anim-modal"
      >
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)]">
          <div className="w-8 h-8 rounded-lg bg-yellow-500/15 text-yellow-500 flex items-center justify-center shrink-0">
            <FiTerminal size={15} />
          </div>
          <div className="min-w-0 flex-1">
            <h2 id="command-approval-title" className="text-sm font-semibold text-[var(--text-primary)]">
              {t('commandExecution')}
            </h2>
            {status}
          </div>
          <button
            onClick={onClose}
            disabled={busy}
            aria-label={t('close')}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] disabled:opacity-50"
          >
            <FiX size={15} />
          </button>
        </div>

        <div className="p-4 space-y-3">
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-3)] overflow-hidden">
            <pre className="p-3 max-h-[34vh] overflow-auto whitespace-pre-wrap break-all text-[13px] leading-relaxed font-mono text-[var(--text-primary)]">
              <span className="text-yellow-500 select-none">$ </span>{change.newCode}
            </pre>
            {change.cwd && (
              <div className="flex items-center gap-2 px-3 py-2 border-t border-[var(--border)] text-[11px] text-[var(--text-muted)]">
                <span className="shrink-0">{t('workingDirectory')}</span>
                <code className="truncate" title={change.cwd}>{change.cwd}</code>
              </div>
            )}
          </div>

          {change.description && (
            <p className="text-xs text-[var(--text-secondary)]">{change.description}</p>
          )}

          {pending && (
            <div className="flex items-start gap-2 rounded-lg bg-yellow-500/10 px-3 py-2 text-xs text-yellow-800 dark:text-yellow-200">
              <FiAlertTriangle size={13} className="mt-0.5 shrink-0" />
              <span>{t('commandApprovalHint')}</span>
            </div>
          )}

          {error && (
            <div className="rounded-lg bg-[var(--error)]/10 px-3 py-2 text-xs text-[var(--error)] whitespace-pre-wrap">
              {error}
            </div>
          )}

          {result && (
            <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden">
              <div className="px-3 py-1.5 border-b border-[var(--border)] text-[11px] font-semibold text-[var(--text-muted)]">{t('result')}</div>
              <pre className="px-3 py-2 max-h-44 overflow-auto whitespace-pre-wrap text-xs font-mono text-[var(--text-secondary)]">{result}</pre>
            </div>
          )}
        </div>

        <div className="flex items-center justify-end gap-2 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-2)]">
          {pending ? (
            <>
              <button
                onClick={reject}
                disabled={busy}
                className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-3)] text-xs font-semibold text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-4)] disabled:opacity-50"
              >
                {t('reject')}
              </button>
              <button
                onClick={execute}
                disabled={busy}
                className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-xs font-semibold text-white hover:bg-[var(--accent-hover)] disabled:opacity-50"
              >
                {busy ? <FiLoader size={12} className="animate-spin" /> : <FiCheck size={12} />}
                {t('execute')}
              </button>
            </>
          ) : (
            <button
              onClick={onClose}
              className="px-3.5 py-1.5 rounded-lg bg-[var(--accent)] text-xs font-semibold text-white hover:bg-[var(--accent-hover)]"
            >
              {t('close')}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
