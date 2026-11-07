import {
  FiRefreshCw, FiZap, FiFolder, FiCheckCircle, FiAlertCircle, FiLoader, FiPlay, FiTerminal, FiEdit3,
} from 'react-icons/fi';
import { useAutopilotStore, useLanguageStore, useModelStore, useWorkspaceStore } from '../../stores';
import type { ProjectIdea } from '../../core/agenda/newProject';

/**
 * Pick one, and that is the whole interaction: the agent creates the folder,
 * builds the project, runs it, and fixes what fails — unattended.
 *
 * Nothing is generated on mount: the user decides whether the AI should think
 * at all, or describes the project themselves.
 */
export default function ProjectIdeas({ onCompose }: { onCompose?: () => void }) {
  const { t, locale } = useLanguageStore();
  const ideas = useAutopilotStore((s) => s.ideas);
  const loadingIdeas = useAutopilotStore((s) => s.loadingIdeas);
  const loadIdeas = useAutopilotStore((s) => s.loadIdeas);
  const run = useAutopilotStore((s) => s.run);
  const reset = useAutopilotStore((s) => s.reset);
  const phase = useAutopilotStore((s) => s.phase);
  const running = useAutopilotStore((s) => s.running);
  const projectDir = useAutopilotStore((s) => s.projectDir);
  const attempt = useAutopilotStore((s) => s.attempt);
  const verifyCommand = useAutopilotStore((s) => s.verifyCommand);
  const lastOutput = useAutopilotStore((s) => s.lastOutput);
  const error = useAutopilotStore((s) => s.error);
  const model = useModelStore((s) => s.getSelectedModel)();
  const selectFile = useWorkspaceStore((s) => s.selectFile);

  const busy = phase !== 'idle' && phase !== 'done' && phase !== 'failed';

  if (busy || phase === 'done' || phase === 'failed') {
    return (
      <AutopilotStatus
        t={t}
        phase={phase}
        title={running?.title || ''}
        projectDir={projectDir}
        attempt={attempt}
        verifyCommand={verifyCommand}
        lastOutput={lastOutput}
        error={error}
        onDismiss={reset}
        onOpenReadme={() => projectDir && selectFile(`${projectDir}/README.md`)}
      />
    );
  }

  const idle = ideas.length === 0 && !loadingIdeas;

  return (
    <div>
      {!idle && (
        <div className="flex items-center gap-2 mb-2.5">
          <h2 className="text-[16px] font-bold text-[var(--text-primary)] font-serif tracking-tight">{t('autopilotTitle')}</h2>
          <button
            onClick={() => loadIdeas(model?.providerId, model?.id, true, locale)}
            disabled={loadingIdeas}
            className="ml-auto inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-[var(--glass-card)] text-[var(--text-secondary)] border border-[var(--glass-border)] hover:border-[var(--accent)] hover:text-[var(--accent)] backdrop-blur-md transition-all shadow-2xs disabled:opacity-40 cursor-pointer"
          >
            <FiRefreshCw size={11} className={loadingIdeas ? 'animate-spin' : ''} />
            {t('autopilotMore')}
          </button>
        </div>
      )}

      {idle ? (
        <div className="flex items-center gap-2 flex-wrap">
          <button
            onClick={() => void loadIdeas(model?.providerId, model?.id, true, locale)}
            className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] shadow-xs transition-colors cursor-pointer"
          >
            <FiZap size={12} />
            {t('autopilotGenerate')}
          </button>
          {onCompose && (
            <button
              onClick={onCompose}
              className="inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[var(--glass-card)] text-[var(--text-secondary)] border border-[var(--glass-border)] hover:border-[var(--accent)] hover:text-[var(--accent)] backdrop-blur-md transition-all shadow-2xs cursor-pointer text-xs font-medium"
            >
              <FiEdit3 size={12} />
              {t('autopilotCompose')}
            </button>
          )}
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
          {loadingIdeas && ideas.length === 0 && [0, 1, 2].map((i) => (
            <div key={i} className="rounded-xl border border-[var(--glass-border)] bg-[var(--glass-card)] p-3.5 min-h-[116px] anim-shimmer min-w-0 shadow-2xs">
              <div className="h-3 w-2/3 rounded bg-[var(--bg-3)]" />
              <div className="mt-2.5 h-2.5 w-full rounded bg-[var(--bg-3)]" />
              <div className="mt-1.5 h-2.5 w-4/5 rounded bg-[var(--bg-3)]" />
            </div>
          ))}
          {/* One row only: everything visible without scrolling, 换一批 rotates. */}
          {ideas.slice(0, 3).map((idea) => (
            <IdeaCard key={idea.id} idea={idea} t={t}
              disabled={!model}
              onPick={() => model && run(idea, model.providerId, model.id)} />
          ))}
        </div>
      )}
    </div>
  );
}

function IdeaCard({
  idea, onPick, disabled, t,
}: {
  idea: ProjectIdea; onPick: () => void; disabled: boolean; t: (k: string) => string;
}) {
  return (
    <button
      onClick={onPick}
      disabled={disabled}
      className="group text-left rounded-xl border border-[var(--glass-border)] bg-[var(--glass-card)] hover:bg-[var(--glass-surface)] p-4 hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:shadow-[0_4px_16px_rgba(201,100,66,0.06)] transition-colors disabled:opacity-40 flex flex-col gap-2 min-h-[80px] min-w-0 overflow-hidden shadow-2xs cursor-pointer"
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className="text-[15px] font-bold text-[var(--text-primary)] font-serif leading-snug flex-1 min-w-0 truncate">{idea.title}</span>
        <FiPlay size={12} className="shrink-0 mt-0.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--accent)] transition-all" />
      </div>
      <div className="mt-auto flex items-center gap-1.5 flex-wrap">
        {idea.stack && (
          <span className="text-[10px] font-mono text-[var(--text-secondary)] truncate max-w-full" title={idea.stack}>{idea.stack}</span>
        )}
        {idea.scale === 'medium' && (
          <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-muted)]">{t('autopilotMedium')}</span>
        )}
      </div>
    </button>
  );
}

