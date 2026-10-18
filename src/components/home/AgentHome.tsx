import { useEffect, useMemo, useState } from 'react';
import {
  FiRefreshCw, FiFolder, FiGitBranch, FiArrowRight, FiZap,
  FiAlertCircle, FiTool, FiFileText, FiCheckSquare, FiPackage,
} from 'react-icons/fi';
import {
  useAgendaStore, useChatStore, useLanguageStore, useModelStore, useWorkspaceStore,
} from '../../stores';
import { type SuggestedTask, type TaskKind } from '../../core/agenda/agenda';
import AppIcon from '../common/AppIcon';
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
  const { t, locale } = useLanguageStore();
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
  }, [scan, t, locale]);

  // Facts are free, so scan as soon as a folder is open; suggestions cost tokens
  // and stay on an explicit click (or a warm cache).
  useEffect(() => {
    if (!rootPath) return;
    loadCached(locale);
    void scanWorkspace();
  }, [rootPath, locale, scanWorkspace, loadCached]);

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

  const [homeTab, setHomeTab] = useState<'tasks' | 'ideas' | 'brief'>(rootPath ? 'tasks' : 'ideas');

  useEffect(() => {
    if (rootPath) setHomeTab('tasks');
    else setHomeTab('ideas');
  }, [rootPath]);

  const h = new Date().getHours();
  const greetingText =
    h >= 5 && h < 12 ? t('homeGreetingMorning') :
    h >= 12 && h < 18 ? t('homeGreetingAfternoon') :
    h >= 18 && h < 23 ? t('homeGreetingEvening') :
    t('homeGreetingNight');

  return (
    <div className="max-w-[860px] mx-auto w-full pt-2 pb-6 min-w-0">
      {/* ---- Hero Greeting Banner with ConeCode Original Icon ---- */}
      <div className="pt-2 pb-4 flex items-center gap-3.5">
        <div className="w-11 h-11 rounded-2xl flex items-center justify-center border border-[var(--accent)]/20 shadow-xs shrink-0 overflow-hidden">
          <AppIcon size={44} className="w-full h-full object-cover" />
        </div>
        <div className="min-w-0 flex-1">
          <h1 className="text-2xl sm:text-3xl font-serif font-bold text-[var(--text-primary)] tracking-tight truncate">
            {greetingText}
          </h1>
          <p className="text-[13px] text-[var(--text-muted)] mt-0.5 truncate">
            {t('homeGreetingSubtitle')}
          </p>
        </div>
      </div>

      {/* ---- Streamlined Workspace Status Pill ---- */}
      {rootPath && (
        <div className="flex items-center gap-2 mb-4 px-3 py-1.5 rounded-xl bg-[var(--glass-card)] backdrop-blur-md border border-[var(--glass-border)] text-xs text-[var(--text-muted)] flex-wrap shadow-2xs">
          <span className="inline-flex items-center gap-1.5 font-bold text-[var(--text-primary)] font-serif text-[13px]">
            <FiFolder size={12} className="text-[var(--accent)]" />
            {scan?.projectName || rootPath.split('/').pop()}
          </span>
          {scan?.git.isRepo && scan.git.branch && (
            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-md bg-[var(--accent-soft)] text-[var(--accent)] font-semibold text-[11px]">
              <FiGitBranch size={10} />{scan.git.branch}
            </span>
          )}
          {scan?.fileCount ? (
            <span className="text-[11px] text-[var(--text-muted)]">
              {scan.fileCount}{scan.fileCountCapped ? '+' : ''} {t('homeFiles')}
            </span>
          ) : null}
          {scan?.git.dirty ? (
            <span className="text-[11px] text-[var(--warning)] font-medium">
              · {scan.git.dirty} {t('homeUncommitted')}
            </span>
          ) : scan?.git.isRepo ? (
            <span className="text-[11px] text-[var(--success)] font-medium">
              · {t('homeClean')}
            </span>
          ) : null}
          <button
            onClick={() => void scanWorkspace()}
            disabled={scanning}
            title={t('homeRescan')}
            className="ml-auto p-1 rounded-lg hover:text-[var(--accent)] hover:bg-[var(--bg-3)] transition-colors disabled:opacity-50 shrink-0"
          >
            <FiRefreshCw size={11} className={scanning ? 'animate-spin' : ''} />
          </button>
        </div>
      )}

      {/* ---- Clean Navigation Tabs (Eliminates Text Stacking) ---- */}
      <div className="flex items-center justify-between gap-3 mb-4 border-b border-[var(--glass-border)] pb-3">
        <div className="inline-flex p-1 bg-[var(--glass-card)] border border-[var(--glass-border)] rounded-2xl gap-1 shadow-2xs">
          <button
            type="button"
            onClick={() => setHomeTab('tasks')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
              homeTab === 'tasks'
                ? 'bg-[var(--glass-surface)] text-[var(--accent)] font-bold shadow-xs border border-[var(--glass-border)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)]/40 border border-transparent'
            }`}
          >
            <FiZap size={13} className={homeTab === 'tasks' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
            <span>{t('tabRecommendedTasks')}</span>
            {tasks.length > 0 && (
              <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-semibold">
                {tasks.length}
              </span>
            )}
          </button>
          <button
            type="button"
            onClick={() => setHomeTab('ideas')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
              homeTab === 'ideas'
                ? 'bg-[var(--glass-surface)] text-[var(--accent)] font-bold shadow-xs border border-[var(--glass-border)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)]/40 border border-transparent'
            }`}
          >
            <FiPackage size={13} className={homeTab === 'ideas' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
            <span>{t('tabProjectIdeas')}</span>
          </button>
          <button
            type="button"
            onClick={() => setHomeTab('brief')}
            className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
              homeTab === 'brief'
                ? 'bg-[var(--glass-surface)] text-[var(--accent)] font-bold shadow-xs border border-[var(--glass-border)]'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)]/40 border border-transparent'
            }`}
          >
            <FiFileText size={13} className={homeTab === 'brief' ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'} />
            <span>{t('tabRequirementBrief')}</span>
          </button>
        </div>

        {homeTab === 'tasks' && rootPath && (
          <button
            onClick={() => model && findWork(model.providerId, model.id, true, locale)}
            disabled={busy}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium bg-[var(--glass-card)] text-[var(--text-secondary)] border border-[var(--glass-border)] hover:border-[var(--accent)] hover:text-[var(--accent)] backdrop-blur-md transition-all shadow-2xs disabled:opacity-40 shrink-0"
          >
            <FiRefreshCw size={11} className={busy ? 'animate-spin' : ''} />
            {tasks.length ? t('homeRefindWork') : t('homeFindWorkAction')}
          </button>
        )}
      </div>

      {/* ---- Tab 1: Recommended Tasks ---- */}
      {homeTab === 'tasks' && (
        <section className="min-w-0 anim-message">
          {!rootPath ? (
            <EmptyCard
              icon={<FiFolder size={18} />}
              body={t('homeOpenFolderBody')}
              action={{ label: t('openFolder'), onClick: openFolder }}
            />
          ) : showSkeletons ? (
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
            </div>
          ) : tasks.length ? (
            <>
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {(showAllTasks ? tasks : tasks.slice(0, 4)).map((task) => (
                  <TaskCard key={task.id} task={task} onStart={() => start(task.prompt)} t={t} />
                ))}
              </div>
              {tasks.length > 4 && (
                <button
                  onClick={() => setShowAllTasks((v) => !v)}
                  className="mt-2 text-[12px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors font-medium"
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
              action={model ? { label: t('homeFindWorkAction'), onClick: () => findWork(model.providerId, model.id, true, locale) } : undefined}
            />
          )}
        </section>
      )}

      {/* ---- Tab 2: Project Ideas ---- */}
      {homeTab === 'ideas' && (
        <section className="min-w-0 anim-message">
          <ProjectIdeas />
        </section>
      )}

      {/* ---- Tab 3: Project Brief Composer ---- */}
      {homeTab === 'brief' && (
        <section className="min-w-0 anim-message">
          <ProjectBriefComposer />
        </section>
      )}

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
      className="group text-left rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-card)]/80 hover:bg-[var(--glass-surface)] backdrop-blur-xl p-4 hover:border-[var(--accent)]/50 hover:shadow-[0_8px_24px_rgba(201,100,66,0.08)] hover:-translate-y-0.5 transition-all flex flex-col gap-2 min-h-[110px] min-w-0 overflow-hidden shadow-2xs cursor-pointer"
    >
      <div className="flex items-start gap-2.5 min-w-0">
        <span className={`shrink-0 w-6 h-6 rounded-lg flex items-center justify-center ${style.bg} ${style.color}`}>
          {style.icon}
        </span>
        <span className="text-[15px] font-bold text-[var(--text-primary)] font-serif leading-snug flex-1 min-w-0 truncate">{task.title}</span>
        <FiArrowRight size={13} className="shrink-0 mt-0.5 text-[var(--text-muted)] opacity-0 group-hover:opacity-100 group-hover:text-[var(--accent)] transition-all" />
      </div>

      {task.rationale && (
        <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed line-clamp-2">{task.rationale}</p>
      )}

      <div className="mt-auto flex items-center gap-2 text-[11px] text-[var(--text-muted)] pt-1">
        <span className={`px-2 py-0.5 rounded-md font-medium text-[11px] ${style.bg} ${style.color}`}>{t(`taskKind_${task.kind}`)}</span>
        {task.files.length > 0 && (
          <span className="ml-auto truncate font-mono text-[11px] text-[var(--text-muted)] opacity-70 max-w-[65%]" title={task.files.join(', ')}>
            {task.files.map((f) => f.split('/').pop()).join(', ')}
          </span>
        )}
      </div>
    </button>
  );
}

/**
 * Skeleton while suggestions load.
 */
function SkeletonCard() {  return (
    <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-card)] backdrop-blur-md p-3.5 anim-shimmer shadow-2xs">
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
    <div className="rounded-2xl border border-dashed border-[var(--glass-border)] bg-[var(--glass-card)]/60 backdrop-blur-md p-5 flex flex-col items-center text-center gap-2 shadow-2xs">
      <span className="text-[var(--text-muted)]">{icon}</span>
      {title && <div className="text-[15.5px] font-bold text-[var(--text-primary)] font-serif tracking-tight">{title}</div>}
      <p className="text-xs text-[var(--text-muted)] max-w-md leading-relaxed">{body}</p>
      {action && (
        <button onClick={action.onClick}
          className="mt-1 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] shadow-xs transition-colors">
          {action.label}
        </button>
      )}
    </div>
  );
}
