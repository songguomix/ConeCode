import { useEffect, useMemo, useState } from 'react';
import {
  FiRefreshCw, FiFolder, FiGitBranch, FiArrowRight, FiZap,
  FiAlertCircle, FiTool, FiFileText, FiCheckSquare, FiPackage, FiPlay,
} from 'react-icons/fi';
import {
  useAgendaStore, useChatStore, useLanguageStore, useModelStore, useWorkspaceStore,
} from '../../stores';
import { type SuggestedTask, type TaskKind, buildLocalTasks } from '../../core/agenda/agenda';
import ProjectIdeas from './ProjectIdeas';
import ProjectBriefComposer from './ProjectBriefComposer';

const KIND_STYLE: Record<TaskKind, { icon: JSX.Element; color: string; bg: string }> = {
  bug: { icon: <FiAlertCircle size={14} />, color: 'text-red-500', bg: 'bg-red-500/10' },
  test: { icon: <FiCheckSquare size={14} />, color: 'text-emerald-500', bg: 'bg-emerald-500/10' },
  refactor: { icon: <FiTool size={14} />, color: 'text-violet-500', bg: 'bg-violet-500/10' },
  feature: { icon: <FiZap size={14} />, color: 'text-blue-500', bg: 'bg-blue-500/10' },
  docs: { icon: <FiFileText size={14} />, color: 'text-amber-500', bg: 'bg-amber-500/10' },
  chore: { icon: <FiPackage size={14} />, color: 'text-[var(--text-muted)]', bg: 'bg-[var(--bg-3)]' },
};

const EFFORT_DOTS: Record<SuggestedTask['effort'], number> = { quick: 1, medium: 2, large: 3 };

