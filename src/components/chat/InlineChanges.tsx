import { memo, useMemo, useState } from 'react';
import { FiCheck, FiX, FiRotateCcw, FiTerminal, FiTrash, FiCopy, FiMove, FiEdit, FiFilePlus, FiAlertTriangle } from 'react-icons/fi';
import { useCodeChangesStore, useLanguageStore, useChatStore } from '../../stores';
import { checkpointRewindIndex, type CodeChange } from '../../stores/codeChanges.store';
import { buildDisplayDiff } from '../../core/editor/displayDiff';
import { isCommandChange, pendingFileChanges } from './approvalPresentation';
import DiffPreview from './DiffPreview';

function classify(change: CodeChange) {
  const kind = change.kind || 'edit';
  return {
    isCommand: kind === 'exec',
    isExternal: kind === 'exec' || kind === 'computer',
    isDelete: kind === 'delete',
    isRename: kind === 'rename',
    isCopy: kind === 'copy',
    isCreate: kind === 'create',
    // Both edits and creations render as a diff and are revertible on disk.
    isFileEdit: kind === 'edit' || kind === 'create',
  };
}

function opIcon(change: CodeChange) {
  const { isDelete, isRename, isCopy, isCreate } = classify(change);
  if (isDelete) return <FiTrash size={13} />;
  if (isRename) return <FiMove size={13} />;
  if (isCopy) return <FiCopy size={13} />;
  if (isCreate) return <FiFilePlus size={13} />;
  return <FiEdit size={13} />;
}

function opColor(change: CodeChange) {
  const { isDelete, isRename, isCopy } = classify(change);
  if (isDelete) return 'text-red-500';
  if (isRename || isCopy) return 'text-blue-500';
  return 'text-green-500';
}

/**
 * File diffs stay inline. Commands only leave a compact status row here and are
 * reviewed in the single dialog owned by ChatView, keeping the transcript small.
 */
export default memo(MessageChanges);

function MessageChanges({
  messageId,
  onReviewCommand,
}: {
  messageId: string;
  onReviewCommand: (changeId: string) => void;
}) {
  const changes = useCodeChangesStore((s) => s.changes);
  const applyChange = useCodeChangesStore((s) => s.applyChange);
  const revertChange = useCodeChangesStore((s) => s.revertChange);
  const { t } = useLanguageStore();
  const [busy, setBusy] = useState(false);

  const mine = useMemo(
    () => changes.filter((c) => c.messageId === messageId).sort((a, b) => a.createdAt - b.createdAt),
    [changes, messageId],
  );
  if (mine.length === 0) return null;

  const pendingFiles = pendingFileChanges(mine);

  // Resolve sequentially: each apply/revert pushes to the store's batch and the
  // last one (no pending left) flushes the outcome back to the model.
  const applyAll = async () => {
    setBusy(true);
    for (const c of pendingFiles) await applyChange(c.id);
    setBusy(false);
    // Jump the transcript to the bottom so the user follows the model's
    // continued response after approving everything.
    window.dispatchEvent(new Event('conecode:scrollChatBottom'));
  };
  const rejectAll = async () => {
    setBusy(true);
    for (const c of pendingFiles) await revertChange(c.id);
    setBusy(false);
  };

  return (
    <div className="flex gap-3 mt-1.5">
      <div className="w-8 shrink-0" />
      <div className="flex-1 min-w-0 space-y-2">
        {pendingFiles.length >= 2 && (
          <div className="flex items-center gap-2 px-0.5">
            <span className="text-xs text-[var(--text-muted)]">{pendingFiles.length} {t('pending')}</span>
            <div className="ml-auto flex items-center gap-1.5">
              <button onClick={applyAll} disabled={busy}
                className="px-2.5 py-1 rounded-lg bg-green-500/15 text-xs font-semibold text-green-700 dark:text-green-300 hover:bg-green-500/25 border border-green-600/30 flex items-center gap-1 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
                <FiCheck size={12} /> {t('applyAll')}
              </button>
              <button onClick={rejectAll} disabled={busy}
                className="px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-4)] border border-[var(--border)] flex items-center gap-1 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
                <FiX size={12} /> {t('rejectAll')}
              </button>
            </div>
          </div>
        )}
        {mine.map((c) =>
          isCommandChange(c)
            ? <CommandStatusRow key={c.id} change={c} onReview={() => onReviewCommand(c.id)} />
            : <DiffReviewCard key={c.id} change={c} />,
        )}
      </div>
    </div>
  );
}

