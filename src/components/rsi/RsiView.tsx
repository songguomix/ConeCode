import { useState, useEffect, useRef, useMemo } from 'react';
import {
  FiActivity,
  FiAlertTriangle,
  FiCheck,
  FiChevronDown,
  FiChevronUp,
  FiCpu,
  FiGitBranch,
  FiLayers,
  FiMonitor,
  FiRefreshCw,
  FiSearch,
  FiSliders,
  FiSquare,
  FiTerminal,
  FiX,
  FiZap,
  FiTarget,
} from 'react-icons/fi';
import { useChatStore } from '../../stores/chat.store';
import { useComputerStore } from '../../stores/computer.store';
import { useLanguageStore } from '../../stores/language.store';
import { useModelStore } from '../../stores/model.store';
import { useProviderStore } from '../../stores/provider.store';
import { usePluginStore } from '../../stores/plugin.store';
import { useSettingsStore } from '../../stores/settings.store';
import { useCodeChangesStore } from '../../stores/codeChanges.store';
import { useUIStore } from '../../stores/ui.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { orderForDisplay } from '../../stores/chat.store';
import { rsiCanStart } from '../../core/agents/rsiStart';
import { bootstrapRsiWorkspace, electronAsyncFs } from '../../core/agents/rsiBridge';
import { commandsForConversation } from '../chat/approvalPresentation';
import CommandApprovalCard from '../chat/CommandApprovalCard';
import QuestionPromptCard from '../chat/QuestionPromptCard';
import MessageBubble from '../chat/MessageBubble';
import MessageContent from '../chat/MessageContent';
import ChatInput from '../chat/ChatInput';
import SyncView from '../plugins/SyncView';
import RsiDirectionPanel from './RsiDirectionPanel';
import { isRsiConversation } from '../../core/agents/rsiConversation';
import type { Message } from '../../types';

const isAiSide = (m: Message) => m.role === 'assistant' || m.role === 'tool';