const PHASE_LABEL: Record<string, string> = {
  creating: 'autopilotCreating',
  building: 'autopilotBuilding',
  verifying: 'autopilotVerifying',
  repairing: 'autopilotRepairing',
};

function AutopilotStatus({
  t, phase, title, projectDir, attempt, verifyCommand, lastOutput, error, onDismiss, onOpenReadme,
}: {
  t: (k: string) => string;
  phase: string;
  title: string;
  projectDir: string | null;
  attempt: number;
  verifyCommand: string | null;
  lastOutput: string;
  error: string | null;
  onDismiss: () => void;
  onOpenReadme: () => void;
}) {
  const done = phase === 'done';
  const failed = phase === 'failed';
  const steps: { key: string; label: string }[] = [
    { key: 'creating', label: 'autopilotCreating' },
    { key: 'building', label: 'autopilotBuilding' },
    { key: 'verifying', label: 'autopilotVerifying' },
  ];
  const order = ['creating', 'building', 'verifying', 'repairing', 'done', 'failed'];
  const current = order.indexOf(phase);

  return (
    <div className={`rounded-xl border p-4 ${
      done ? 'border-[color-mix(in_srgb,var(--success)_40%,transparent)] bg-[color-mix(in_srgb,var(--success)_5%,transparent)]'
      : failed ? 'border-[color-mix(in_srgb,var(--error)_40%,transparent)] bg-[color-mix(in_srgb,var(--error)_5%,transparent)]'
      : 'border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-[var(--bg-2)]'
    }`}>
      <div className="flex items-center gap-2">
        {done ? <FiCheckCircle size={16} className="text-[var(--success)]" />
          : failed ? <FiAlertCircle size={16} className="text-[var(--error)]" />
          : <FiLoader size={16} className="text-[var(--accent)] animate-spin" />}
        <span className="text-sm font-semibold text-[var(--text-primary)]">
          {done ? t('autopilotDone') : failed ? t('autopilotFailed') : t(PHASE_LABEL[phase] || 'autopilotBuilding')}
        </span>
        <span className="text-sm text-[var(--text-secondary)] truncate">{title}</span>
        {(done || failed) && (
          <button onClick={onDismiss}
            className="ml-auto px-2 py-1 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-4)] cursor-pointer transition-colors">
            {t('close')}
          </button>
        )}
      </div>

      {projectDir && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px] text-[var(--text-muted)]">
          <FiFolder size={11} />
          <span className="font-mono truncate">{projectDir}</span>
        </div>
      )}

      {!done && !failed && (
        <div className="mt-3 flex items-center gap-2">
          {steps.map((s) => {
            const stepIdx = order.indexOf(s.key);
            // Repairing is a loop back through verification, so that step stays
            // ACTIVE rather than reading as already finished.
            const active = current === stepIdx || (phase === 'repairing' && s.key === 'verifying');
            const state = active ? 'active' : current > stepIdx ? 'done' : 'todo';
            return (
              <div key={s.key} className="flex items-center gap-2 flex-1">
                <div className={`h-1 flex-1 rounded-full ${
                  state === 'done' ? 'bg-[var(--success)]'
                  : state === 'active' ? 'bg-[var(--accent)] animate-pulse'
                  : 'bg-[var(--border)]'
                }`} />
              </div>
            );
          })}
        </div>
      )}

      {phase === 'repairing' && (
        <p className="mt-2 text-[11px] text-[var(--warning)]">
          {t('autopilotRepairingHint')} ({attempt})
        </p>
      )}

      {verifyCommand && (
        <div className="mt-2 flex items-center gap-1.5 text-[11px]">
          <FiTerminal size={11} className="text-[var(--text-muted)]" />
          <span className="font-mono text-[var(--text-secondary)] truncate">{verifyCommand}</span>
          {done && <span className="text-[var(--success)]">✓</span>}
        </div>
      )}

      {done && (
        <div className="mt-3 flex items-center gap-2">
          <p className="text-xs text-[var(--text-secondary)] flex-1">{t('autopilotDoneHint')}</p>
          <button onClick={onOpenReadme}
            className="shrink-0 px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] cursor-pointer transition-colors">
            {t('autopilotOpenReadme')}
          </button>
        </div>
      )}

      {failed && (
        <>
          <p className="mt-2 text-xs text-[var(--text-secondary)]">
            {error === 'no-verify-command' ? t('autopilotNoVerify')
              : error === 'could-not-create-folder' ? t('autopilotNoFolder')
              : t('autopilotFailedHint')}
          </p>
          {lastOutput && (
            <pre className="mt-2 max-h-32 overflow-y-auto rounded-lg bg-[var(--bg-3)] p-2 text-[10px] font-mono whitespace-pre-wrap text-[var(--text-muted)]">
              {lastOutput.slice(-1200)}
            </pre>
          )}
        </>
      )}
    </div>
  );
}
