import { useEffect, useRef, useState } from 'react';
import {
  FiTerminal,
  FiCheck,
  FiAlertTriangle,
  FiX,
  FiFolder,
  FiCopy,
  FiPlay,
  FiLoader,
  FiRotateCcw,
} from 'react-icons/fi';
import { useCodeChangesStore, useLanguageStore } from '../../stores';
import type { CodeChange } from '../../stores/codeChanges.store';

interface CommandApprovalCardProps {
  change: CodeChange;
  onClose: () => void;
  onComplete?: () => void;
  pendingIndex?: number;
  totalPending?: number;
}

/**
 * Command Approval Card
 *
 * Rendered directly above the chat input box with a solid opaque background.
 * Provides command preview, working directory, safety hints, and execution actions.
 * Unified visual design with QuestionPromptCard.
 */
export default function CommandApprovalCard({
  change,
  onClose,
  onComplete,
  pendingIndex,
  totalPending,
}: CommandApprovalCardProps) {
  const applyChange = useCodeChangesStore((state) => state.applyChange);
  const revertChange = useCodeChangesStore((state) => state.revertChange);
  const { t } = useLanguageStore();

  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);
  const pending = change.status === 'pending';

  useEffect(() => {
    cardRef.current?.focus();
  }, [change.id]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      // Ignore if user is typing in another input/textarea
      const target = event.target as HTMLElement;
      if (target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA') return;

      if (event.key === 'Escape' && !busy) {
        event.preventDefault();
        onClose();
      } else if (event.key === 'Enter' && !busy) {
        event.preventDefault();
        if (pending) {
          void execute();
        } else {
          (onComplete || onClose)();
        }
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [busy, pending, onClose, onComplete, change.id]);

  const execute = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await applyChange(change.id);
      setResult(response.result || null);
      if (!response.success) {
        setError(response.result || t('commandFailed'));
      }
    } catch (e: any) {
      setError(e?.message || t('commandFailed'));
    } finally {
      setBusy(false);
      window.dispatchEvent(new Event('conecode:scrollChatBottom'));
    }
  };

  const reject = async () => {
    setBusy(true);
    setError(null);
    try {
      const response = await revertChange(change.id);
      if (!response.success) {
        setError(response.error || t('revertFailed'));
        return;
      }
      onClose();
    } catch (e: any) {
      setError(e?.message || t('revertFailed'));
    } finally {
      setBusy(false);
    }
  };

  const handleCopy = () => {
    if (!change.newCode) return;
    navigator.clipboard.writeText(change.newCode);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const statusBadge =
    change.status === 'applied' ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--success)] bg-[var(--success-bg)] px-2 py-0.5 rounded-full border border-[var(--success-border)]">
        <FiCheck size={11} /> {t('applied')}
      </span>
    ) : change.status === 'failed' ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--error)] bg-[var(--error-bg)] px-2 py-0.5 rounded-full border border-[var(--error-border)]">
        <FiAlertTriangle size={11} /> {t('changeFailed')}
      </span>
    ) : change.status === 'reverted' ? (
      <span className="inline-flex items-center gap-1 text-[11px] font-medium text-[var(--text-muted)] bg-[var(--bg-3)] px-2 py-0.5 rounded-full border border-[var(--border)]">
        <FiRotateCcw size={11} /> {t('reverted')}
      </span>
    ) : (
      <span className="inline-flex items-center gap-1.5 text-[11px] font-medium text-[var(--warning)] bg-[var(--warning-bg)] px-2 py-0.5 rounded-full border border-[var(--warning-border)]">
        <span className="w-1.5 h-1.5 rounded-full bg-[var(--warning)] animate-pulse" />
        {t('pendingApproval')}
      </span>
    );

  return (
    <div
      ref={cardRef}
      tabIndex={-1}
      role="region"
      aria-label={t('commandExecution')}
      className="w-full rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] shadow-xl overflow-hidden outline-none select-text anim-slide-up"
      style={{ opacity: 1 }}
    >
      {/* Top Header Bar */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-[var(--border)] bg-[var(--bg-1)]">
        <div className="flex items-center gap-2.5 min-w-0">
          <div className="w-7 h-7 rounded-lg bg-[var(--warning-bg)] text-[var(--warning)] flex items-center justify-center shrink-0 shadow-2xs">
            <FiTerminal size={14} />
          </div>
          <div className="flex items-center gap-2 min-w-0">
            <h3 className="text-[13px] font-semibold text-[var(--text-primary)] truncate">
              {t('commandExecution') || '申请运行命令'}
            </h3>
            {totalPending && totalPending > 1 && (
              <span className="text-[10.5px] font-mono px-1.5 py-0.5 rounded-md bg-[var(--bg-2)] border border-[var(--border)] text-[var(--text-muted)]">
                {(pendingIndex ?? 0) + 1} / {totalPending}
              </span>
            )}
            {statusBadge}
          </div>
        </div>

        <div className="flex items-center gap-1 shrink-0">
          <button
            onClick={handleCopy}
            title={t('copy') || '复制命令'}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-2)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
          >
            {copied ? (
              <FiCheck size={13} className="text-[var(--success)]" />
            ) : (
              <FiCopy size={13} />
            )}
          </button>
          <button
            onClick={onClose}
            disabled={busy}
            title={t('close') || '收起'}
            aria-label={t('close')}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-2)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 cursor-pointer"
          >
            <FiX size={14} />
          </button>
        </div>
      </div>

      {/* Card Content Area */}
      <div className="p-4 space-y-3 bg-[var(--bg-2)]">
        {/* Monospace Command Preview */}
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] overflow-hidden shadow-2xs">
          {change.cwd && (
            <div className="flex items-center gap-1.5 px-3 py-1.5 border-b border-[var(--border)] bg-[var(--bg-3)]/40 text-[11px] text-[var(--text-muted)] font-sans">
              <FiFolder size={12} className="shrink-0 text-[var(--warning)]" />
              <span className="shrink-0">{t('workingDirectory')}:</span>
              <code className="truncate font-mono text-[var(--text-secondary)]" title={change.cwd}>
                {change.cwd}
              </code>
            </div>
          )}
          <pre className="p-3 max-h-36 overflow-auto whitespace-pre-wrap break-all text-[13px] leading-relaxed font-mono text-[var(--text-primary)]">
            <span className="text-[var(--warning)] font-bold select-none">$ </span>
            {change.newCode}
          </pre>
        </div>

        {/* AI Description / Rationale */}
        {change.description && (
          <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
            {change.description}
          </p>
        )}

        {/* Irreversible Safety Warning - fully opaque */}
        {pending && (
          <div className="flex items-start gap-2 rounded-xl bg-[var(--warning-bg)] border border-[var(--warning-border)] px-3 py-2 text-[11.5px] text-[var(--warning-text)]">
            <FiAlertTriangle size={13} className="mt-0.5 shrink-0" />
            <span>{t('commandApprovalHint')}</span>
          </div>
        )}

        {/* Error Output - fully opaque */}
        {error && (
          <div className="rounded-xl bg-[var(--error-bg)] border border-[var(--error-border)] px-3 py-2 text-[12px] text-[var(--error)] whitespace-pre-wrap">
            {error}
          </div>
        )}

        {/* Result Output - fully opaque */}
        {result && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] overflow-hidden">
            <div className="px-3 py-1.5 border-b border-[var(--border)] text-[11px] font-semibold text-[var(--text-muted)]">
              {t('result')}
            </div>
            <pre className="px-3 py-2 max-h-36 overflow-auto whitespace-pre-wrap text-[12px] font-mono text-[var(--text-secondary)]">
              {result}
            </pre>
          </div>
        )}
      </div>

      {/* Action Footer Bar - fully opaque */}
      <div className="flex items-center justify-between gap-3 px-4 py-3 border-t border-[var(--border)] bg-[var(--bg-1)]">
        <span className="text-[11px] text-[var(--text-muted)] hidden sm:inline">
          {pending ? '快捷键：Enter 允许 · Esc 取消' : '快捷键：Enter / Esc 完成'}
        </span>

        <div className="flex items-center gap-2 ml-auto">
          {pending ? (
            <>
              <button
                onClick={reject}
                disabled={busy}
                className="px-3.5 py-1.5 rounded-xl border border-[var(--border)] bg-[var(--bg-2)] hover:bg-[var(--error-bg)] hover:text-[var(--error)] hover:border-[var(--error-border)] text-[12px] font-medium text-[var(--text-secondary)] transition-colors disabled:opacity-50 flex items-center gap-1.5"
              >
                <FiX size={13} />
                <span>{t('reject') || '拒绝'}</span>
              </button>
              <button
                onClick={execute}
                disabled={busy}
                className="px-4 py-1.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] text-white text-[12px] font-medium transition-colors disabled:opacity-50 flex items-center gap-1.5 shadow-xs"
              >
                {busy ? (
                  <>
                    <FiLoader size={13} className="animate-spin" />
                    <span>执行中…</span>
                  </>
                ) : (
                  <>
                    <FiPlay size={13} />
                    <span>{t('execute') || '允许运行'}</span>
                  </>
                )}
              </button>
            </>
          ) : (
            <button
              onClick={onComplete || onClose}
              className="px-4 py-1.5 rounded-xl bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[12px] font-medium text-[var(--text-primary)] transition-colors"
            >
              {t('close') || '完成'}
            </button>
          )}
        </div>
      </div>
    </div>
  );
}