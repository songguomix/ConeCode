import { useEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { FiArrowRight, FiArrowUp, FiCornerDownLeft } from 'react-icons/fi';
import {
  buildResumePrompt,
  type Recommendation,
  type ResumeCandidate,
  type SuggestedTask,
} from '../../core/agenda/agenda';
import { useLanguageStore, useModelStore } from '../../stores';

interface Props {
  recommendation: Recommendation;
  tasks: SuggestedTask[];
  resume: ResumeCandidate[];
  hasFolder: boolean;
  onSend: (prompt: string) => void | Promise<void>;
  onOpenFolder: () => void;
  onScrollToIdeas: () => void;
}

/**
 * The "do this next" strip is a real dialog: the recommendation is prefilled,
 * the user can rewrite it, and Enter starts the work.
 */
export default function NextActionDialog({
  recommendation, tasks, resume, hasFolder, onSend, onOpenFolder, onScrollToIdeas,
}: Props) {
  const { t } = useLanguageStore();
  const model = useModelStore((s) => s.getSelectedModel)();
  const [draft, setDraft] = useState('');
  const [userEdited, setUserEdited] = useState(false);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);

  const defaultPrompt = useMemo(() => {
    switch (recommendation.kind) {
      case 'review':
        return t('homeReviewPrompt');
      case 'task':
        return tasks[0]?.prompt || '';
      case 'tests':
        return t('recTestsPrompt');
      case 'resume': {
        const target = resume.find((r) => r.openTodos.length) || resume[0];
        return target ? buildResumePrompt(target) : '';
      }
      case 'start':
      default:
        return '';
    }
  }, [recommendation.kind, tasks, resume, t]);

  // Follow the recommendation until the user takes over the draft.
  useEffect(() => {
    if (userEdited) return;
    setDraft(defaultPrompt);
  }, [defaultPrompt, userEdited]);

  useEffect(() => {
    setUserEdited(false);
  }, [recommendation.kind, recommendation.key]);

  const canSend = !!model && !!draft.trim() && !!rootSafe(hasFolder, recommendation.kind);
  const needsFolder = recommendation.kind !== 'start' && !hasFolder;

  const placeholder = recommendation.kind === 'start'
    ? t('recDialogStartPlaceholder')
    : t('recDialogPlaceholder');

  const submit = () => {
    if (!model) return;
    const text = draft.trim();
    if (text) {
      void onSend(text);
      return;
    }
    // Empty draft: fall through to the structural action.
    if (recommendation.kind === 'start') {
      if (!hasFolder) onOpenFolder();
      else onScrollToIdeas();
      return;
    }
    if (defaultPrompt) void onSend(defaultPrompt);
  };

  const onEnter = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing ||
        event.keyCode === 229 || Date.now() - compositionEndedAt.current < 250) return;
    event.preventDefault();
    submit();
  };

  const primaryLabel = recommendation.kind === 'start' && !draft.trim()
    ? (hasFolder ? t('recDialogBrowseIdeas') : t('openFolder'))
    : t('recDialogSend');

  return (
    <section
      className="mb-6 rounded-2xl border border-[var(--accent)]/40 bg-[var(--accent-soft)] p-4 min-w-0 overflow-hidden"
      aria-label={t('recLabel')}
    >
      <div className="flex items-center gap-2 mb-1 min-w-0">
        <FiArrowRight size={14} className="text-[var(--accent)] shrink-0" />
        <span className="text-[11px] font-semibold uppercase tracking-wide text-[var(--accent)]">
          {t('recLabel')}
        </span>
      </div>
      <div className="mb-3 flex items-baseline gap-2 flex-wrap min-w-0">
        <span className="text-sm font-medium text-[var(--text-primary)] break-words">
          {t(recommendation.key)}
        </span>
        {recommendation.detail && (
          <span className="text-xs text-[var(--text-secondary)] truncate min-w-0 flex-1">{recommendation.detail}</span>
        )}
      </div>

      <div className="rounded-xl bg-[var(--bg-2)] border border-[var(--border)] p-3 focus-within:border-[var(--accent)]/60 focus-within:ring-1 focus-within:ring-[var(--accent)]/40 min-w-0">
        <textarea
          aria-label={t('recDialogInputAria')}
          value={draft}
          onChange={(e) => { setDraft(e.target.value); setUserEdited(true); }}
          onKeyDown={onEnter}
          onCompositionStart={() => { composing.current = true; }}
          onCompositionEnd={() => { composing.current = false; compositionEndedAt.current = Date.now(); }}
          rows={3}
          placeholder={placeholder}
          className="block w-full resize-y min-h-[72px] max-h-48 bg-transparent text-sm leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)]"
        />
        <div className="mt-2 flex items-center gap-2 flex-wrap">
          <span className="flex-1 min-w-[120px] text-[11px] text-[var(--text-muted)]">
            {model ? t('recDialogHint') : t('selectModelHint')}
          </span>
          {recommendation.kind === 'start' && !hasFolder && !draft.trim() ? (
            <button
              onClick={onOpenFolder}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)]"
            >
              <FiCornerDownLeft size={12} /> {primaryLabel}
            </button>
          ) : recommendation.kind === 'start' && hasFolder && !draft.trim() ? (
            <button
              onClick={onScrollToIdeas}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)]"
            >
              <FiCornerDownLeft size={12} /> {primaryLabel}
            </button>
          ) : (
            <button
              onClick={submit}
              disabled={!canSend && !(recommendation.kind === 'start')}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40"
            >
              <FiArrowUp size={12} /> {primaryLabel}
            </button>
          )}
        </div>
        {needsFolder && (
          <p className="mt-2 text-[11px] text-[var(--warning)]">{t('homeNoFolder')}</p>
        )}
      </div>
    </section>
  );
}

function rootSafe(hasFolder: boolean, kind: Recommendation['kind']): boolean {
  // Free-form messages need a workspace; "start" does not.
  if (kind === 'start') return true;
  return hasFolder;
}
