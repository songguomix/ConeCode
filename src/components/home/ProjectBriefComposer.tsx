import { useEffect, useRef, useState, type KeyboardEvent } from 'react';
import { FiArrowUp, FiCheck, FiCopy, FiCornerDownLeft, FiFolder, FiLoader, FiMessageSquare } from 'react-icons/fi';
import { useLanguageStore, useModelStore } from '../../stores';
import { useProjectBriefStore } from '../../stores/projectBrief.store';

export default function ProjectBriefComposer() {
  const { t, locale } = useLanguageStore();
  const model = useModelStore((s) => s.getSelectedModel());
  const { idea, brief, prompt, generating, starting, error, directory, setIdea, setPrompt, generate, start, cancel } = useProjectBriefStore();
  const [copied, setCopied] = useState(false);
  const [copyFailed, setCopyFailed] = useState(false);
  const outputRef = useRef<HTMLTextAreaElement>(null);
  const composing = useRef(false);
  const compositionEndedAt = useRef(0);
  const busy = generating || starting;
  useEffect(() => { if (brief) outputRef.current?.focus(); }, [brief]);
  useEffect(() => { setCopied(false); setCopyFailed(false); }, [prompt]);

  const generateBrief = () => model && void generate(model.providerId, model.id, locale);
  const startProject = () => model && void start(model.providerId, model.id);
  const onEnter = (event: KeyboardEvent<HTMLTextAreaElement>, action: () => void) => {
    if (event.key !== 'Enter' || event.shiftKey || composing.current || event.nativeEvent.isComposing ||
        event.keyCode === 229 || Date.now() - compositionEndedAt.current < 250) return;
    event.preventDefault();
    if (!busy) action();
  };
  const compositionProps = {
    onCompositionStart: () => { composing.current = true; },
    onCompositionEnd: () => { composing.current = false; compositionEndedAt.current = Date.now(); },
  };
  const copy = async () => {
    try { await navigator.clipboard.writeText(prompt); setCopied(true); setCopyFailed(false); }
    catch { setCopyFailed(true); }
  };

  return (
    <section className="mb-6 rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] p-4" aria-label={t('briefTitle')}>
      <div className="flex items-center gap-2 mb-1.5">
        <FiMessageSquare size={15} className="text-[var(--accent)]" />
        <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('briefTitle')}</h2>
      </div>
      <p className="text-xs text-[var(--text-muted)] mb-3 leading-relaxed">{t('briefDescription')}</p>
      <div className="rounded-xl bg-[var(--bg-3)] p-3 focus-within:ring-1 focus-within:ring-[var(--accent)]/50">
        <textarea
          id="conecode-project-idea"
          aria-label={t('briefIdeaLabel')}
          value={idea}
          onChange={(e) => setIdea(e.target.value)}
          onKeyDown={(e) => onEnter(e, generateBrief)}
          {...compositionProps}
          disabled={busy}
          rows={3}
          placeholder={t('briefPlaceholder')}
          className="block w-full resize-y min-h-[76px] max-h-64 bg-transparent text-sm leading-relaxed text-[var(--text-primary)] outline-none placeholder:text-[var(--text-muted)] disabled:opacity-60"
        />
        <div className="mt-2 flex items-center gap-2">
          <span className="flex-1 text-[11px] text-[var(--text-muted)]">{model ? t('briefInputHint') : t('selectModelHint')}</span>
          {generating ? (
            <button onClick={cancel} className="px-3 py-1.5 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] text-xs text-[var(--text-secondary)]">{t('cancel')}</button>
          ) : (
            <button onClick={generateBrief} disabled={!idea.trim() || !model || busy}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40">
              <FiArrowUp size={12} /> {t(brief ? 'briefRegenerate' : 'briefGenerate')}
            </button>
          )}
        </div>
      </div>

      {generating && (
        <div role="status" className="mt-3 flex items-center gap-2 text-xs text-[var(--text-secondary)]">
          <FiLoader size={13} className="animate-spin text-[var(--accent)]" />{t('briefThinking')}
        </div>
      )}
      {brief && !generating && (
        <div className="mt-4">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-xs font-semibold text-[var(--text-primary)]">{t('briefOutputTitle')}</span>
            <span className="text-xs text-[var(--text-muted)] truncate">{brief.title}</span>
          </div>
          <textarea
            ref={outputRef}
            aria-label={t('briefOutputTitle')}
            value={prompt}
            onChange={(e) => setPrompt(e.target.value)}
            onKeyDown={(e) => onEnter(e, startProject)}
            {...compositionProps}
            disabled={starting}
            rows={11}
            className="block w-full resize-y min-h-[180px] max-h-[480px] rounded-xl border border-[var(--border)] bg-[var(--bg-0)] p-3 text-sm leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
            <FiFolder size={12} className="shrink-0" />
            <span className="break-all">{directory || t('briefFolderHint')}</span>
          </div>
          <div className="mt-3 flex items-center justify-end gap-2 flex-wrap">
            <span className="mr-auto text-[11px] text-[var(--text-muted)]">{t('briefOutputHint')}</span>
            <button onClick={copy} disabled={!prompt.trim()}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg border border-[var(--border)] bg-[var(--bg-2)] text-xs text-[var(--text-secondary)] hover:text-[var(--accent)] disabled:opacity-40">
              {copied ? <FiCheck size={12} /> : <FiCopy size={12} />}{t(copied ? 'briefCopied' : 'briefCopy')}
            </button>
            <button onClick={startProject} disabled={!prompt.trim() || !model || busy}
              className="inline-flex items-center gap-1.5 px-3 py-2 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40">
              {starting ? <FiLoader size={12} className="animate-spin" /> : <FiCornerDownLeft size={12} />}{t(starting ? 'briefStarting' : 'briefStart')}
            </button>
          </div>
        </div>
      )}
      {(error || copyFailed) && <p role="alert" className="mt-3 text-xs text-[var(--error)]">{t(error || 'briefCopyFailed')}</p>}
    </section>
  );
}