function timeAgo(ts: number, t: (k: string) => string): string {
  const mins = Math.floor((Date.now() - ts) / 60000);
  if (mins < 1) return t('justNow');
  if (mins < 60) return `${mins}${t('minutesAgoShort')}`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}${t('hoursAgoShort')}`;
  const days = Math.floor(hours / 24);
  return `${days}${t('daysAgoShort')}`;
}

/**
 * The home screen: instead of an empty prompt, the agent looks at the real state
 * of the workspace and offers work to start — proposed tasks grounded in the
 * scan, or a new project to scaffold.
 */
export default function AgentHome() {
  const { t } = useLanguageStore();
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const model = getSelectedModel();

  const scan = useAgendaStore((s) => s.scan);
  const tasks = useAgendaStore((s) => s.tasks);
  const scanning = useAgendaStore((s) => s.scanning);
  const suggesting = useAgendaStore((s) => s.suggesting);
  const error = useAgendaStore((s) => s.error);
  const generatedAt = useAgendaStore((s) => s.generatedAt);
  const findWork = useAgendaStore((s) => s.findWork);
  const loadCached = useAgendaStore((s) => s.loadCached);
  const scanWorkspace = useAgendaStore((s) => s.scanWorkspace);


  // Facts are free, so scan as soon as a folder is open; suggestions cost tokens
  const facts = useMemo(() => {
    if (!scan) return [] as { text: string; warn?: boolean }[];
    const out: { text: string; warn?: boolean }[] = [];
    if (scan.git.dirty > 0) out.push({ text: `${scan.git.dirty} ${t('homeUncommitted')}`, warn: true });
    else if (scan.git.isRepo) out.push({ text: t('homeClean') });
    if (scan.todoComments.length) out.push({ text: `${scan.todoComments.length} TODO` });
    if (!scan.hasTests) out.push({ text: t('homeNoTests'), warn: true });
    if (scan.fileCount) out.push({ text: `${scan.fileCount}${scan.fileCountCapped ? '+' : ''} ${t('homeFiles')}` });
    if (scan.languages.length) out.push({ text: scan.languages.join(' / ') });
    if (scan.scripts.length) out.push({ text: `${scan.scripts.length} ${t('homeScripts')}` });
    return out;
  }, [scan, t]);

  // Facts are free, so scan as soon as a folder is open; suggestions cost tokens
  // and stay on an explicit click (or a warm cache).
  useEffect(() => {
    if (!rootPath) return;
    loadCached();
    void scanWorkspace();
  }, [rootPath, scanWorkspace, loadCached]);

  // Deterministic one-click tasks from the free scan — no tokens involved.
  const localTasks = useMemo(() => (scan ? buildLocalTasks(scan, t) : []), [scan, t]);

  const start = async (prompt: string) => {
    if (!model) return;
    await sendMessage(prompt, model.providerId, model.id);
  };

  const busy = scanning || suggesting;
  // Two rows visible without scrolling; the rest unfold on click.
  const [showAllTasks, setShowAllTasks] = useState(false);
  // Skeletons stand in for tasks being fetched — NOT for the free re-scan of
  // local facts, which must not blank out proposals the user is reading.
  const showSkeletons = suggesting || (scanning && tasks.length === 0);

  return (
    <div className="max-w-[900px] mx-auto w-full pt-5 pb-6 min-w-0">
      {/* ---- Header: one status line when a folder is open, nothing when not ---- */}
      {rootPath && (
        <div className="flex items-center gap-1.5 mb-4 min-w-0 text-xs text-[var(--text-muted)] flex-wrap">
          <span className="text-sm font-semibold text-[var(--text-primary)] truncate">
            {scan?.projectName || rootPath.split('/').pop()}
          </span>
          {scan?.git.isRepo && scan.git.branch && (
            <span className="inline-flex items-center gap-1 shrink-0">
              <FiGitBranch size={11} />{scan.git.branch}
            </span>
          )}
          {/* Whatever the scan actually found, in whatever combination —
              nothing here is a fixed slot. */}
          {facts.map((fact, i) => (
            <span key={i} className={`shrink-0 ${fact.warn ? 'text-[var(--warning)]' : ''}`}>
              · {fact.text}
            </span>
          ))}
          <button
            onClick={() => void scanWorkspace()}
            disabled={scanning}
            title={t('homeRescan')}
            className="ml-1 p-0.5 rounded hover:text-[var(--accent)] transition-colors disabled:opacity-50 shrink-0"
          >
            <FiRefreshCw size={10} className={scanning ? 'animate-spin' : ''} />
          </button>
        </div>
      )}

      <ProjectBriefComposer />

      {/* ---- One click to start: local tasks + scripts, no tokens ---- */}
      {rootPath && (localTasks.length > 0 || (scan && scan.scripts.length > 0) || (scanning && !scan)) && (
        <section className="mb-5 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate mb-3">{t('homeQuickTasks')}</h2>
          {scanning && !scan ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {[0, 1].map((i) => <SkeletonCard key={i} />)}
            </div>
          ) : (
            <>
              {localTasks.length > 0 && (
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5 mb-2.5">
                  {localTasks.map((task) => <TaskCard key={task.id} task={task} onStart={() => start(task.prompt)} t={t} />)}
                </div>
              )}
              {scan && scan.scripts.length > 0 && (
                <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] divide-y divide-[var(--border)] overflow-hidden">
                  {scan.scripts.map((s) => (
                    <ScriptRow key={s} name={s} rootPath={scan.rootPath} t={t} />
                  ))}
                </div>
              )}
            </>
          )}
        </section>
      )}

      {/* ---- The main event: work the agent found ---- */}
      <section className="mb-5 min-w-0">
        <div className="flex items-center gap-2 mb-3 min-w-0">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] truncate">{t('homeFindWork')}</h2>
          {generatedAt && !busy && (
            <span className="text-[11px] text-[var(--text-muted)] shrink-0">{timeAgo(generatedAt, t)}</span>
          )}
          <button
            onClick={() => model && findWork(model.providerId, model.id, true)}
            disabled={!rootPath || !model || busy}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-[var(--bg-3)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 disabled:hover:border-[var(--border)] shrink-0"
          >
            <FiRefreshCw size={11} className={busy ? 'animate-spin' : ''} />
            {tasks.length ? t('homeRefindWork') : t('homeFindWorkAction')}
          </button>
        </div>

        {!rootPath ? (
          <EmptyCard
            icon={<FiFolder size={18} />}
            body={t('homeOpenFolderBody')}
            action={{ label: t('openFolder'), onClick: openFolder }}
          />
        ) : showSkeletons ? (
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
          </div>
        ) : tasks.length ? (
          <>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
              {(showAllTasks ? tasks : tasks.slice(0, 4)).map((task) => (
                <TaskCard key={task.id} task={task} onStart={() => start(task.prompt)} t={t} />
              ))}
            </div>
            {tasks.length > 4 && (
              <button
                onClick={() => setShowAllTasks((v) => !v)}
                className="mt-2 text-[12px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
              >
                {showAllTasks ? t('homeShowLess') : `${t('homeShowMore')} (${tasks.length - 4})`}
              </button>
            )}
          </>
        ) : (
          <EmptyCard
            icon={<FiZap size={18} />}
            title={error && error !== 'empty' ? t('homeFindFailed') : t('homeIdleTitle')}
            body={error && error !== 'empty' ? error : t('homeIdleBody')}
            action={model ? { label: t('homeFindWorkAction'), onClick: () => findWork(model.providerId, model.id, true) } : undefined}
          />
        )}
      </section>

      {/* ---- Start something new: pick one, it builds itself ---- */}
      <section id="conecode-new-project" className="min-w-0">
        <ProjectIdeas />
      </section>

      {!model && (
        <p className="mt-5 text-xs text-[var(--text-muted)] text-center">{t('selectModelHint')}</p>
      )}
    </div>
  );
}

function TaskCard({ task, onStart, t }: { task: SuggestedTask; onStart: () => void; t: (k: string) => string }) {
  const style = KIND_STYLE[task.kind] || KIND_STYLE.chore;
  return (
    <button
      onClick={onStart}
      className="group text-left rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-3 hover:border-[var(--accent)] hover:bg-[var(--bg-3)]/40 transition-all flex flex-col gap-1.5 min-h-[112px] min-w-0 overflow-hidden"
    >
      <div className="flex items-start gap-2 min-w-0">
        <span className={`shrink-0 w-6 h-6 rounded-lg flex items-center justify-center ${style.bg} ${style.color}`}>
          {style.icon}
        </span>
        <span className="text-sm font-medium text-[var(--text-primary)] leading-snug flex-1 min-w-0 break-words">{task.title}</span>
        <FiArrowRight size={13} className="shrink-0 mt-1 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--accent)] transition-all" />
      </div>

      {task.rationale && (
        <p className="text-xs text-[var(--text-muted)] leading-relaxed line-clamp-2">{task.rationale}</p>
      )}

      <div className="mt-auto flex items-center gap-2 text-[11px] text-[var(--text-muted)]">
        <span className={`px-1.5 py-0.5 rounded font-medium ${style.bg} ${style.color}`}>{t(`taskKind_${task.kind}`)}</span>
        {/* Effort as dots reads faster than a word at this size. */}
        <span className="inline-flex items-center gap-0.5" title={t(`taskEffort_${task.effort}`)}>
          {[1, 2, 3].map((n) => (
            <span key={n} className={`w-1.5 h-1.5 rounded-full ${n <= EFFORT_DOTS[task.effort] ? 'bg-[var(--text-secondary)]' : 'bg-[var(--border)]'}`} />
          ))}
        </span>
        {task.risk !== 'low' && (
          <span className={task.risk === 'high' ? 'text-[var(--error)]' : 'text-[var(--warning)]'}>
            {t(`taskRisk_${task.risk}`)}
          </span>
        )}
        {task.files.length > 0 && (
          <span className="ml-auto truncate font-mono max-w-[55%]" title={task.files.join(', ')}>
            {task.files.map((f) => f.split('/').pop()).join(', ')}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * One npm script as one click: runs it in the project root via exec and shows
 * the tail inline. Finite commands (test/lint/build) belong here; a `dev`
 * server gets killed by the exec timeout with an explanatory note, by design.
 */
function ScriptRow({ name, rootPath, t }: { name: string; rootPath: string; t: (k: string) => string }) {
  const [run, setRun] = useState<{ state: 'idle' } | { state: 'running' } | { state: 'done'; ok: boolean; output: string }>(
    { state: 'idle' },
  );

  const start = async () => {
    if (run.state === 'running') return;
    setRun({ state: 'running' });
    try {
      const res = await (window as any).electronAPI?.exec?.run?.(`npm run "${name}"`, rootPath);
      const text = `${res?.stdout || ''}\n${res?.stderr || ''}`.trim().split('\n').slice(-20).join('\n');
      setRun({ state: 'done', ok: !!res?.success, output: text || `(exit ${res?.exitCode ?? '?'})` });
    } catch (e: any) {
      setRun({ state: 'done', ok: false, output: e?.message || String(e) });
    }
  };

  return (
    <div className="px-4 py-2.5 min-w-0">
      <div className="flex items-center gap-2 min-w-0">
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${
          run.state === 'done' ? (run.ok ? 'bg-[var(--success)]' : 'bg-[var(--error)]') : 'bg-[var(--border)]'
        }`} />
        <code className="flex-1 min-w-0 truncate text-xs text-[var(--text-secondary)]">npm run {name}</code>
        {run.state === 'done' && (
          <span className={`text-[11px] shrink-0 ${run.ok ? 'text-[var(--success)]' : 'text-[var(--error)]'}`}>
            {run.ok ? t('homePassed') : t('homeFailed')}
          </span>
        )}
        <button
          onClick={() => void start()}
          disabled={run.state === 'running'}
          className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-lg text-[11px] font-medium bg-[var(--bg-3)] text-[var(--text-secondary)] hover:text-[var(--accent)] hover:border-[var(--accent)] border border-transparent transition-colors disabled:opacity-50"
        >
          <FiPlay size={10} className={run.state === 'running' ? 'animate-pulse' : ''} />
          {run.state === 'running' ? t('homeRunning') : t('homeRun')}
        </button>
      </div>
      {run.state === 'done' && run.output && (
        <pre className="mt-1.5 max-h-40 overflow-auto rounded-lg bg-[var(--bg-1)] p-2 text-[11px] leading-relaxed text-[var(--text-secondary)] whitespace-pre-wrap break-words">
          {run.output}
        </pre>
      )}
    </div>
  );
}

function SkeletonCard() {  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-3 anim-shimmer">
      <div className="flex items-center gap-2">
        <div className="w-6 h-6 rounded-lg bg-[var(--bg-3)]" />
        <div className="h-3 rounded bg-[var(--bg-3)] flex-1" />
      </div>
      <div className="mt-2.5 h-2.5 rounded bg-[var(--bg-3)] w-full" />
      <div className="mt-1.5 h-2.5 rounded bg-[var(--bg-3)] w-2/3" />
      <div className="mt-3 h-2 rounded bg-[var(--bg-3)] w-1/3" />
    </div>
  );
}

function EmptyCard({
  icon, title, body, action,
}: {
  icon: JSX.Element; title?: string; body: string; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-2)]/50 p-4 flex flex-col items-center text-center gap-1.5">
      <span className="text-[var(--text-muted)]">{icon}</span>
      {title && <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>}
      <p className="text-xs text-[var(--text-muted)] max-w-md leading-relaxed">{body}</p>
      {action && (
        <button onClick={action.onClick}
          className="mt-1 inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)]">
          {action.label}
        </button>
      )}
    </div>
  );
}