/**
 * Undo one reversible workspace change while retaining the transcript. This is
 * the safe, default action on an applied file card.
 */
function UndoChangeConfirmBar({ change, onCancel }: { change: CodeChange; onCancel: () => void }) {
  const revertChange = useCodeChangesStore((s) => s.revertChange);
  const { t } = useLanguageStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    setBusy(true);
    setError(null);
    const result = await revertChange(change.id);
    if (!result.success) {
      setError(result.error || t('revertFailed'));
      setBusy(false);
      return;
    }
    setBusy(false);
    onCancel();
  };

  return (
    <div className="px-3 py-2 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] space-y-1.5">
      <div className="text-xs font-medium text-[var(--text-secondary)]">{t('undoChangeConfirmTitle')}</div>
      <div className="text-[11px] text-[var(--text-muted)]">{t('undoChangeKeepsChat')}</div>
      {error && <div className="text-[11px] text-[var(--error)] whitespace-pre-wrap">{error}</div>}
      <div className="flex items-center gap-1.5 pt-0.5">
        <button onClick={run} disabled={busy}
          className="px-2.5 py-1 rounded-lg bg-[var(--bg-4)] text-xs font-semibold text-[var(--text-primary)] hover:brightness-110 border border-[var(--border)] flex items-center gap-1 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
          <FiRotateCcw size={11} /> {t('undoChange')}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="px-2.5 py-1 rounded-lg text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-4)] disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

/**
 * Destructive checkpoint rollback. It previews the full transcript/workspace
 * scope and keeps already-executed external actions truthful and visible.
 */
function CheckpointRollbackConfirmBar({ change, onCancel }: { change: CodeChange; onCancel: () => void }) {
  const revertToMessage = useCodeChangesStore((s) => s.revertToMessage);
  const changes = useCodeChangesStore((s) => s.changes);
  const messages = useChatStore((s) => s.messages);
  const { t } = useLanguageStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Preview the FULL scope: rolling back to a message undoes everything from
  // that message onward, not just the change on this card.
  const preview = useMemo(() => {
    const idx = change.messageId ? checkpointRewindIndex(messages, change.messageId) : -1;
    if (idx === -1) return { files: [], externalEffects: 0, messageCount: 0 };
    const doomed = new Set(messages.slice(idx).map((m) => m.id));
    const affected = changes.filter(
      (c) => c.messageId && doomed.has(c.messageId) && (c.status === 'applied' || c.status === 'pending'),
    );
    return {
      files: Array.from(new Set(
        affected
          .filter((c) => c.kind !== 'exec' && c.kind !== 'computer')
          .map((c) => c.filePath.split('/').pop() || c.filePath),
      )),
      externalEffects: affected.filter(
        (c) => (c.kind === 'exec' || c.kind === 'computer') && c.status === 'applied',
      ).length,
      messageCount: messages.length - idx,
    };
  }, [messages, changes, change.messageId]);

  const run = async () => {
    setBusy(true);
    setError(null);
    if (!change.messageId) {
      setError(t('checkpointUnavailable'));
      setBusy(false);
      return;
    }
    const r = await revertToMessage(change.messageId);
    if (!r.success && r.error) {
      setError(r.error);
      setBusy(false);
      return;
    }
    setBusy(false);
    onCancel();
  };

  return (
    <div className="px-3 py-2 border-t border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] space-y-1.5">
      <div className="text-xs text-[var(--text-secondary)]">
        {t('checkpointRollbackTitle')}
        {preview.files.length > 0 && (
          <span className="ml-1 font-mono text-[var(--text-muted)]">{preview.files.join(', ')}</span>
        )}
      </div>
      <div className="text-[11px] text-[var(--text-muted)]">
        {t('checkpointRollbackChat')}
        {preview.messageCount > 1 && <span className="ml-1">({preview.messageCount})</span>}
      </div>
      {preview.externalEffects > 0 && (
        <div className="text-[11px] text-[var(--warning)] flex items-start gap-1">
          <FiAlertTriangle size={11} className="mt-0.5 shrink-0" />
          <span>{t('checkpointExternalEffects')}</span>
        </div>
      )}
      {error && <div className="text-[11px] text-[var(--error)] whitespace-pre-wrap">{error}</div>}
      <div className="flex items-center gap-1.5 pt-0.5">
        <button onClick={run} disabled={busy}
          className="px-2.5 py-1 rounded-lg bg-[color-mix(in_srgb,var(--error)_15%,transparent)] text-xs font-semibold text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_25%,transparent)] border border-[color-mix(in_srgb,var(--error)_30%,transparent)] flex items-center gap-1 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
          <FiRotateCcw size={11} /> {t('confirmCheckpointRollback')}
        </button>
        <button onClick={onCancel} disabled={busy}
          className="px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-4)] border border-[var(--border)] disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
          {t('cancel')}
        </button>
      </div>
    </div>
  );
}

function UndoChangeButton({ onClick }: { onClick: () => void }) {
  const { t } = useLanguageStore();
  return (
    <button onClick={onClick} title={t('undoChangeKeepsChat')}
      className="px-2 py-1 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-4)] flex items-center gap-1 cursor-pointer transition-colors">
      <FiRotateCcw size={11} /> {t('undoChange')}
    </button>
  );
}

function CheckpointRollbackButton({ onClick }: { onClick: () => void }) {
  const { t } = useLanguageStore();
  return (
    <button onClick={onClick} title={t('checkpointRollbackChat')}
      className="px-2 py-1 rounded-lg text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] flex items-center gap-1 cursor-pointer transition-colors">
      <FiAlertTriangle size={11} /> {t('rollbackConversation')}
    </button>
  );
}

// The transcript keeps a one-line command record; the actual decision happens
// in CommandApprovalCard so long commands no longer consume the chat viewport.
function CommandStatusRow({ change, onReview }: { change: CodeChange; onReview: () => void }) {
  const { t } = useLanguageStore();
  const [confirmingCheckpoint, setConfirmingCheckpoint] = useState(false);
  const pending = change.status === 'pending';

  return (
    <div className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden">
      <div className="flex items-center gap-2 px-2.5 py-1.5 min-h-9">
        <FiTerminal size={12} className={pending ? 'text-yellow-500' : 'text-[var(--text-muted)]'} />
        <span className="text-[11px] font-semibold text-[var(--text-secondary)] shrink-0">{t('commandExecution')}</span>
        <code className="text-xs text-[var(--text-muted)] truncate min-w-0" title={change.newCode}>
          $ {change.newCode}
        </code>
        <div className="ml-auto flex items-center gap-1.5 shrink-0">
          {pending ? (
            <>
              <span className="hidden sm:inline text-[11px] text-yellow-600 dark:text-yellow-400">{t('pendingApproval')}</span>
              <button
                onClick={onReview}
                className="px-2 py-1 rounded-md bg-yellow-500/15 text-[11px] font-semibold text-yellow-700 dark:text-yellow-300 hover:bg-yellow-500/25 border border-yellow-600/25 cursor-pointer transition-colors"
              >
                {t('reviewCommand')}
              </button>
            </>
          ) : (
            <>
              <span className={`text-[11px] flex items-center gap-1 ${
                change.status === 'applied' ? 'text-green-500'
                  : change.status === 'failed' ? 'text-[var(--error)]'
                    : 'text-[var(--text-muted)]'
              }`}>
                {change.status === 'applied'
                  ? <><FiCheck size={11} /> {t('applied')}</>
                  : change.status === 'failed'
                    ? <><FiAlertTriangle size={11} /> {t('changeFailed')}</>
                    : <><FiRotateCcw size={11} /> {t('reverted')}</>}
              </span>
              {change.status === 'applied' && change.messageId && !confirmingCheckpoint && (
                <CheckpointRollbackButton onClick={() => setConfirmingCheckpoint(true)} />
              )}
            </>
          )}
        </div>
      </div>

      {confirmingCheckpoint && (
        <CheckpointRollbackConfirmBar change={change} onCancel={() => setConfirmingCheckpoint(false)} />
      )}
    </div>
  );
}

// ---- File edit / delete / rename / copy: Trae-style inline diff review ----
function DiffReviewCard({ change }: { change: CodeChange }) {
  const applyChange = useCodeChangesStore((s) => s.applyChange);
  const revertChange = useCodeChangesStore((s) => s.revertChange);
  const { t } = useLanguageStore();
  const { isRename, isCopy, isFileEdit, isExternal } = classify(change);
  const [busy, setBusy] = useState(false);
  const [applyError, setApplyError] = useState<string | null>(null);
  const [revertError, setRevertError] = useState<string | null>(null);
  const [confirming, setConfirming] = useState<'change' | 'checkpoint' | null>(null);
  const pending = change.status === 'pending';
  const applied = change.status === 'applied';
  const failed = change.status === 'failed';

  const diff = useMemo(
    () => (isFileEdit ? buildDisplayDiff(change.originalCode, change.newCode) : null),
    [change.originalCode, change.newCode, isFileEdit],
  );
  const added = diff?.lines.filter((line) => line.type === 'added').length ?? 0;
  const removed = diff?.lines.filter((line) => line.type === 'removed').length ?? 0;

  const accept = async () => {
    setBusy(true);
    setApplyError(null);
    const response = await applyChange(change.id);
    if (!response.success) setApplyError(response.result || t('changeFailed'));
    setBusy(false);
  };
  const reject = async () => {
    setBusy(true);
    setRevertError(null);
    const r = await revertChange(change.id);
    if (!r.success && r.error) setRevertError(r.error);
    setBusy(false);
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden">
      <div className="flex flex-wrap items-center justify-between px-3 py-2 border-b border-[var(--border)] gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className={opColor(change)}>{opIcon(change)}</span>
          <span className="text-sm font-medium truncate" title={change.filePath}>{change.filePath.split(/[/\\]/).pop()}</span>
          {diff && (added > 0 || removed > 0) && (
            <span className="flex shrink-0 gap-1 text-xs" title={diff.approximate ? t('diffApproximateCounts') : undefined}>
              {diff.approximate && '≈'}
              {added > 0 && <span className="font-medium text-green-600 dark:text-green-400">+{added}</span>}
              {removed > 0 && <span className="font-medium text-red-600 dark:text-red-400">−{removed}</span>}
            </span>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-1.5">
          {pending ? (
            <>
              <button onClick={accept} disabled={busy}
                className="px-2.5 py-1 rounded-lg bg-green-500/15 text-xs font-semibold text-green-700 dark:text-green-300 hover:bg-green-500/25 border border-green-600/30 flex items-center gap-1 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
                <FiCheck size={12} /> {t('apply')}
              </button>
              <button onClick={reject} disabled={busy}
                className="px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-xs font-semibold text-[var(--text-secondary)] hover:bg-[var(--bg-4)] border border-[var(--border)] flex items-center gap-1 disabled:opacity-50 cursor-pointer disabled:cursor-not-allowed transition-all">
                <FiX size={12} /> {t('reject')}
              </button>
            </>
          ) : applied ? (
            <>
              <span className="text-xs text-green-500 flex items-center gap-1"><FiCheck size={12} /> {t('applied')}</span>
              {!confirming && !isExternal && <UndoChangeButton onClick={() => setConfirming('change')} />}
              {!confirming && change.messageId && (
                <CheckpointRollbackButton onClick={() => setConfirming('checkpoint')} />
              )}
            </>
          ) : failed ? (
            <span className="text-xs text-[var(--error)] flex items-center gap-1"><FiAlertTriangle size={12} /> {t('changeFailed')}</span>
          ) : (
            <span className="text-xs text-[var(--text-muted)] flex items-center gap-1"><FiRotateCcw size={12} /> {t('reverted')}</span>
          )}
        </div>
      </div>

      {confirming === 'change' && <UndoChangeConfirmBar change={change} onCancel={() => setConfirming(null)} />}
      {confirming === 'checkpoint' && (
        <CheckpointRollbackConfirmBar change={change} onCancel={() => setConfirming(null)} />
      )}

      {change.description && (
        <div className="px-3 py-1.5 text-xs text-[var(--text-muted)] border-b border-[var(--border)]">{change.description}</div>
      )}

      {revertError && (
        <div className="px-3 py-1.5 text-xs text-[var(--error)] border-b border-[var(--border)]">
          {t('revertFailed')}: {revertError}
        </div>
      )}

      {applyError && (
        <div className="px-3 py-1.5 text-xs text-[var(--error)] border-b border-[var(--border)] whitespace-pre-wrap">
          {applyError}
        </div>
      )}

      {isRename && (
        <div className="px-3 py-2 text-xs font-mono">
          <div className="text-red-500">{t('from')} {change.filePath}</div>
          <div className="text-green-500">{t('to')} {change.newCode.replace('Rename to: ', '')}</div>
        </div>
      )}

      {isCopy && (
        <div className="px-3 py-2 text-xs font-mono">
          <div className="text-blue-500">{t('source')} {change.filePath}</div>
          <div className="text-green-500">{t('destination')} {change.newCode.replace('Copy to: ', '')}</div>
        </div>
      )}

      {diff && diff.lines.length > 0 && (
        <DiffPreview lines={diff.lines} approximate={diff.approximate} label={`${t('gitDiff')}: ${change.filePath}`} />
      )}
    </div>
  );
}