/** Format seconds into mm:ss or hh:mm:ss display */
function formatDuration(sec: number): string {
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  if (h > 0) {
    return `${h}:${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
  }
  return `${m.toString().padStart(2, '0')}:${s.toString().padStart(2, '0')}`;
}

/** Detect which of the 5 RSI stages is currently active from logs/reasoning */
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

/**
 * Owns the center column while agentMode is 'rsi'. Provides high-density status,
 * preflight diagnostics, visual pipeline progression, real-time activity stream,
 * and plugin extensions with a modern tabbed layout.
 */
export default function RsiView() {
  const { t } = useLanguageStore();
  const sendMessage = useChatStore((s) => s.sendMessage);
  const stopGeneration = useChatStore((s) => s.stopGeneration);
  const continuableConvId = useChatStore((s) => s.continuableConvId);
  const continueGeneration = useChatStore((s) => s.continueGeneration);
  const chatError = useChatStore((s) => s.error);
  const clearChatError = useChatStore((s) => s.clearError);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  const streamingRuns = useChatStore((s) => s.streamingRuns);
  const rawMessages = useChatStore((s) => s.messages);
  const conversations = useChatStore((s) => s.conversations);

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

  const [activeTab, setActiveTab] = useState<'console' | 'direction' | 'pipeline'>('console');
  const [busy, setBusy] = useState(false);
  const [asking, setAsking] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLogs, setShowLogs] = useState(true);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    void refresh();
    if (useUIStore.getState().viewMode !== 'work') {
      useUIStore.getState().setViewMode('work');
    }
  }, [refresh]);

  const model = getSelectedModel();
  const isMac = platform === 'darwin';
  const activeRun = activeConversationId ? streamingRuns[activeConversationId] : undefined;
  const running = !!activeRun;

  const conv = conversations.find((c) => c.id === activeConversationId);
  const rsi = conv && isRsiConversation(conv) ? conv.rsi : null;
  const rsiConfig = rsi?.directionConfig ?? null;
  const currentObjective = rsiConfig?.objective?.trim() || '';
  const hasDirectionConfigured = !!(
    rsiConfig?.objective?.trim() ||
    rsiConfig?.priorities?.trim() ||
    rsiConfig?.metrics?.trim() ||
    rsiConfig?.scope?.trim() ||
    rsiConfig?.constraints?.trim()
  );

  // The conversation transcript, tool results folded into display order — the
  // same ordering the chat view renders with.
  const orderedMessages = useMemo(() => orderForDisplay(rawMessages), [rawMessages]);

  // Keep the newest turn in view while it streams in the console tab
  useEffect(() => {
    if (activeTab === 'console' && transcriptRef.current) {
      transcriptRef.current.scrollTop = transcriptRef.current.scrollHeight;
    }
  }, [activeTab, orderedMessages.length, activeRun?.content, activeRun?.reasoningContent]);

  // Reload/crash reconciliation
  const danglingRequest = useMemo(() => {
    if (running) return false;
    const tail = rawMessages[rawMessages.length - 1];
    return !!tail && tail.role === 'user' && !tail.isToolResult && !tail.isQuestion && !tail.isSummary && !tail.isLocalNotice;
  }, [running, rawMessages]);

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

      if ((continuableConvId && continuableConvId === activeConversationId) || danglingRequest) {
        await continueGeneration();
        return;
      }

      try {
        const afs = electronAsyncFs();
        const root = useWorkspaceStore.getState().rootPath;
        if (afs && root) await bootstrapRsiWorkspace(afs, root);
      } catch {
        /* offline bridge: prompt-driven loop still proceeds */
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
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--bg-0)] overflow-hidden select-text relative">
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
            <div className="p-4 border-b border-[var(--border)] flex items-center justify-between gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FiCpu size={16} className="text-[var(--accent)] shrink-0" />
                <h3 className="text-[14px] font-semibold text-[var(--text-primary)] truncate">
                  {t('rsiModelChange')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModelPickerOpen(false)}
                className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0"
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
                      type="button"
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
                type="button"
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

      {/* Top Sticky Control Hub */}
      <div className="shrink-0 border-b border-[var(--border)] bg-[var(--bg-1)]/75 backdrop-blur-xl px-4 pt-3 pb-2 z-10 shadow-xs">
        <div className="max-w-[960px] mx-auto w-full space-y-2.5">
          {/* Top Row: Identity & Status + Model Picker + Start/Stop CTA */}
          <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 min-w-0">
            {/* Identity & Status */}
            <div className="flex items-center gap-3 min-w-0">
              <div
                className={`w-10 h-10 rounded-xl flex items-center justify-center shrink-0 shadow-xs transition-colors ${
                  running
                    ? 'bg-[var(--error)]/15 text-[var(--error)] ring-2 ring-[var(--error)]/30'
                    : 'bg-[var(--accent-soft)] text-[var(--accent)] ring-1 ring-[var(--accent)]/20'
                }`}
              >
                <FiZap size={18} className={running ? 'animate-pulse' : ''} />
              </div>

              <div className="min-w-0">
                <div className="flex items-center gap-2">
                  <h1 className="text-[15px] font-bold tracking-tight text-[var(--text-primary)] truncate">
                    {t('rsiTitle')}
                  </h1>
                  <span className="px-2 py-0.5 rounded-md text-[10px] font-semibold bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/20 shrink-0 uppercase tracking-wider">
                    {t('rsiBadgeLoop')}
                  </span>
                </div>

                <div className="flex items-center gap-2 mt-0.5 text-[12px] text-[var(--text-muted)] min-w-0">
                  {running ? (
                    <span className="inline-flex items-center gap-1.5 text-[var(--accent)] font-medium">
                      <span className="relative flex h-2 w-2 shrink-0">
                        <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-[var(--accent)] opacity-75" />
                        <span className="relative inline-flex rounded-full h-2 w-2 bg-[var(--accent)]" />
                      </span>
                      <span>{t('rsiRunning')}</span>
                      <span className="font-mono text-[11px] px-1.5 py-0.2 rounded bg-[var(--accent)]/15 text-[var(--accent)] font-semibold">
                        {formatDuration(elapsedSeconds)}
                      </span>
                      {activeStage > 0 && (
                        <span className="text-[11px] opacity-80 shrink-0">· Phase {activeStage}</span>
                      )}
                    </span>
                  ) : (
                    <span className="inline-flex items-center gap-1.5 text-[var(--text-muted)]">
                      <span className="w-2 h-2 rounded-full bg-[var(--success)] shrink-0" />
                      <span>{t('rsiIdle')}</span>
                      {rsi && rsi.runs.length > 0 && (
                        <span className="text-[11px] opacity-75 shrink-0">
                          · 迭代 #{rsi.runs[rsi.runs.length - 1].iteration}
                        </span>
                      )}
                    </span>
                  )}
                </div>
              </div>
            </div>

            {/* Right Controls: Model Pill & Start/Stop CTA */}
            <div className="flex items-center gap-2 shrink-0 self-start sm:self-auto">
              {/* Model Selector Pill */}
              <button
                type="button"
                onClick={() => setModelPickerOpen(true)}
                className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl bg-[var(--bg-2)] hover:bg-[var(--bg-3)] border border-[var(--border)] text-[12px] text-[var(--text-primary)] transition-all shrink-0 max-w-[210px] group shadow-2xs"
                title={model ? `${model.name} (${model.providerId})` : t('rsiNoModel')}
              >
                <FiCpu size={13} className="text-[var(--accent)] shrink-0 group-hover:scale-105 transition-transform" />
                <span className="truncate font-medium">{model ? model.name : t('rsiNoModel')}</span>
                <FiSliders size={11} className="text-[var(--text-muted)] shrink-0 opacity-60 ml-0.5" />
              </button>

              {/* Start / Stop Primary CTA */}
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-[var(--error)] hover:opacity-90 active:scale-95 text-white text-[12.5px] font-semibold transition-all shadow-xs"
                >
                  <FiSquare size={13} />
                  <span>{t('rsiStop')}</span>
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={!canStart}
                  className="inline-flex items-center gap-1.5 px-4 py-1.5 rounded-xl bg-[var(--accent)] hover:bg-[var(--accent-hover)] active:scale-95 text-white text-[12.5px] font-semibold transition-all shadow-xs disabled:opacity-40 disabled:pointer-events-none"
                >
                  <FiZap size={13} />
                  <span>{busy ? t('rsiRunning') : t('rsiStart')}</span>
                </button>
              )}
            </div>
          </div>

          {/* System Readiness Warnings (compact inline banner) */}
          {!model ? (
            <div className="px-3 py-1.5 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/25 flex items-center justify-between gap-2 text-[12px] text-[var(--warning)] anim-fade">
              <div className="flex items-center gap-1.5 min-w-0">
                <FiAlertTriangle size={13} className="shrink-0" />
                <span className="truncate">{t('rsiNoModel')}</span>
              </div>
              <button
                type="button"
                onClick={() => setModelPickerOpen(true)}
                className="px-2 py-0.5 rounded bg-[var(--warning)] text-white text-[11px] font-medium hover:opacity-90 shrink-0"
              >
                {t('rsiModelChange')}
              </button>
            </div>
          ) : isMac && !screenRecording ? (
            <div className="px-3 py-1.5 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/25 flex items-center justify-between gap-2 text-[12px] text-[var(--warning)] anim-fade">
              <div className="flex items-center gap-1.5 min-w-0">
                <FiAlertTriangle size={13} className="shrink-0" />
                <span className="truncate">{t('computerScreenRecordingHint')}</span>
              </div>
              <button
                type="button"
                onClick={() => void askScreen()}
                disabled={asking}
                className="px-2.5 py-0.5 rounded bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] shrink-0 disabled:opacity-50"
              >
                {t('rsiAskScreen')}
              </button>
            </div>
          ) : null}

          {/* Interruptions / Approvals in Hub */}
          {chatError && !running && (
            <div className="px-3 py-1.5 rounded-lg bg-[var(--error)]/10 border border-[var(--error)]/20 text-[var(--error)] text-[12px] flex items-center justify-between gap-2 anim-fade">
              <span className="truncate">{chatError}</span>
              <button onClick={clearChatError} className="text-[11px] underline opacity-70 hover:opacity-100 shrink-0">
                {t('dismiss')}
              </button>
            </div>
          )}
          {danglingRequest && (
            <div className="px-3 py-1.5 rounded-lg bg-[var(--warning)]/10 border border-[var(--warning)]/25 text-[var(--text-primary)] text-[12px] flex items-center justify-between gap-2 anim-fade">
              <span className="truncate">⚠️ {t('unansweredRunNotice')}</span>
              <button
                type="button"
                onClick={() => void continueGeneration()}
                className="px-2.5 py-0.5 rounded bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] shrink-0"
              >
                {t('continueOutput')}
              </button>
            </div>
          )}
          {continuableConvId === activeConversationId && !running && (
            <button
              type="button"
              onClick={() => void continueGeneration()}
              className="w-full flex items-center justify-center gap-1.5 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-hover)] transition-all shadow-2xs"
            >
              <FiZap size={13} />
              <span>{t('continueOutput')}</span>
            </button>
          )}
          {pendingCommand && (
            <div className="pt-1">
              <CommandApprovalCard
                key={pendingCommand.id}
                change={pendingCommand}
                onClose={() => {}}
                onComplete={() => {}}
                pendingIndex={0}
                totalPending={pendingCommands.length}
              />
            </div>
          )}
          {latestQuestionMessage && (
            <div className="pt-1">
              <QuestionPromptCard
                key={latestQuestionMessage.id}
                message={latestQuestionMessage}
              />
            </div>
          )}

          {/* Tab Navigation Pill Bar */}
          <div className="flex items-center gap-1 pt-1 border-t border-[var(--border)]/60">
            <button
              type="button"
              onClick={() => setActiveTab('console')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                activeTab === 'console'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]'
              }`}
            >
              <FiTerminal size={13} />
              <span>{t('rsiTabConsole')}</span>
              <span
                className={`text-[10px] px-1.5 py-0.2 rounded-full font-semibold ${
                  activeTab === 'console'
                    ? 'bg-[var(--accent)] text-white'
                    : 'bg-[var(--bg-3)] text-[var(--text-muted)]'
                }`}
              >
                {orderedMessages.length}
              </span>
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('direction')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                activeTab === 'direction'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]'
              }`}
            >
              <FiTarget size={13} />
              <span>{t('rsiTabDirection')}</span>
              {hasDirectionConfigured && (
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] shrink-0" />
              )}
            </button>

            <button
              type="button"
              onClick={() => setActiveTab('pipeline')}
              className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-[12.5px] font-medium transition-colors ${
                activeTab === 'pipeline'
                  ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                  : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]'
              }`}
            >
              <FiLayers size={13} />
              <span>{t('rsiTabPipeline')}</span>
              {running && (
                <span className="text-[10px] px-1.5 py-0.2 rounded-full bg-[var(--accent)] text-white font-mono font-semibold animate-pulse">
                  P{activeStage || 1}
                </span>
              )}
            </button>
          </div>
        </div>
      </div>

      {/* Main Tab Content Area */}
      {activeTab === 'console' && (
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Direction Summary Banner at top of chat */}
          <div className="shrink-0 px-4 py-2 border-b border-[var(--border)]/50 bg-[var(--bg-1)]/40 flex items-center justify-between gap-3 text-[12px]">
            <div className="flex items-center gap-2 min-w-0">
              <FiTarget size={13} className="text-[var(--accent)] shrink-0" />
              {currentObjective ? (
                <span className="truncate text-[var(--text-secondary)]">
                  <strong className="text-[var(--text-primary)] font-medium">{t('rsiDirectionObjective')}:</strong>{' '}
                  {currentObjective}
                </span>
              ) : (
                <span className="text-[var(--text-muted)] truncate">
                  {t('rsiNoDirectionConfigured')}
                </span>
              )}
            </div>
            <button
              type="button"
              onClick={() => setActiveTab('direction')}
              className="text-[11.5px] text-[var(--accent)] hover:underline shrink-0 font-medium"
            >
              {t('rsiEditDirection')} →
            </button>
          </div>

          {/* Active running phase badge if running */}
          {running && (
            <div className="shrink-0 px-4 py-1.5 bg-[var(--accent-soft)]/50 border-b border-[var(--accent)]/20 flex items-center justify-between gap-2 text-[11.5px] text-[var(--accent)] anim-fade">
              <div className="flex items-center gap-2 min-w-0">
                <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse shrink-0" />
                <span className="font-semibold shrink-0">
                  Phase {activeStage || 1}: {stages[(activeStage || 1) - 1]?.title}
                </span>
                <span className="text-[var(--text-muted)] truncate">
                  · {activeRun?.toolName ? `${t('rsiLiveToolRunning')}: ${activeRun.toolName}` : t('rsiLiveThinking')}
                </span>
              </div>
              <button
                type="button"
                onClick={() => setActiveTab('pipeline')}
                className="underline text-[11px] opacity-80 hover:opacity-100 shrink-0"
              >
                查看管线 →
              </button>
            </div>
          )}

          {/* Scrollable Transcript */}
          <div
            ref={transcriptRef}
            className="flex-1 overflow-y-auto overflow-x-hidden p-4 space-y-2 min-w-0"
          >
            <div className="max-w-[860px] mx-auto w-full space-y-2">
              {orderedMessages.length === 0 && !running ? (
                <div className="py-16 text-center text-[13px] text-[var(--text-muted)] break-words [overflow-wrap:anywhere]">
                  <div className="w-12 h-12 rounded-2xl bg-[var(--bg-2)] flex items-center justify-center mx-auto mb-3 text-[var(--text-muted)]">
                    <FiTerminal size={22} />
                  </div>
                  <p className="font-medium text-[var(--text-secondary)] mb-1">
                    {t('rsiConvTranscriptEmpty')}
                  </p>
                  <p className="text-[12px] opacity-75">
                    在下方输入指令或配置演化方向，点击上方「一键启动」即可开始递归自我演化
                  </p>
                </div>
              ) : (
                orderedMessages.map((msg, i) => (
                  <MessageBubble
                    key={msg.id}
                    message={msg}
                    isContinuation={i > 0 && isAiSide(orderedMessages[i - 1]) === isAiSide(msg)}
                  />
                ))
              )}

              {running && (
                <div className="mt-3 min-w-0">
                  {/* Auto-retry pill after a network/model interruption */}
                  {activeRun?.retry && (
                    <div className="mb-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[var(--warning)]/30 bg-[var(--warning)]/10 text-[12px] font-medium text-[var(--warning)] anim-fade">
                      <FiRefreshCw size={12} className="animate-spin shrink-0" />
                      <span className="whitespace-nowrap">
                        {activeRun.retry.max != null
                          ? `${t('streamRetry')} ${activeRun.retry.attempt}/${activeRun.retry.max}`
                          : `${t('streamRetryEndless')} · ${activeRun.retry.attempt}`}
                      </span>
                    </div>
                  )}
                  {activeRun?.reasoningContent && (
                    <details open className="mb-3 rounded-xl border border-[var(--glass-border)] bg-[var(--glass-card)] px-3 py-2 min-w-0">
                      <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">{t('thinkingProcess')}</summary>
                      <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-[var(--text-secondary)]">{activeRun.reasoningContent}</div>
                    </details>
                  )}
                  {activeRun?.content ? (
                    <MessageContent content={activeRun.content} streaming />
                  ) : (
                    <span className="text-[13px] text-[var(--text-muted)] anim-caret break-words [overflow-wrap:anywhere] truncate block min-w-0">
                      {activeRun?.toolName
                        ? `${t('callingTool')} ${activeRun.toolName}...`
                        : activeRun?.status === 'thinking' ? t('thinking') + '...' : '...'}
                    </span>
                  )}
                </div>
              )}
            </div>
          </div>

          {/* Chat Composer */}
          <div className="shrink-0 p-3 pt-1 border-t border-[var(--border)]/50 bg-[var(--bg-0)]">
            <div className="max-w-[860px] mx-auto w-full">
              <ChatInput />
            </div>
          </div>
        </div>
      )}

      {activeTab === 'direction' && (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0">
          <div className="max-w-[860px] mx-auto w-full">
            <RsiDirectionPanel onSaved={() => setActiveTab('console')} />
          </div>
        </div>
      )}

      {activeTab === 'pipeline' && (
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 min-h-0 space-y-5">
          <div className="max-w-[860px] mx-auto w-full space-y-5">
            {/* 5-Stage Evolution Pipeline */}
            <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)]/70 backdrop-blur-2xl p-4 sm:p-5 space-y-3.5 shadow-xs">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <h2 className="text-[13px] font-bold text-[var(--text-primary)] flex items-center gap-2 min-w-0 truncate">
                  <FiLayers size={15} className="text-[var(--accent)] shrink-0" />
                  <span className="truncate">{t('rsiPipelineTitle')}</span>
                </h2>
                {running && (
                  <span className="text-[11.5px] text-[var(--accent)] font-semibold flex items-center gap-1.5 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                    <span>{`Phase ${activeStage || 1} · Active`}</span>
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 xl:grid-cols-5 gap-2.5">
                {stages.map((stage) => {
                  const isActive = running && activeStage === stage.step;
                  const isPast = running && activeStage > stage.step;
                  return (
                    <div
                      key={stage.step}
                      className={`p-3 rounded-xl border transition-all flex flex-col justify-between min-w-0 overflow-hidden ${
                        isActive
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs ring-1 ring-[var(--accent)]/30'
                          : isPast
                            ? 'border-[var(--success)]/30 bg-[var(--success)]/5'
                            : 'border-[var(--glass-border)] bg-[var(--glass-card)]/40'
                      }`}
                    >
                      <div className="min-w-0">
                        <div className="flex items-center justify-between mb-2 gap-1 min-w-0">
                          <span
                            className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${
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
                            className={`text-[13px] shrink-0 ${
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

                        <h3 className="text-[12px] font-semibold text-[var(--text-primary)] mb-1 leading-snug break-words [overflow-wrap:anywhere]">
                          {stage.title}
                        </h3>
                      </div>

                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed mt-1 break-words [overflow-wrap:anywhere]">
                        {stage.desc}
                      </p>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live Telemetry / Execution Progress Feed */}
            <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-card)]/70 backdrop-blur-xl shadow-xs overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between gap-2 bg-[var(--glass-surface)]/60 border-b border-[var(--glass-border)] min-w-0">
                <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                  <FiTerminal size={14} className="text-[var(--accent)] shrink-0" />
                  <span className="text-[13px] font-semibold text-[var(--text-primary)] shrink-0">
                    {t('rsiLiveActivityTitle')}
                  </span>
                  {running && (
                    <div className="flex items-center gap-1.5 ml-2 min-w-0 truncate">
                      <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-ping shrink-0" />
                      <span className="text-[11.5px] text-[var(--accent)] font-medium truncate">
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
                  type="button"
                  onClick={() => setShowLogs(!showLogs)}
                  className="flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0"
                >
                  <span>{t(showLogs ? 'rsiCollapseLogs' : 'rsiExpandLogs')}</span>
                  {showLogs ? <FiChevronUp size={13} /> : <FiChevronDown size={13} />}
                </button>
              </div>

              {showLogs && (
                <div
                  ref={logContainerRef}
                  className="p-4 max-h-[300px] overflow-y-auto overflow-x-hidden font-mono text-[12px] leading-relaxed select-text space-y-2 min-w-0 bg-[var(--bg-1)]/40"
                >
                  {running ? (
                    <div className="min-w-0">
                      {activeRun?.reasoningContent && (
                        <div className="mb-2 p-2.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] text-[var(--text-muted)] italic whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0">
                          {activeRun.reasoningContent}
                        </div>
                      )}
                      {activeRun?.content ? (
                        <div className="whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-primary)] min-w-0">
                          {activeRun.content}
                        </div>
                      ) : (
                        <div className="text-[var(--text-muted)] animate-pulse flex items-center gap-2">
                          <FiRefreshCw size={12} className="animate-spin shrink-0" />
                          <span>{t('rsiLiveThinking')}</span>
                        </div>
                      )}
                    </div>
                  ) : latestRsiAssistantMessage ? (
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold tracking-wider uppercase text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5 min-w-0">
                        <FiCheck size={12} className="text-[var(--success)] shrink-0" />
                        <span className="truncate">{t('rsiLatestMilestone')}</span>
                        <span className="text-[10px] font-normal opacity-70 shrink-0">
                          ({new Date(latestRsiAssistantMessage.createdAt).toLocaleTimeString()})
                        </span>
                      </div>
                      <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-secondary)] min-w-0">
                        {latestRsiAssistantMessage.content.slice(0, 1500)}
                        {latestRsiAssistantMessage.content.length > 1500 ? '…' : ''}
                      </div>
                    </div>
                  ) : (
                    <div className="py-8 text-center text-[var(--text-muted)]">
                      <p className="text-[12.5px] break-words [overflow-wrap:anywhere]">{t('rsiNoActivity')}</p>
                    </div>
                  )}
                </div>
              )}
            </div>

            {/* Environment Readiness & Diagnostics Grid */}
            <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-card)]/70 backdrop-blur-xl p-4 sm:p-5 space-y-3.5 shadow-xs">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <h2 className="text-[13px] font-bold tracking-wide text-[var(--text-primary)] flex items-center gap-2 min-w-0 truncate">
                  <FiActivity size={14} className="text-[var(--accent)] shrink-0" />
                  <span className="truncate">{t('rsiPreflightTitle')}</span>
                </h2>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  title={t('rsiRecheck')}
                  className="p-1.5 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors shrink-0"
                >
                  <FiRefreshCw size={13} />
                </button>
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                {/* Screen Recording Check */}
                <div className="p-3 rounded-xl bg-[var(--glass-card)]/50 border border-[var(--glass-border)] flex items-start gap-3 min-w-0">
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
                    <div className="flex items-center justify-between gap-1.5 mb-1 min-w-0">
                      <span className="text-[12.5px] font-medium text-[var(--text-primary)] min-w-0 truncate">
                        {t('rsiScreenStatus')}
                      </span>
                      <span
                        className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md shrink-0 ${
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
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed mb-2 break-words [overflow-wrap:anywhere]">
                      {!isMac
                        ? '当前系统平台直接支持屏幕捕获。'
                        : screenRecording
                          ? '屏幕录制已授权，支持视觉截屏验收。'
                          : t('computerScreenRecordingHint')}
                    </p>
                    {isMac && !screenRecording && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => void askScreen()}
                          disabled={asking}
                          className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 shrink-0"
                        >
                          {t('rsiAskScreen')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void refresh()}
                          className="px-2.5 py-1 rounded-lg bg-[var(--bg-3)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors flex items-center gap-1 shrink-0"
                        >
                          <FiRefreshCw size={10} />
                          <span>{t('rsiRecheck')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Accessibility Check */}
                <div className="p-3 rounded-xl bg-[var(--glass-card)]/50 border border-[var(--glass-border)] flex items-start gap-3 min-w-0">
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
                    <div className="flex items-center justify-between gap-1.5 mb-1 min-w-0">
                      <span className="text-[12.5px] font-medium text-[var(--text-primary)] min-w-0 truncate">
                        {t('rsiAccessibilityStatus')}
                      </span>
                      <span
                        className={`text-[11px] font-medium px-1.5 py-0.5 rounded-md shrink-0 ${
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
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed mb-2 break-words [overflow-wrap:anywhere]">
                      {!isMac
                        ? '当前系统平台无需额外辅助功能权限。'
                        : accessibility
                          ? '辅助功能已授权，支持自动化交互控制。'
                          : t('computerAccessibilityHint')}
                    </p>
                    {isMac && !accessibility && (
                      <button
                        type="button"
                        onClick={() => void requestPermissions()}
                        className="px-2.5 py-1 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors text-[11px] font-medium inline-block shrink-0"
                      >
                        {t('computerOpenSettings')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* GitHub Plugin & Tool Integration */}
            <div className="rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-surface)]/70 backdrop-blur-2xl shadow-xs overflow-hidden">
              <button
                type="button"
                onClick={() => setPluginEnabled('github-sync', !githubOn)}
                className="w-full flex items-center justify-between gap-2 px-4 py-3.5 text-left hover:bg-[var(--bg-1)] transition-colors min-w-0"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                  <div className="w-7 h-7 rounded-lg bg-[var(--bg-3)] flex items-center justify-center text-[var(--text-primary)] shrink-0">
                    <FiGitBranch size={14} />
                  </div>
                  <span className="text-[13.5px] font-medium text-[var(--text-primary)] truncate block">
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
                <div className="border-t border-[var(--glass-border)] p-3 bg-[var(--glass-card)]/40 min-w-0">
                  <SyncView />
                </div>
              )}
            </div>

            {/* Footer Quick Tip */}
            <div className="text-center px-4 py-2 text-[11.5px] text-[var(--text-muted)] break-words [overflow-wrap:anywhere]">
              {t('rsiQuickTip')}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
