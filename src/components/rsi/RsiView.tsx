import { useEffect, useState, useMemo, useRef } from 'react';
import {
  FiZap,
  FiSquare,
  FiArrowLeft,
  FiRefreshCw,
  FiCheck,
  FiAlertTriangle,
  FiActivity,
  FiLayers,
  FiCpu,
  FiMonitor,
  FiEye,
  FiChevronDown,
  FiChevronUp,
  FiTerminal,
  FiSliders,
  FiGitBranch,
  FiX,
  FiSearch,
} from 'react-icons/fi';
import { useChatStore } from '../../stores/chat.store';
import { useComputerStore } from '../../stores/computer.store';
import { useLanguageStore } from '../../stores/language.store';
import { useModelStore } from '../../stores/model.store';
import { useProviderStore } from '../../stores/provider.store';
import { usePluginStore } from '../../stores/plugin.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useCodeChangesStore } from '../../stores/codeChanges.store';
import CommandApprovalCard from '../chat/CommandApprovalCard';
import QuestionPromptCard from '../chat/QuestionPromptCard';
import { commandsForConversation } from '../chat/approvalPresentation';
import { useUIStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import SyncView from '../plugins/SyncView';
import { rsiCanStart } from '../../core/agents/rsiStart';
import { bootstrapRsiWorkspace, electronAsyncFs } from '../../core/agents/rsiBridge';

/** Helper to infer active phase number (1..5) from text content. */
function detectActivePhase(text: string): number {
  if (!text) return 1;
  const lower = text.toLowerCase();
  if (
    lower.includes('递归迭代') ||
    lower.includes('recursive') ||
    lower.includes('iteration') ||
    lower.includes('see the main interface') ||
    lower.includes('screenshot') ||
    lower.includes('视觉验收') ||
    lower.includes('computer-use 验收') ||
    lower.includes('visual acceptance') ||
    lower.includes('phase g') ||
    lower.includes('phase h') ||
    lower.includes('dream') ||
    lower.includes('loop or stop')
  ) {
    return 5;
  }
  if (
    lower.includes('验证改进') ||
    lower.includes('verify') ||
    lower.includes('phase e') ||
    lower.includes('cascade') ||
    lower.includes('typecheck') ||
    lower.includes('targeted') ||
    lower.includes('perf_snapshot') ||
    lower.includes('性能巡检') ||
    lower.includes('级联检验') ||
    lower.includes('score & select') ||
    lower.includes('phase f') ||
    lower.includes('reward') ||
    lower.includes('accept') ||
    lower.includes('reject') ||
    lower.includes('强化评估') ||
    lower.includes('评审')
  ) {
    return 4;
  }
  if (
    lower.includes('提出改进') ||
    lower.includes('sample') ||
    lower.includes('declare') ||
    lower.includes('phase b') ||
    lower.includes('phase c') ||
    lower.includes('phase d') ||
    lower.includes('execute') ||
    lower.includes('blastradius') ||
    lower.includes('变异') ||
    lower.includes('采样')
  ) {
    return 3;
  }
  if (
    lower.includes('评估结果') ||
    lower.includes('assess') ||
    lower.includes('phase a') ||
    lower.includes('baseline') ||
    lower.includes('基线') ||
    lower.includes('瓶颈') ||
    lower.includes('缺陷')
  ) {
    return 2;
  }
  if (
    lower.includes('执行任务') ||
    lower.includes('discover') ||
    lower.includes('phase 0') ||
    lower.includes('breakthrough') ||
    lower.includes('突破口') ||
    lower.includes('探索')
  ) {
    return 1;
  }
  return 1;
}

/** Formats seconds into mm:ss or hh:mm:ss. */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/**
 * RSI Autopilot Dashboard
 *
 * Owns the center column while agentMode is 'rsi'. Provides high-density status,
 * preflight diagnostics, visual pipeline progression, real-time activity stream,
 * and plugin extensions while hiding conversational chat clutter.
 */
export default function RsiView() {
  const { t } = useLanguageStore();
  const setAgentMode = useChatStore((s) => s.setAgentMode);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const continuableConvId = useChatStore((s) => s.continuableConvId);
  const continueGeneration = useChatStore((s) => s.continueGeneration);
  const chatError = useChatStore((s) => s.error);
  const clearChatError = useChatStore((s) => s.clearError);
  const activeConversationId = useChatStore((s) => s.activeConversationId);  const streamingRuns = useChatStore((s) => s.streamingRuns);
  const rawMessages = useChatStore((s) => s.messages);

  const modelsMap = useModelStore((s) => s.models);
  const selectModel = useModelStore((s) => s.selectModel);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const providers = useProviderStore((s) => s.providers);
  const toggleSettings = useUIStore((s) => s.toggleSettings);

  const refresh = useComputerStore((s) => s.refresh);
  const setComputerEnabled = useComputerStore((s) => s.setEnabled);
  const requestPermissions = useComputerStore((s) => s.requestPermissions);
  const screenRecording = useComputerStore((s) => s.screenRecording);
  const accessibility = useComputerStore((s) => s.accessibility);
  const platform = useComputerStore((s) => s.platform);

  const githubOn = usePluginStore((s) => !s.disabled.includes('github-sync'));
  const setPluginEnabled = usePluginStore((s) => s.setEnabled);

  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLogs, setShowLogs] = useState(true);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const model = getSelectedModel();
  const isMac = platform === 'darwin';
  const activeRun = activeConversationId ? streamingRuns[activeConversationId] : undefined;
  const running = !!activeRun;

  const canStart =
    !busy &&
    !running &&
    rsiCanStart({
      isMac,
      screenRecording,
      accessibility,
      hasModel: !!model,
    });

  // Track elapsed execution time during an active run
  useEffect(() => {
    if (!running) return;
    const interval = setInterval(() => {
      setElapsedSeconds((sec) => sec + 1);
    }, 1000);
    return () => clearInterval(interval);
  }, [running]);

  // Determine if this conversation has run RSI before
  const rsiRunStartIndex = useMemo(() => {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const m = rawMessages[i];
      if (
        m.role === 'user' &&
        (m.content.includes(t('rsiKickoff')) || m.content.toLowerCase().includes('rsi'))
      ) {
        return i;
      }
    }
    return -1;
  }, [rawMessages, t]);

  // Extract the latest assistant message from an RSI run
  const latestRsiAssistantMessage = useMemo(() => {
    if (rsiRunStartIndex === -1) return null;
    for (let i = rawMessages.length - 1; i > rsiRunStartIndex; i--) {
      if (rawMessages[i].role === 'assistant') {
        return rawMessages[i];
      }
    }
    return null;
  }, [rawMessages, rsiRunStartIndex]);

  // Determine current active telemetry text
  const currentSnippet =
    activeRun?.reasoningContent ||
    activeRun?.content ||
    latestRsiAssistantMessage?.content ||
    '';

  const activeStage = useMemo(() => {
    if (!running) return 0;
    return detectActivePhase(currentSnippet);
  }, [running, currentSnippet]);

  // Auto-scroll telemetry window when streaming updates
  useEffect(() => {
    if (running && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [running, activeRun?.content, activeRun?.reasoningContent]);

  // Flat & filtered list of all available models for the picker
  const allAvailableModels = useMemo(() => {
    const list: Array<{
      id: string;
      name: string;
      providerId: string;
      providerName: string;
    }> = [];

    for (const [providerId, modelList] of modelsMap.entries()) {
      const pName = providers.find((p) => p.id === providerId)?.name || providerId;
      for (const m of modelList) {
        if (
          !modelSearch ||
          m.name.toLowerCase().includes(modelSearch.toLowerCase()) ||
          m.id.toLowerCase().includes(modelSearch.toLowerCase()) ||
          pName.toLowerCase().includes(modelSearch.toLowerCase())
        ) {
          list.push({
            id: m.id,
            name: m.name,
            providerId,
            providerName: pName,
          });
        }
      }
    }
    return list;
  }, [modelsMap, providers, modelSearch]);

  // This conversation's pending command approvals (exec runs waiting for a
  // decision) and the latest unanswered model question. The RSI view hides the
  // chat transcript where these cards normally live — without them a run that
  // stops for approval looks like it "突然中断" with no way forward in place.
  const changes = useCodeChangesStore((s) => s.changes);
  const pendingCommands = useMemo(() => {
    const ids = new Set(rawMessages.map((m) => m.id));
    return commandsForConversation(changes, activeConversationId, ids)
      .filter((c) => c.status === 'pending');
  }, [changes, activeConversationId, rawMessages]);
  const pendingCommand = pendingCommands[0] ?? null;

  const latestQuestionMessage = useMemo(() => {
    const lastQuestionIndex = rawMessages.map((m) => !!m.isQuestion).lastIndexOf(true);
    if (lastQuestionIndex === -1) return null;
    const msg = rawMessages[lastQuestionIndex];
    const hasUserReply = rawMessages.slice(lastQuestionIndex + 1).some((m) => m.role === 'user' && !m.isToolResult);
    if (!hasUserReply) return msg;
    return null;
  }, [rawMessages]);

  const start = async () => {
    if (!model || busy || running) return;
    setBusy(true);
    setElapsedSeconds(0);
    // RSI always runs fully automatically, independent of Settings: a
    // session-only override (never persisted, never shown in Settings) drives
    // execution while the user's own approvalMode stays exactly as left.
    // The approval/question cards below remain as the visible safety net for
    // anything that still pauses (e.g. an ask_user question).
    try {
      await refresh();
      const st = useComputerStore.getState();
      const mac = st.platform === 'darwin';
      if (
        !rsiCanStart({
          isMac: mac,
          screenRecording: st.screenRecording,
          accessibility: st.accessibility,
          hasModel: true,
        })
      )
        return;
      await st.setEnabled(true);
      useSettingsStore.setState({ approvalOverride: 'fullAuto' });
      // A previous run may have died after persisting the kickoff (stream
      // failure, turn cap, app restart — all surfaced as continuable). Pressing
      // start again must CONTINUE that run, not stack a second kickoff onto
      // the transcript.
      if (continuableConvId && continuableConvId === activeConversationId) {
        await continueGeneration(continuableConvId);
        return;
      }
      // Program-side search state on real disk (STRATEGY.md default + resume
      // LOOP_STATE.json when a frozen goal exists). Best-effort: a bridge
      // failure must never block the agent run below.
      try {
        const afs = electronAsyncFs();
        const root = useWorkspaceStore.getState().rootPath;
        if (afs && root) await bootstrapRsiWorkspace(afs, root);
      } catch {
        /* offline bridge: the prompt-driven loop still proceeds */
      }
      await sendMessage(t('rsiKickoff'), model.providerId, model.id);
    } finally {
      useSettingsStore.setState({ approvalOverride: null });
      setBusy(false);
    }
  };

  const stop = () => {
    stopGeneration(activeConversationId ?? undefined);
    void setComputerEnabled(false);
  };

  const askScreen = async () => {
    setAsking(true);
    try {
      await (window as any).electronAPI?.computer?.screenshot?.();
    } catch {
      /* denial surfaces as needsPermission */
    }
    await refresh();
    setAsking(false);
  };

  // 5 Stages of RSI
  const stages = [
    {
      step: 1,
      title: t('rsiStage1'),
      desc: t('rsiStage1Desc'),
      icon: <FiZap size={15} />,
    },
    {
      step: 2,
      title: t('rsiStage2'),
      desc: t('rsiStage2Desc'),
      icon: <FiActivity size={15} />,
    },
    {
      step: 3,
      title: t('rsiStage3'),
      desc: t('rsiStage3Desc'),
      icon: <FiGitBranch size={15} />,
    },
    {
      step: 4,
      title: t('rsiStage4'),
      desc: t('rsiStage4Desc'),
      icon: <FiCheck size={15} />,
    },
    {
      step: 5,
      title: t('rsiStage5'),
      desc: t('rsiStage5Desc'),
      icon: <FiRefreshCw size={15} />,
    },
  ];

  return (
    <div className="flex-1 overflow-y-auto pt-2 pb-8 px-4 select-text">
      {/* Dedicated Model Selector Modal for RSI */}
      {modelPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-xs anim-fade"
          onClick={() => setModelPickerOpen(false)}
        >
          <div
            className="w-full max-w-md bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-xl overflow-hidden flex flex-col max-h-[80vh] anim-scale"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between">
              <div className="flex items-center gap-2">
                <FiCpu size={16} className="text-[var(--accent)]" />
                <h3 className="text-[14px] font-semibold text-[var(--text-primary)]">
                  {t('rsiModelChange')}
                </h3>
              </div>
              <button
                onClick={() => setModelPickerOpen(false)}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors"
              >
                <FiX size={16} />
              </button>
            </div>

            {/* Search Input */}
            <div className="p-3 border-b border-[var(--border)] bg-[var(--bg-1)]">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl">
                <FiSearch size={14} className="text-[var(--text-muted)] shrink-0" />
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder={t('searchModels') || '搜索模型…'}
                  className="w-full bg-transparent text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
                  autoFocus
                />
              </div>
            </div>

            {/* Model List */}
            <div className="flex-1 overflow-y-auto p-2 space-y-1">
              {allAvailableModels.length > 0 ? (
                allAvailableModels.map((m) => {
                  const isSelected = model?.id === m.id && model?.providerId === m.providerId;
                  return (
                    <button
                      key={`${m.providerId}-${m.id}`}
                      onClick={() => {
                        selectModel(m.id, m.providerId);
                        setModelPickerOpen(false);
                      }}
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-colors ${
                        isSelected
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)]'
                          : 'hover:bg-[var(--bg-3)] text-[var(--text-primary)]'
                      }`}
                    >
                      <div className="min-w-0 flex-1 pr-2">
                        <div className="text-[13px] font-medium truncate">{m.name}</div>
                        <div className="text-[11px] text-[var(--text-muted)] truncate">
                          {m.providerName}
                        </div>
                      </div>
                      {isSelected && <FiCheck size={16} className="text-[var(--accent)] shrink-0" />}
                    </button>
                  );
                })
              ) : (
                <div className="py-8 text-center text-[12.5px] text-[var(--text-muted)]">
                  {t('noResults') || '未找到匹配的模型'}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-[var(--border)] bg-[var(--bg-1)] flex items-center justify-between">
              <span className="text-[11.5px] text-[var(--text-muted)]">
                {providers.length} {t('providers') || '提供商'}
              </span>
              <button
                onClick={() => {
                  setModelPickerOpen(false);
                  toggleSettings();
                }}
                className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] hover:bg-[var(--bg-4)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
              >
                {t('settings') || '打开设置'}
              </button>
            </div>
          </div>
        </div>
      )}

      <div className="max-w-[760px] mx-auto w-full space-y-5">
        {/* Top Bar: Return to chat & Live Status Indicator */}
        <div className="flex items-center justify-between">
          <button
            onClick={() => setAgentMode('standard')}
            className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-[13px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] border border-transparent hover:border-[var(--border)] transition-all"
          >
            <FiArrowLeft size={14} />
            <span>{t('rsiBack')}</span>
          </button>

          <div className="flex items-center gap-2">
            {running ? (
              <div className="flex items-center gap-2 px-3 py-1.5 rounded-full bg-[var(--accent-soft)] border border-[var(--accent)]/30 text-[12px] font-medium text-[var(--accent)] shadow-xs">
                <span className="relative flex h-2 w-2">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-75" />
                  <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent)]" />
                </span>
                <span>{t('rsiRunning')}</span>
                <span className="font-mono text-[11px] opacity-80 px-1 py-0.5 rounded bg-[var(--accent)]/10">
                  {formatDuration(elapsedSeconds)}
                </span>
              </div>
            ) : (
              <div className="flex items-center gap-1.5 px-3 py-1.5 rounded-full bg-[var(--bg-2)] border border-[var(--border)] text-[12px] text-[var(--text-muted)] font-medium">
                <span className="w-2 h-2 rounded-full bg-[var(--success)]" />
                <span>{t('rsiIdle')}</span>
              </div>
            )}
          </div>
        </div>

        {/* Hero Header Card */}
        <div className="relative overflow-hidden rounded-2xl border border-[var(--border)] bg-[var(--bg-1)] p-5 shadow-xs">
          <div className="flex flex-col sm:flex-row sm:items-center gap-4">
            <div
              className={`w-12 h-12 rounded-2xl flex items-center justify-center shrink-0 shadow-xs transition-colors ${
                running
                  ? 'bg-[var(--error)]/15 text-[var(--error)] ring-2 ring-[var(--error)]/30'
                  : 'bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent)]/20'
              }`}
            >
              <FiZap size={22} className={running ? 'animate-pulse' : ''} />
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex flex-wrap items-center gap-2 mb-1">
                <h1 className="text-[18px] font-semibold tracking-tight text-[var(--text-primary)]">
                  {t('rsiTitle')}
                </h1>
                <span className="px-2 py-0.5 rounded-md text-[11px] font-medium bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20">
                  {t('rsiBadgeLoop')}
                </span>
              </div>
              <p className="text-[13px] text-[var(--text-secondary)] leading-relaxed">
                {t('rsiSubtitle')}
              </p>
            </div>
          </div>
        </div>

        {/* Primary Action & Model Control Banner */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] p-4 shadow-xs space-y-3">
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 pb-1 border-b border-[var(--border)]">
            <div className="flex items-center gap-2.5">
              <div className="w-8 h-8 rounded-xl bg-[var(--bg-3)] flex items-center justify-center text-[var(--text-secondary)] shrink-0">
                <FiCpu size={15} />
              </div>
              <div className="min-w-0">
                <span className="text-[11px] font-medium uppercase tracking-wider text-[var(--text-muted)] block">
                  {t('rsiModelStatus')}
                </span>
                <span className="text-[13.5px] font-medium text-[var(--text-primary)] truncate block">
                  {model ? model.name : t('rsiNoModel')}
                </span>
              </div>
            </div>

            <button
              onClick={() => setModelPickerOpen(true)}
              className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-1)] hover:bg-[var(--bg-3)] border border-[var(--border)] text-[12.5px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors shrink-0"
            >
              <FiSliders size={13} />
              <span>{t('rsiModelChange')}</span>
            </button>
          </div>

          {/* Validation Notice when cannot start */}
          {!model ? (
            <div className="px-3.5 py-2.5 rounded-xl bg-[var(--warning)]/10 border border-[var(--warning)]/25 flex items-center gap-2.5 text-[12.5px] text-[var(--warning)]">
              <FiAlertTriangle size={14} className="shrink-0" />
              <span className="flex-1">{t('rsiNoModel')}</span>
              <button
                onClick={() => setModelPickerOpen(true)}
                className="px-2.5 py-1 rounded-lg bg-[var(--warning)] text-white text-[11.5px] font-medium hover:opacity-90 transition-opacity"
              >
                {t('rsiModelChange')}
              </button>
            </div>
          ) : isMac && !screenRecording ? (
            <div className="px-3.5 py-2.5 rounded-xl bg-[var(--warning)]/10 border border-[var(--warning)]/25 flex items-center gap-2.5 text-[12.5px] text-[var(--warning)]">
              <FiAlertTriangle size={14} className="shrink-0" />
              <span className="flex-1">
                {t('computerScreenRecordingHint')} {t('computerRestartHint')}
              </span>
              <button
                onClick={() => void askScreen()}
                disabled={asking}
                className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[11.5px] font-medium hover:bg-[var(--accent-hover)] transition-colors shrink-0 disabled:opacity-50"
              >
                {t('rsiAskScreen')}
              </button>
            </div>
          ) : null}

          {/* Action Trigger Button */}
          {running ? (
            <div className="space-y-1.5">
              <button
                onClick={stop}
                className="w-full flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-[var(--error)] text-white text-[14px] font-medium hover:opacity-90 active:scale-[0.99] transition-all shadow-xs"
              >
                <FiSquare size={16} />
                <span>{t('rsiStop')}</span>
              </button>
              <p className="text-center text-[11.5px] text-[var(--text-muted)]">
                {t('rsiStopHint')}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5">
              <button
                onClick={() => void start()}
                disabled={!canStart}
                className="w-full flex items-center justify-center gap-2.5 px-5 py-3 rounded-xl bg-[var(--accent)] text-white text-[14px] font-medium hover:bg-[var(--accent-hover)] active:scale-[0.99] transition-all disabled:opacity-45 disabled:pointer-events-none shadow-xs"
              >
                <FiZap size={16} />
                <span>{busy ? t('rsiRunning') : t('rsiStart')}</span>
              </button>
              <p className="text-center text-[11.5px] text-[var(--text-muted)]">
                {t('rsiStartHint')}
              </p>
            </div>
          )}

          {/* Stalled-run gates, in place: a command approval or model question
              stops the loop, and this view hides the chat cards that would
              otherwise resolve it — so show them here instead of leaving the
              run silently parked. Visibility is driven by pending status, so a
              resolved card unmounts on its own. */}
          {pendingCommand && (
            <CommandApprovalCard
              key={pendingCommand.id}
              change={pendingCommand}
              onClose={() => {}}
              onComplete={() => {}}
              pendingIndex={0}
              totalPending={pendingCommands.length}
            />
          )}
          {latestQuestionMessage && (
            <QuestionPromptCard
              key={latestQuestionMessage.id}
              message={latestQuestionMessage}
            />
          )}
          {/* One-click resume for an interrupted turn. */}
          {chatError && !running && (
            <div className="p-3 rounded-xl bg-[var(--error)]/10 border border-[var(--error)]/20 text-[var(--error)] text-sm flex items-center justify-between gap-3">
              <span className="min-w-0 break-words">{chatError}</span>
              <button onClick={clearChatError} className="text-xs underline opacity-70 hover:opacity-100 shrink-0">
                {t('dismiss')}
              </button>
            </div>
          )}
          {continuableConvId === activeConversationId && !running && (
            <button
              onClick={() => void continueGeneration()}
              className="w-full flex items-center justify-center gap-2 px-5 py-2.5 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] active:scale-[0.99] transition-all"
            >
              <FiZap size={14} />
              <span>{t('continueOutput')}</span>
            </button>
          )}
        </div>

        {/* Environment Readiness & Diagnostics Grid */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)] p-4 space-y-3">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold tracking-wide text-[var(--text-primary)] flex items-center gap-2">
              <FiActivity size={14} className="text-[var(--accent)]" />
              <span>{t('rsiPreflightTitle')}</span>
            </h2>
            <button
              onClick={() => void refresh()}
              title={t('rsiRecheck')}
              className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors"
            >
              <FiRefreshCw size={13} />
            </button>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
            {/* Screen Recording Check */}
            <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] flex items-start gap-3">
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                  !isMac || screenRecording
                    ? 'bg-[var(--success)]/10 text-[var(--success)]'
                    : 'bg-[var(--warning)]/15 text-[var(--warning)]'
                }`}
              >
                <FiMonitor size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    {t('rsiScreenStatus')}
                  </span>
                  <span
                    className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md ${
                      !isMac || screenRecording
                        ? 'bg-[var(--success)]/10 text-[var(--success)]'
                        : 'bg-[var(--warning)]/15 text-[var(--warning)]'
                    }`}
                  >
                    {!isMac || screenRecording
                      ? t('rsiGranted')
                      : t('rsiRequired')}
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--text-muted)] leading-tight mb-2">
                  {!isMac
                    ? '当前系统平台直接支持屏幕捕获。'
                    : screenRecording
                      ? '屏幕录制已授权，支持视觉截屏验收。'
                      : t('computerScreenRecordingHint')}
                </p>
                {isMac && !screenRecording && (
                  <div className="flex gap-1.5 pt-1">
                    <button
                      onClick={() => void askScreen()}
                      disabled={asking}
                      className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50"
                    >
                      {t('rsiAskScreen')}
                    </button>
                    <button
                      onClick={() => void refresh()}
                      className="px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors flex items-center gap-1"
                    >
                      <FiRefreshCw size={10} />
                      <span>{t('rsiRecheck')}</span>
                    </button>
                  </div>
                )}
              </div>
            </div>

            {/* Accessibility Check */}
            <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] flex items-start gap-3">
              <div
                className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
                  !isMac || accessibility
                    ? 'bg-[var(--success)]/10 text-[var(--success)]'
                    : 'bg-[var(--warning)]/15 text-[var(--warning)]'
                }`}
              >
                <FiActivity size={14} />
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-1 mb-0.5">
                  <span className="text-[12.5px] font-medium text-[var(--text-primary)]">
                    {t('rsiAccessibilityStatus')}
                  </span>
                  <span
                    className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md ${
                      !isMac || accessibility
                        ? 'bg-[var(--success)]/10 text-[var(--success)]'
                        : 'bg-[var(--warning)]/15 text-[var(--warning)]'
                    }`}
                  >
                    {!isMac || accessibility
                      ? t('rsiGranted')
                      : t('rsiRequired')}
                  </span>
                </div>
                <p className="text-[11.5px] text-[var(--text-muted)] leading-tight mb-2">
                  {!isMac
                    ? '当前系统平台无需额外辅助功能权限。'
                    : accessibility
                      ? '辅助功能已授权，支持自动化交互控制。'
                      : t('computerAccessibilityHint')}
                </p>
                {isMac && !accessibility && (
                  <button
                    onClick={() => void requestPermissions()}
                    className="px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors text-[11px] font-medium inline-block"
                  >
                    {t('computerOpenSettings')}
                  </button>
                )}
              </div>
            </div>
          </div>
        </div>

        {/* 5-Stage Evolution Pipeline */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] p-4 space-y-3 shadow-xs">
          <div className="flex items-center justify-between">
            <h2 className="text-[13px] font-semibold text-[var(--text-primary)] flex items-center gap-2">
              <FiLayers size={14} className="text-[var(--accent)]" />
              <span>{t('rsiPipelineTitle')}</span>
            </h2>
            {running && (
              <span className="text-[11.5px] text-[var(--accent)] font-medium flex items-center gap-1.5">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                <span>{`Phase ${activeStage} · Active`}</span>
              </span>
            )}
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-5 gap-2.5">
            {stages.map((stage) => {
              const isActive = running && activeStage === stage.step;
              const isPast = running && activeStage > stage.step;
              return (
                <div
                  key={stage.step}
                  className={`p-3 rounded-xl border transition-all flex flex-col justify-between ${
                    isActive
                      ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs ring-1 ring-[var(--accent)]/30'
                      : isPast
                        ? 'border-[var(--success)]/30 bg-[var(--success)]/5'
                        : 'border-[var(--border)] bg-[var(--bg-1)]'
                  }`}
                >
                  <div>
                    <div className="flex items-center justify-between mb-2">
                      <span
                        className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold ${
                          isActive
                            ? 'bg-[var(--accent)] text-white'
                            : isPast
                              ? 'bg-[var(--success)] text-white'
                              : 'bg-[var(--bg-3)] text-[var(--text-muted)]'
                        }`}
                      >
                        {isPast ? <FiCheck size={12} /> : stage.step}
                      </span>
                      <span
                        className={`text-[13px] ${
                          isActive
                            ? 'text-[var(--accent)]'
                            : isPast
                              ? 'text-[var(--success)]'
                              : 'text-[var(--text-muted)]'
                        }`}
                      >
                        {stage.icon}
                      </span>
                    </div>

                    <h3 className="text-[12px] font-semibold text-[var(--text-primary)] mb-1 leading-snug">
                      {stage.title}
                    </h3>
                  </div>

                  <p className="text-[11px] text-[var(--text-muted)] leading-relaxed mt-1">
                    {stage.desc}
                  </p>
                </div>
              );
            })}
          </div>
        </div>

        {/* Live Telemetry / Execution Progress Feed */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)] overflow-hidden shadow-xs">
          <div className="px-4 py-3 flex items-center justify-between bg-[var(--bg-2)] border-b border-[var(--border)]">
            <div className="flex items-center gap-2">
              <FiTerminal size={14} className="text-[var(--accent)]" />
              <span className="text-[13px] font-semibold text-[var(--text-primary)]">
                {t('rsiLiveActivityTitle')}
              </span>
              {running && (
                <div className="flex items-center gap-1.5 ml-2">
                  <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-ping" />
                  <span className="text-[11.5px] text-[var(--accent)] font-medium">
                    {activeRun?.toolName
                      ? `${t('rsiLiveToolRunning')}: ${activeRun.toolName}`
                      : activeRun?.status === 'thinking'
                        ? t('rsiLiveThinking')
                        : t('rsiRunning')}
                  </span>
                </div>
              )}
            </div>

            <button
              onClick={() => setShowLogs(!showLogs)}
              className="flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors"
            >
              <span>{t(showLogs ? 'rsiCollapseLogs' : 'rsiExpandLogs')}</span>
              {showLogs ? <FiChevronUp size={13} /> : <FiChevronDown size={13} />}
            </button>
          </div>

          {showLogs && (
            <div
              ref={logContainerRef}
              className="p-4 max-h-[280px] overflow-y-auto font-mono text-[12px] leading-relaxed select-text space-y-2 bg-[var(--bg-1)]"
            >
              {running ? (
                <div>
                  {activeRun?.reasoningContent && (
                    <div className="mb-2 p-2.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[var(--text-muted)] italic whitespace-pre-wrap">
                      {activeRun.reasoningContent}
                    </div>
                  )}
                  {activeRun?.content ? (
                    <div className="whitespace-pre-wrap text-[var(--text-primary)]">
                      {activeRun.content}
                    </div>
                  ) : (
                    <div className="text-[var(--text-muted)] animate-pulse flex items-center gap-2">
                      <FiRefreshCw size={12} className="animate-spin" />
                      <span>{t('rsiLiveThinking')}</span>
                    </div>
                  )}
                </div>
              ) : latestRsiAssistantMessage ? (
                <div>
                  <div className="text-[11px] font-semibold tracking-wider uppercase text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5">
                    <FiCheck size={12} className="text-[var(--success)]" />
                    <span>{t('rsiLatestMilestone')}</span>
                    <span className="text-[10px] font-normal opacity-70">
                      ({new Date(latestRsiAssistantMessage.createdAt).toLocaleTimeString()})
                    </span>
                  </div>
                  <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] whitespace-pre-wrap text-[var(--text-secondary)]">
                    {latestRsiAssistantMessage.content.slice(0, 1500)}
                    {latestRsiAssistantMessage.content.length > 1500 ? '…' : ''}
                  </div>
                </div>
              ) : (
                <div className="py-6 text-center text-[var(--text-muted)]">
                  <p className="text-[12.5px]">{t('rsiNoActivity')}</p>
                </div>
              )}
            </div>
          )}
        </div>

        {/* GitHub Plugin & Tool Integration */}
        <div className="rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] overflow-hidden shadow-xs">
          <button
            onClick={() => setPluginEnabled('github-sync', !githubOn)}
            className="w-full flex items-center justify-between px-4 py-3.5 text-left hover:bg-[var(--bg-1)] transition-colors"
          >
            <div className="flex items-center gap-2.5">
              <div className="w-7 h-7 rounded-lg bg-[var(--bg-3)] flex items-center justify-center text-[var(--text-primary)] shrink-0">
                <FiGitBranch size={14} />
              </div>
              <span className="text-[13.5px] font-medium text-[var(--text-primary)]">
                {t('rsiGithub')}
              </span>
            </div>

            <span
              className={`w-9 h-5 rounded-full transition-colors shrink-0 relative ${
                githubOn ? 'bg-[var(--accent)]' : 'bg-[var(--bg-4)]'
              }`}
            >
              <span
                className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${
                  githubOn ? 'left-[18px]' : 'left-0.5'
                }`}
              />
            </span>
          </button>

          {githubOn && (
            <div className="border-t border-[var(--border)] p-3 bg-[var(--bg-1)]">
              <SyncView />
            </div>
          )}
        </div>

        {/* Footer Quick Tip */}
        <div className="text-center px-4 py-2 text-[11.5px] text-[var(--text-muted)]">
          {t('rsiQuickTip')}
        </div>
      </div>
    </div>
  );
}
