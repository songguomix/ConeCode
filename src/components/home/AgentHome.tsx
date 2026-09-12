import { useEffect, useMemo, useRef } from 'react';
import {
  FiRefreshCw, FiFolder, FiPlus, FiGitBranch, FiClock, FiArrowRight, FiZap,
  FiAlertCircle, FiTool, FiFileText, FiCheckSquare, FiPackage,
  FiPlay,
} from 'react-icons/fi';
import {
  useAgendaStore, useChatStore, useLanguageStore, useModelStore, useWorkspaceStore,
} from '../../stores';
import { buildResumePrompt, recommendNext, type SuggestedTask, type TaskKind } from '../../core/agenda/agenda';
import AppIcon from '../common/AppIcon';
import ProjectIdeas from './ProjectIdeas';
import ProjectBriefComposer from './ProjectBriefComposer';
import NextActionDialog from './NextActionDialog';

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
 * scan, unfinished conversations to resume, or a new project to scaffold.
 */
export default function AgentHome() {
  const { t } = useLanguageStore();
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const setActiveConversation = useChatStore((s) => s.setActiveConversation);
  const conversations = useChatStore((s) => s.conversations);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const model = getSelectedModel();

  const scan = useAgendaStore((s) => s.scan);
  const tasks = useAgendaStore((s) => s.tasks);
  const scanning = useAgendaStore((s) => s.scanning);
  const suggesting = useAgendaStore((s) => s.suggesting);
  const error = useAgendaStore((s) => s.error);
  const generatedAt = useAgendaStore((s) => s.generatedAt);
  const resume = useAgendaStore((s) => s.resume);
  const findWork = useAgendaStore((s) => s.findWork);
  const loadCached = useAgendaStore((s) => s.loadCached);
  const scanWorkspace = useAgendaStore((s) => s.scanWorkspace);
  const loadResume = useAgendaStore((s) => s.loadResume);


  // The greeting follows the clock rather than being one fixed line.
  const greetingKey = useMemo(() => {
    const hour = new Date().getHours();
    if (hour < 5) return 'homeGreetingNight';
    if (hour < 12) return 'homeGreetingMorning';
    if (hour < 18) return 'homeGreetingAfternoon';
    return 'homeGreetingEvening';
  }, []);

  /**
   * The status line is built from what the scan found, so it varies with the
   * project instead of being a fixed row of slots: a clean repo with tests shows
   * a different set of facts than a dirty one with none.
   */
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
  useEffect(() => { void loadResume(); }, [conversations, loadResume]);

  const start = async (prompt: string) => {
    if (!model) return;
    await sendMessage(prompt, model.providerId, model.id);
  };

  const resumeWork = async (candidate: (typeof resume)[number]) => {
    await setActiveConversation(candidate.conversationId);
    if (!model) return;
    await sendMessage(buildResumePrompt(candidate), model.providerId, model.id);
  };

  // The screen makes the call; the user only has to agree — or rewrite it in the dialog.
  const recommendation = useMemo(() => recommendNext({
    hasFolder: !!rootPath,
    dirty: scan?.git.dirty ?? 0,
    hasTests: scan?.hasTests ?? true,
    openTodos: resume.reduce((n, r) => n + r.openTodos.length, 0),
    topTask: tasks[0]?.title,
  }), [rootPath, scan, resume, tasks]);

  const ideasSectionRef = useRef<HTMLElement>(null);
  const scrollToIdeas = () => {
    ideasSectionRef.current?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    document.getElementById('conecode-project-idea')?.focus({ preventScroll: true });
  };

  const busy = scanning || suggesting;
  // Skeletons stand in for tasks being fetched — NOT for the free re-scan of
  // local facts, which must not blank out proposals the user is reading.
  const showSkeletons = suggesting || (scanning && tasks.length === 0);

  return (
    <div className="max-w-[900px] mx-auto w-full py-4">
      {/* ---- Header: who you are, where you are ---- */}
      <div className="flex items-start gap-3 mb-6">
        <AppIcon size={40} className="rounded-xl" />
        <div className="min-w-0 flex-1">
          <h1 className="text-xl font-semibold text-[var(--text-primary)] leading-tight">
            {t(greetingKey)}
          </h1>
          <div className="mt-1 flex items-center gap-1.5 flex-wrap text-xs text-[var(--text-muted)]">
            {rootPath ? (
              <>
                <span className="font-medium text-[var(--text-secondary)]">
                  {scan?.projectName || rootPath.split('/').pop()}
                </span>
                {scan?.git.isRepo && scan.git.branch && (
                  <span className="inline-flex items-center gap-1">
                    <FiGitBranch size={11} />{scan.git.branch}
                  </span>
                )}
                {/* Whatever the scan actually found, in whatever combination —
                    nothing here is a fixed slot. */}
                {facts.map((fact, i) => (
                  <span key={i} className={fact.warn ? 'text-[var(--warning)]' : undefined}>
                    · {fact.text}
                  </span>
                ))}
                <button
                  onClick={() => void scanWorkspace()}
                  disabled={scanning}
                  title={t('homeRescan')}
                  className="ml-1 p-0.5 rounded hover:text-[var(--accent)] transition-colors disabled:opacity-50"
                >
                  <FiRefreshCw size={10} className={scanning ? 'animate-spin' : ''} />
                </button>
              </>
            ) : (
              <span>{t('homeNoFolder')}</span>
            )}
          </div>
        </div>
      </div>

      <ProjectBriefComposer />

      {/* ---- The call: one recommended next action, as a real dialog ---- */}
      <NextActionDialog
        recommendation={recommendation}
        tasks={tasks}
        resume={resume}
        hasFolder={!!rootPath}
        onSend={start}
        onOpenFolder={() => void openFolder()}
        onScrollToIdeas={scrollToIdeas}
      />

      {/* ---- The main event: work the agent found ---- */}
      <section className="mb-6">
        <div className="flex items-center gap-2 mb-2.5">
          <h2 className="text-sm font-semibold text-[var(--text-primary)]">{t('homeFindWork')}</h2>
          {generatedAt && !busy && (
            <span className="text-[11px] text-[var(--text-muted)]">{timeAgo(generatedAt, t)}</span>
          )}
          <button
            onClick={() => model && findWork(model.providerId, model.id, true)}
            disabled={!rootPath || !model || busy}
            className="ml-auto inline-flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs font-medium bg-[var(--bg-3)] text-[var(--text-secondary)] border border-[var(--border)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors disabled:opacity-40 disabled:hover:border-[var(--border)]"
          >
            <FiRefreshCw size={11} className={busy ? 'animate-spin' : ''} />
            {tasks.length ? t('homeRefindWork') : t('homeFindWorkAction')}
          </button>
        </div>

        {!rootPath ? (
          <EmptyCard
            icon={<FiFolder size={18} />}
            title={t('homeOpenFolderTitle')}
            body={t('homeOpenFolderBody')}
            action={{ label: t('openFolder'), onClick: openFolder }}
          />
        ) : showSkeletons ? (
          <div className="grid grid-cols-2 gap-2.5">
            {[0, 1, 2, 3].map((i) => <SkeletonCard key={i} />)}
          </div>
        ) : tasks.length ? (
          <div className="grid grid-cols-2 gap-2.5">
            {tasks.map((task) => <TaskCard key={task.id} task={task} onStart={() => start(task.prompt)} t={t} />)}
          </div>
        ) : (
          <EmptyCard
            icon={<FiZap size={18} />}
            title={error && error !== 'empty' ? t('homeFindFailed') : t('homeIdleTitle')}
            body={error && error !== 'empty' ? error : t('homeIdleBody')}
            action={model ? { label: t('homeFindWorkAction'), onClick: () => findWork(model.providerId, model.id, true) } : undefined}
          />
        )}
      </section>

      {/* ---- Pick up yesterday's thread ---- */}
      {resume.length > 0 && (
        <section className="mb-6">
          <h2 className="text-sm font-semibold text-[var(--text-primary)] mb-2.5">{t('homeResume')}</h2>
          <div className="space-y-2">
            {resume.map((r) => (
              <div key={r.conversationId}
                className="group rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-3 hover:border-[var(--accent)]/50 transition-colors">
                <div className="flex items-start gap-3">
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center gap-2">
                      <span className="text-sm font-medium text-[var(--text-primary)] truncate">{r.title}</span>
                      <span className="shrink-0 text-[11px] text-[var(--text-muted)] inline-flex items-center gap-1">
                        <FiClock size={10} />{timeAgo(r.updatedAt, t)}
                      </span>
                    </div>
                    {r.lastMessage && (
                      <p className="mt-1 text-xs text-[var(--text-muted)] line-clamp-2">{r.lastMessage}</p>
                    )}
                    <div className="mt-1.5 flex items-center gap-2 flex-wrap text-[11px]">
                      {r.rootPath && (
                        <span className="text-[var(--text-muted)] inline-flex items-center gap-1">
                          <FiFolder size={10} />{r.rootPath.split('/').pop()}
                        </span>
                      )}
                      {r.openTodos.length > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)] font-medium">
                          {r.openTodos.length} {t('homeOpenTodos')}
                        </span>
                      )}
                      {r.pendingChanges > 0 && (
                        <span className="px-1.5 py-0.5 rounded bg-[var(--warning)]/15 text-[var(--warning)] font-medium">
                          {r.pendingChanges} {t('pending')}
                        </span>
                      )}
                    </div>
                    {r.openTodos.length > 0 && (
                      <ul className="mt-1.5 space-y-0.5">
                        {r.openTodos.slice(0, 3).map((todo, i) => (
                          <li key={i} className="text-[11px] text-[var(--text-secondary)] flex items-start gap-1.5">
                            <span className="mt-1 w-1 h-1 rounded-full bg-[var(--text-muted)] shrink-0" />
                            <span className="truncate">{todo}</span>
                          </li>
                        ))}
                      </ul>
                    )}
                  </div>
                  <div className="flex flex-col gap-1.5 shrink-0">
                    <button onClick={() => resumeWork(r)} disabled={!model}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] disabled:opacity-40">
                      <FiPlay size={11} /> {t('homeContinue')}
                    </button>
                    <button onClick={() => setActiveConversation(r.conversationId)}
                      className="inline-flex items-center gap-1 px-2.5 py-1.5 rounded-lg bg-[var(--bg-3)] text-[var(--text-secondary)] text-xs hover:bg-[var(--bg-4)]">
                      {t('homeOpenOnly')}
                    </button>
                  </div>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      {/* ---- Start something new: pick one, it builds itself ---- */}
      <section id="conecode-new-project" ref={ideasSectionRef}>
        <ProjectIdeas />
        <div className="mt-2.5 grid grid-cols-2 gap-2.5">
          <QuickAction icon={<FiPlus size={15} />} label={t('homeNewProject')} desc={t('homeNewProjectDesc')}
            onClick={() => {
              document.getElementById('conecode-project-idea')?.scrollIntoView({ behavior: 'smooth', block: 'center' });
              document.getElementById('conecode-project-idea')?.focus({ preventScroll: true });
            }} />
          <QuickAction icon={<FiFolder size={15} />} label={t('openFolder')} desc={t('homeOpenFolderDesc')} onClick={openFolder} />
        </div>
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
      className="group text-left rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-3 hover:border-[var(--accent)] hover:bg-[var(--bg-3)]/40 transition-all flex flex-col gap-2"
    >
      <div className="flex items-start gap-2">
        <span className={`shrink-0 w-6 h-6 rounded-lg flex items-center justify-center ${style.bg} ${style.color}`}>
          {style.icon}
        </span>
        <span className="text-sm font-medium text-[var(--text-primary)] leading-snug flex-1">{task.title}</span>
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

function QuickAction({
  icon, label, desc, onClick, disabled, accent,
}: {
  icon: JSX.Element; label: string; desc: string; onClick: () => void; disabled?: boolean; accent?: boolean;
}) {
  return (
    <button onClick={onClick} disabled={disabled}
      className={`text-left rounded-xl border p-3 transition-all disabled:opacity-40 ${
        accent
          ? 'border-[var(--accent)]/40 bg-[var(--accent-soft)] hover:border-[var(--accent)]'
          : 'border-[var(--border)] bg-[var(--bg-2)] hover:border-[var(--accent)]/50'
      }`}>
      <div className="flex items-center gap-2">
        <span className={accent ? 'text-[var(--accent)]' : 'text-[var(--text-secondary)]'}>{icon}</span>
        <span className="text-sm font-medium text-[var(--text-primary)]">{label}</span>
      </div>
      <p className="mt-1 text-xs text-[var(--text-muted)]">{desc}</p>
    </button>
  );
}

function SkeletonCard() {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-3 animate-pulse">
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
  icon: JSX.Element; title: string; body: string; action?: { label: string; onClick: () => void };
}) {
  return (
    <div className="rounded-xl border border-dashed border-[var(--border)] bg-[var(--bg-2)]/50 p-5 flex flex-col items-center text-center gap-2">
      <span className="text-[var(--text-muted)]">{icon}</span>
      <div className="text-sm font-medium text-[var(--text-primary)]">{title}</div>
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
