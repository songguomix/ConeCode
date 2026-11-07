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
import SyncView from '../plugins/SyncView';
import RsiDirectionPanel from './RsiDirectionPanel';
import RsiWorkspaceHeader from './RsiWorkspaceHeader';
import RsiWelcome from './RsiWelcome';
import { isRsiConversation, rsiWorkspaceDir } from '../../core/agents/rsiConversation';
import { detectRsiPhase, formatRsiDuration, rsiStatusLabel } from './rsiPresentation';
import type { Message } from '../../types';
import './rsi-layout.css';

const isAiSide = (m: Message) => m.role === 'assistant' || m.role === 'tool';

/**
 * Owns the center column while agentMode is 'rsi'. Provides high-density status,
 * visual pipeline progression, and autonomous recursive evolution.
 * RSI has no chat composer: runs start from the header, and approvals or
 * questions dock above the progress row only when they need an answer.
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
  const model = useModelStore((s) => s.getSelectedModel());
  const providers = useProviderStore((s) => s.providers);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const workspaceRoot = useWorkspaceStore((s) => s.rootPath);

  const refresh = useComputerStore((s) => s.refresh);
  const setComputerEnabled = useComputerStore((s) => s.setEnabled);
  const requestPermissions = useComputerStore((s) => s.requestPermissions);
  const screenRecording = useComputerStore((s) => s.screenRecording);
  const accessibility = useComputerStore((s) => s.accessibility);
  const platform = useComputerStore((s) => s.platform);

  const githubOn = usePluginStore((s) => !s.disabled.includes('github-sync'));
  const setPluginEnabled = usePluginStore((s) => s.setEnabled);

  const [activeTab, setActiveTab] = useState<'console' | 'direction' | 'pipeline'>('console');
  const [directionOpened, setDirectionOpened] = useState(false);
  const [startingConversationId, setStartingConversationId] = useState<string | null>(null);
  const startLockRef = useRef(false);
  const [actionError, setActionError] = useState<string | null>(null);
  const [asking, setAsking] = useState(false);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [showLogs, setShowLogs] = useState(true);
  const [modelPickerOpen, setModelPickerOpen] = useState(false);
  const [modelSearch, setModelSearch] = useState('');
  const logContainerRef = useRef<HTMLDivElement>(null);
  const transcriptRef = useRef<HTMLDivElement>(null);
  const followTranscriptRef = useRef(true);
  const followLogsRef = useRef(true);
  const modelDialogRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (activeTab === 'direction') setDirectionOpened(true);
  }, [activeTab]);

  useEffect(() => {
    if (!modelPickerOpen) return;
    const previousFocus = document.activeElement as HTMLElement | null;
    const handleKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setModelPickerOpen(false);
      }
      if (event.key !== 'Tab') return;
      const elements = modelDialogRef.current?.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled]), [tabindex="0"]');
      if (!elements?.length) return;
      const first = elements[0];
      const last = elements[elements.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener('keydown', handleKey);
    return () => {
      document.removeEventListener('keydown', handleKey);
      if (previousFocus?.isConnected) previousFocus.focus();
    };
  }, [modelPickerOpen]);

  useEffect(() => {
    void refresh().catch((error) => setActionError(error instanceof Error ? error.message : t('rsiOperationFailed')));
    if (useUIStore.getState().viewMode !== 'work') {
      useUIStore.getState().setViewMode('work');
    }
  }, [refresh]);

  const isMac = platform === 'darwin';
  const activeRun = activeConversationId ? streamingRuns[activeConversationId] : undefined;
  const running = !!activeRun;
  const busy = startingConversationId === activeConversationId && startingConversationId !== null;

  const conv = conversations.find((c) => c.id === activeConversationId);
  const rsi = conv && isRsiConversation(conv) ? conv.rsi : null;
  const lastRun = rsi?.runs[rsi.runs.length - 1];
  const rsiConfig = rsi?.directionConfig ?? null;
  const currentObjective = rsiConfig?.objective?.trim() || '';
  const hasDirectionConfigured = !!(
    rsiConfig?.objective?.trim() ||
    rsiConfig?.priorities?.trim() ||
    rsiConfig?.metrics?.trim() ||
    rsiConfig?.scope?.trim() ||
    rsiConfig?.constraints?.trim()
  );

  const orderedMessages = useMemo(() => orderForDisplay(rawMessages), [rawMessages]);

  useEffect(() => {
    followTranscriptRef.current = true;
    followLogsRef.current = true;
    setActionError(null);
  }, [activeConversationId, activeTab]);

  useEffect(() => {
    const transcript = transcriptRef.current;
    if (activeTab !== 'console' || !transcript) return;
    if (orderedMessages.length === 0 && !running) {
      transcript.scrollTop = 0;
    } else if (followTranscriptRef.current) {
      transcript.scrollTop = transcript.scrollHeight;
    }
  }, [activeConversationId, activeTab, orderedMessages.length, running, activeRun?.content, activeRun?.reasoningContent, activeRun?.toolName]);

  const danglingRequest = useMemo(() => {
    if (running) return false;
    const tail = rawMessages[rawMessages.length - 1];
    return !!tail && tail.role === 'user' && !tail.isToolResult && !tail.isQuestion && !tail.isSummary && !tail.isLocalNotice;
  }, [running, rawMessages]);

  const canStart =
    !!rsi &&
    !startingConversationId &&
    !running &&
    rsiCanStart({
      isMac,
      screenRecording,
      accessibility,
      hasModel: !!model,
    });

  useEffect(() => {
    const startedAt = lastRun?.createdAt;
    const update = () => setElapsedSeconds(startedAt
      ? Math.max(0, Math.floor(((running ? Date.now() : lastRun.updatedAt) - startedAt) / 1000))
      : 0);
    update();
    if (!running) return;
    const interval = window.setInterval(update, 1000);
    return () => window.clearInterval(interval);
  }, [activeConversationId, running, lastRun?.id, lastRun?.createdAt, lastRun?.updatedAt]);

  const latestRsiAssistantMessage = useMemo(() => {
    for (let i = rawMessages.length - 1; i >= 0; i--) {
      const message = rawMessages[i];
      if (message.role === 'assistant' && !message.isLocalNotice && !message.isSummary
        && (!lastRun || message.createdAt >= lastRun.createdAt)) return message;
    }
    return null;
  }, [rawMessages, lastRun?.createdAt]);

  const currentSnippet =
    activeRun?.content ||
    activeRun?.reasoningContent ||
    latestRsiAssistantMessage?.content ||
    '';

  const activeStage = useMemo(() => {
    if (!running) return 0;
    return detectRsiPhase(currentSnippet);
  }, [running, currentSnippet]);

  useEffect(() => {
    if (running && followLogsRef.current && logContainerRef.current) {
      logContainerRef.current.scrollTop = logContainerRef.current.scrollHeight;
    }
  }, [activeTab, showLogs, running, activeRun?.content, activeRun?.reasoningContent]);

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
    const targetId = activeConversationId;
    if (!model || !targetId || !rsi || startLockRef.current || running) return;
    startLockRef.current = true;
    setStartingConversationId(targetId);
    setActionError(null);
    const stillActive = () => useChatStore.getState().activeConversationId === targetId;
    const previousApproval = useSettingsStore.getState().approvalOverride;
    let changedApproval = false;
    try {
      await refresh();
      if (!stillActive()) return;
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
      if (!stillActive()) return;
      changedApproval = true;
      useSettingsStore.setState({ approvalOverride: 'fullAuto' });

      if ((continuableConvId && continuableConvId === activeConversationId) || danglingRequest) {
        await continueGeneration();
        return;
      }

      try {
        const afs = electronAsyncFs();
        const root = useWorkspaceStore.getState().rootPath;
        if (afs && root) await bootstrapRsiWorkspace(afs, root, undefined, rsiWorkspaceDir(root, targetId));
      } catch {
        /* offline bridge: prompt-driven loop still proceeds */
      }
      if (!stillActive()) return;
      await sendMessage(t('rsiKickoff'), model.providerId, model.id, { rsiExecution: true });
    } catch (error) {
      if (stillActive()) setActionError(error instanceof Error ? error.message : t('rsiOperationFailed'));
    } finally {
      if (changedApproval && useSettingsStore.getState().approvalOverride === 'fullAuto') {
        useSettingsStore.setState({ approvalOverride: previousApproval });
      }
      startLockRef.current = false;
      setStartingConversationId(null);
    }
  };

  const stop = () => {
    stopGeneration(activeConversationId ?? undefined);
    void setComputerEnabled(false).catch((error) => setActionError(error instanceof Error ? error.message : t('rsiOperationFailed')));
  };

  const askScreen = async () => {
    setAsking(true);
    try {
      await (window as any).electronAPI?.computer?.screenshot?.();
    } catch {
      /* denial surfaces as needsPermission */
    }
    try {
      await refresh();
    } catch (error) {
      setActionError(error instanceof Error ? error.message : t('rsiOperationFailed'));
    } finally {
      setAsking(false);
    }
  };

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

  const workspaceHeader = (
    <>
      <RsiWorkspaceHeader
        t={t}
        activeTab={activeTab}
        onTabChange={setActiveTab}
        compact={activeTab === 'console' && (orderedMessages.length > 0 || running)}
        projectPath={workspaceRoot}
        status={running ? `${t('rsiRunning')} · ${formatRsiDuration(elapsedSeconds)}` : t(rsiStatusLabel(lastRun?.status ?? rsi?.status))}
        running={running}
        busy={busy}
        canStart={canStart}
        messageCount={orderedMessages.length}
        hasDirection={hasDirectionConfigured}
        activeStage={activeStage}
        needsPermissions={isMac && (!screenRecording || !accessibility)}
        modelName={model?.name || t('rsiNoModel')}
        modelTitle={model ? `${model.name} (${model.providerId})` : t('rsiNoModel')}
        onChooseModel={() => setModelPickerOpen(true)}
        onStart={() => void start()}
        onStop={stop}
      />
      {actionError && (
        <div role="alert" className="max-w-[840px] mx-auto mb-4 flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--error)_20%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] px-3 py-2 text-xs text-[var(--error)]">
          <FiAlertTriangle size={14} className="mt-0.5 shrink-0" />
          <span className="min-w-0 flex-1 break-words [overflow-wrap:anywhere]">{actionError}</span>
          <button type="button" onClick={() => setActionError(null)} aria-label={t('dismiss')} className="shrink-0 p-0.5"><FiX size={14} /></button>
        </div>
      )}
    </>
  );

  return (
    <div className="rsi-view flex-1 flex flex-col min-h-0 min-w-0 bg-[var(--bg-0)] overflow-hidden select-text relative">
      {/* Dedicated Model Selector Modal for RSI */}
      {modelPickerOpen && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/40 backdrop-blur-sm anim-fade"
          onClick={() => setModelPickerOpen(false)}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-label={t('rsiModelChange')}
            ref={modelDialogRef}
            className="w-full max-w-md bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] rounded-2xl shadow-2xl overflow-hidden flex flex-col max-h-[80vh] anim-scale ring-1 ring-black/5 dark:ring-white/10"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Modal Header */}
            <div className="p-4 border-b border-[var(--glass-border)] flex items-center justify-between gap-2 min-w-0 bg-[color-mix(in_srgb,var(--glass-card)_50%,transparent)]">
              <div className="flex items-center gap-2 min-w-0 flex-1">
                <FiCpu size={16} className="text-[var(--accent)] shrink-0" />
                <h3 className="text-[14px] font-bold text-[var(--text-primary)] font-serif truncate">
                  {t('rsiModelChange')}
                </h3>
              </div>
              <button
                type="button"
                onClick={() => setModelPickerOpen(false)}
                aria-label={t('close')}
                className="p-1.5 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] transition-colors shrink-0 cursor-pointer"
              >
                <FiX size={16} />
              </button>
            </div>

            {/* Search Input */}
            <div className="p-3 border-b border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-subtle)_40%,transparent)]">
              <div className="flex items-center gap-2 px-3 py-1.5 bg-[color-mix(in_srgb,var(--bg-2)_90%,transparent)] border border-[var(--glass-border)] rounded-xl shadow-2xs focus-within:border-[var(--accent)] transition-colors">
                <FiSearch size={14} className="text-[var(--text-muted)] shrink-0" />
                <input
                  type="text"
                  value={modelSearch}
                  onChange={(e) => setModelSearch(e.target.value)}
                  placeholder={t('searchModels')}
                  aria-label={t('searchModels')}
                  className="search-input w-full bg-transparent text-[13px] text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none"
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
                      className={`w-full flex items-center justify-between p-2.5 rounded-xl text-left transition-colors cursor-pointer ${
                        isSelected
                          ? 'bg-[var(--accent-soft)] text-[var(--accent)] font-semibold'
                          : 'hover:bg-[var(--glass-card)] text-[var(--text-primary)]'
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
                  {t('noModels')}
                </div>
              )}
            </div>

            {/* Modal Footer */}
            <div className="p-3 border-t border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_40%,transparent)] flex items-center justify-between">
              <span className="text-[11.5px] text-[var(--text-muted)]">
                {providers.length} {t('setProviders')}
              </span>
              <button
                type="button"
                onClick={() => {
                  setModelPickerOpen(false);
                  toggleSettings();
                }}
                className="px-3 py-1.5 rounded-xl bg-[color-mix(in_srgb,var(--bg-3)_80%,transparent)] hover:bg-[var(--bg-4)] text-[12px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
              >
                {t('settings')}
              </button>
            </div>
          </div>
        </div>
      )}

      {activeTab === 'console' && (
        <div className="flex-1 flex flex-col min-h-0 relative">
          {/* Scrollable Transcript (Full height from top, no full-width long banners blocking the screen) */}
          <div
            ref={transcriptRef}
            onScroll={(event) => {
              const node = event.currentTarget;
              followTranscriptRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
            }}
            className="flex-1 min-h-0 overflow-y-auto overflow-x-hidden py-6 min-w-0"
          >
            <div className="max-w-[900px] mx-auto w-full px-4">
              {workspaceHeader}
              {orderedMessages.length === 0 && !running ? (
                <RsiWelcome
                  t={t}
                  direction={rsiConfig}
                  screenStatus={!isMac ? t('rsiScreenNotRequired') : t(screenRecording ? 'rsiGranted' : 'rsiRequired')}
                  accessibilityStatus={!isMac ? t('rsiAccessibilityNotRequired') : t(accessibility ? 'rsiGranted' : 'rsiRequired')}
                  onTabChange={setActiveTab}
                />
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
                    <div className="mb-3 inline-flex items-center gap-2 px-3 py-1.5 rounded-full border border-[color-mix(in_srgb,var(--warning)_30%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] text-[12px] font-medium text-[var(--warning)] anim-fade">
                      <FiRefreshCw size={12} className="animate-spin shrink-0" />
                      <span className="whitespace-nowrap">
                        {activeRun.retry.max != null
                          ? `${t('streamRetry')} ${activeRun.retry.attempt}/${activeRun.retry.max}`
                          : `${t('streamRetryEndless')} · ${activeRun.retry.attempt}`}
                      </span>
                    </div>
                  )}
                  {!activeRun?.retry && activeRun?.reasoningContent && (
                    <details open className="mb-3 rounded-2xl border border-[var(--glass-border)] bg-[var(--glass-card)] px-3 py-2 min-w-0">
                      <summary className="cursor-pointer text-xs font-medium text-[var(--text-secondary)]">{t('thinking')}</summary>
                      <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-sm leading-relaxed text-[var(--text-secondary)]">{activeRun.reasoningContent}</div>
                    </details>
                  )}
                  {activeRun?.content ? (
                    <MessageContent content={activeRun.content} streaming />
                  ) : !activeRun?.retry && (
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

        </div>
      )}

      {/* Preserve the local direction draft across tabs; the key still isolates conversations. */}
      {(directionOpened || activeTab === 'direction') && (
        <div hidden={activeTab !== 'direction'} className="flex-1 overflow-y-auto py-6 min-h-0">
          <div className="max-w-[900px] mx-auto w-full px-4">
            {workspaceHeader}
            <div className="max-w-[840px] mx-auto w-full">
              <RsiDirectionPanel key={activeConversationId} onSaved={() => setActiveTab((tab) => tab === 'direction' ? 'console' : tab)} />
            </div>
          </div>
        </div>
      )}

      {activeTab === 'pipeline' && (
        <div className="flex-1 overflow-y-auto py-6 min-h-0">
          <div className="max-w-[900px] mx-auto w-full px-4">
            {workspaceHeader}
            <div className="max-w-[840px] mx-auto w-full space-y-3.5">
            {/* 5-Stage Evolution Pipeline */}
            <div className="min-w-0 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-surface)_80%,transparent)] p-4 space-y-3.5">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <h2 className="text-[13.5px] font-bold text-[var(--text-primary)] font-serif flex items-center gap-2 min-w-0 truncate">
                  <FiLayers size={15} className="text-[var(--accent)] shrink-0" />
                  <span className="truncate">{t('rsiPipelineTitle')}</span>
                </h2>
                {running && (
                  <span className="text-[11.5px] text-[var(--accent)] font-semibold flex items-center gap-1.5 shrink-0">
                    <span className="w-1.5 h-1.5 rounded-full bg-[var(--accent)] animate-pulse" />
                    <span>{activeStage ? `P${activeStage} · ${t('rsiRunning')}` : t('rsiRunning')}</span>
                  </span>
                )}
              </div>

              <div className="rsi-stage-grid">
                {stages.map((stage) => {
                  const isActive = running && activeStage === stage.step;
                  return (
                    <div
                      key={stage.step}
                      className={`p-3 rounded-xl border transition-colors flex flex-col justify-between min-w-0 overflow-hidden ${
                        isActive
                          ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs ring-1 ring-[color-mix(in_srgb,var(--accent)_30%,transparent)]'
                          : 'border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_50%,transparent)]'
                      }`}
                    >
                        <div className="flex items-center justify-between mb-2 gap-1 min-w-0">
                          <span
                            className={`w-6 h-6 rounded-lg flex items-center justify-center text-[11px] font-bold shrink-0 ${
                              isActive
                                ? 'bg-[var(--accent)] text-white'
                                : 'bg-[var(--bg-3)] text-[var(--text-muted)]'
                            }`}
                          >
                            {stage.step}
                          </span>
                          <span
                            className={`text-[13px] shrink-0 ${
                              isActive
                                ? 'text-[var(--accent)]'
                                : 'text-[var(--text-muted)]'
                            }`}
                          >
                            {stage.icon}
                          </span>
                        </div>

                      <div className="min-w-0">
                        <h3 className="text-[12px] font-semibold text-[var(--text-primary)] mb-1 leading-snug break-words [overflow-wrap:anywhere]">
                          {stage.title}
                        </h3>
                      <p className="text-[11px] text-[var(--text-muted)] leading-relaxed break-words [overflow-wrap:anywhere]">
                        {stage.desc}
                      </p>
                      </div>
                    </div>
                  );
                })}
              </div>
            </div>

            {/* Live Telemetry / Execution Progress Feed */}
            <div className="min-w-0 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-surface)_80%,transparent)] overflow-hidden">
              <div className="px-4 py-3 flex items-center justify-between gap-2 bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] border-b border-[var(--glass-border)] min-w-0">
                <div className="flex items-center gap-2 min-w-0 flex-1 mr-2">
                  <FiTerminal size={14} className="text-[var(--accent)] shrink-0" />
                  <span className="text-[13px] font-bold text-[var(--text-primary)] font-serif shrink-0">
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
                  className="flex items-center gap-1 text-[11.5px] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors shrink-0 cursor-pointer"
                >
                  <span>{t(showLogs ? 'rsiCollapseLogs' : 'rsiExpandLogs')}</span>
                  {showLogs ? <FiChevronUp size={13} /> : <FiChevronDown size={13} />}
                </button>
              </div>

              {showLogs && (
                <div
                  ref={logContainerRef}
                  onScroll={(event) => {
                    const node = event.currentTarget;
                    followLogsRef.current = node.scrollHeight - node.scrollTop - node.clientHeight < 80;
                  }}
                  className="p-4 max-h-[300px] overflow-y-auto overflow-x-hidden font-mono text-[12px] leading-relaxed select-text space-y-2 min-w-0 bg-[color-mix(in_srgb,var(--bg-1)_40%,transparent)]"
                >
                  {running ? (
                    <div className="min-w-0">
                      {!activeRun?.retry && activeRun?.reasoningContent && (
                        <div className="mb-2 p-2.5 rounded-xl bg-[color-mix(in_srgb,var(--bg-2)_80%,transparent)] border border-[var(--glass-border)] text-[var(--text-muted)] italic whitespace-pre-wrap break-words [overflow-wrap:anywhere] min-w-0">
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
                          <span>{activeRun?.retry ? t('streamRetry') : t('rsiLiveThinking')}</span>
                        </div>
                      )}
                    </div>
                  ) : latestRsiAssistantMessage ? (
                    <div className="min-w-0">
                      <div className="text-[11px] font-semibold tracking-wider uppercase text-[var(--text-muted)] mb-1.5 flex items-center gap-1.5 min-w-0">
                        <FiActivity size={12} className="text-[var(--text-muted)] shrink-0" />
                        <span className="truncate">{t(rsiStatusLabel(lastRun?.status ?? rsi?.status))}</span>
                        <span className="text-[10px] font-normal opacity-70 shrink-0">
                          ({new Date(latestRsiAssistantMessage.createdAt).toLocaleTimeString()})
                        </span>
                      </div>
                      <div className="p-3 rounded-xl bg-[color-mix(in_srgb,var(--bg-2)_80%,transparent)] border border-[var(--glass-border)] whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-[var(--text-secondary)] min-w-0">
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
            <div className="min-w-0 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-surface)_80%,transparent)] p-4 space-y-3">
              <div className="flex items-center justify-between gap-2 min-w-0">
                <h2 className="text-[13.5px] font-bold tracking-wide text-[var(--text-primary)] font-serif flex items-center gap-2 min-w-0 truncate">
                  <FiActivity size={14} className="text-[var(--accent)] shrink-0" />
                  <span className="truncate">{t('rsiPreflightTitle')}</span>
                </h2>
                <button
                  type="button"
                  onClick={() => void refresh()}
                  title={t('rsiRecheck')}
                  className="p-1.5 rounded-xl text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)] transition-colors shrink-0 cursor-pointer"
                >
                  <FiRefreshCw size={13} />
                </button>
              </div>

              <div className="rsi-permission-grid">
                {/* Screen Recording Check */}
                <div className="p-3 rounded-2xl bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] border border-[var(--glass-border)] flex items-start gap-3 min-w-0 shadow-2xs">
                  <div
                    className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                      !isMac || screenRecording
                        ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
                        : 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]'
                    }`}
                  >
                    <FiMonitor size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5 mb-1 min-w-0">
                      <span className="text-[12.5px] font-semibold text-[var(--text-primary)] min-w-0 truncate">
                        {t('rsiScreenStatus')}
                      </span>
                      <span
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 ${
                          !isMac || screenRecording
                            ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
                            : 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]'
                        }`}
                      >
                        {!isMac || screenRecording
                          ? t('rsiGranted')
                          : t('rsiRequired')}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed mb-2 break-words [overflow-wrap:anywhere]">
                      {!isMac
                        ? t('rsiScreenNotRequired')
                        : screenRecording
                          ? t('rsiScreenGranted')
                          : t('computerScreenRecordingHint')}
                    </p>
                    {isMac && !screenRecording && (
                      <div className="flex flex-wrap gap-1.5 pt-1">
                        <button
                          type="button"
                          onClick={() => void askScreen()}
                          disabled={asking}
                          className="px-2.5 py-1 rounded-xl bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-50 shrink-0 cursor-pointer"
                        >
                          {t('rsiAskScreen')}
                        </button>
                        <button
                          type="button"
                          onClick={() => void refresh()}
                          className="px-2.5 py-1 rounded-xl bg-[var(--bg-3)] text-[11px] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors flex items-center gap-1 shrink-0 cursor-pointer"
                        >
                          <FiRefreshCw size={10} />
                          <span>{t('rsiRecheck')}</span>
                        </button>
                      </div>
                    )}
                  </div>
                </div>

                {/* Accessibility Check */}
                <div className="p-3 rounded-2xl bg-[color-mix(in_srgb,var(--glass-card)_60%,transparent)] border border-[var(--glass-border)] flex items-start gap-3 min-w-0 shadow-2xs">
                  <div
                    className={`w-7 h-7 rounded-xl flex items-center justify-center shrink-0 mt-0.5 ${
                      !isMac || accessibility
                        ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
                        : 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]'
                    }`}
                  >
                    <FiActivity size={14} />
                  </div>
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-1.5 mb-1 min-w-0">
                      <span className="text-[12.5px] font-semibold text-[var(--text-primary)] min-w-0 truncate">
                        {t('rsiAccessibilityStatus')}
                      </span>
                      <span
                        className={`text-[11px] font-medium px-2 py-0.5 rounded-full shrink-0 ${
                          !isMac || accessibility
                            ? 'bg-[color-mix(in_srgb,var(--success)_10%,transparent)] text-[var(--success)]'
                            : 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]'
                        }`}
                      >
                        {!isMac || accessibility
                          ? t('rsiGranted')
                          : t('rsiRequired')}
                      </span>
                    </div>
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed mb-2 break-words [overflow-wrap:anywhere]">
                      {!isMac
                        ? t('rsiAccessibilityNotRequired')
                        : accessibility
                          ? t('rsiAccessibilityGranted')
                          : t('computerAccessibilityHint')}
                    </p>
                    {isMac && !accessibility && (
                      <button
                        type="button"
                        onClick={() => void requestPermissions()}
                        className="px-2.5 py-1 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white transition-colors text-[11px] font-medium inline-block shrink-0 cursor-pointer"
                      >
                        {t('computerOpenSettings')}
                      </button>
                    )}
                  </div>
                </div>
              </div>
            </div>

            {/* GitHub Plugin & Tool Integration */}
            <div className="min-w-0 rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-surface)_80%,transparent)] overflow-hidden">
              <button
                type="button"
                onClick={() => setPluginEnabled('github-sync', !githubOn)}
                className="w-full flex items-center justify-between gap-2 px-4 py-3.5 text-left hover:bg-[var(--glass-card)] transition-colors min-w-0 cursor-pointer"
              >
                <div className="flex items-center gap-2.5 min-w-0 flex-1 mr-2">
                  <div className="w-8 h-8 rounded-xl bg-[var(--bg-3)] flex items-center justify-center text-[var(--text-primary)] shrink-0 shadow-2xs">
                    <FiGitBranch size={15} />
                  </div>
                  <span className="text-[13.5px] font-semibold text-[var(--text-primary)] truncate block">
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
                <div className="border-t border-[var(--glass-border)] p-3 bg-[color-mix(in_srgb,var(--glass-card)_40%,transparent)] min-w-0">
                  <SyncView />
                </div>
              )}
            </div>

            {/* Footer Quick Tip */}
            <div className="text-center px-4 py-2 text-[11.5px] leading-relaxed text-[var(--text-muted)] break-words [overflow-wrap:anywhere]">
              {t('rsiQuickTip')}
            </div>
            </div>
          </div>
        </div>
      )}

      {/* RSI runs from its own Start control and direction panel, so the
          standard chat composer is deliberately absent. Status, approvals and
          questions still dock at the bottom when they need an answer. */}
      <div className="shrink-0 flex flex-col min-w-0 pb-3">
        {/* Error notice */}
        {chatError && !running && (
          <div className="max-w-[900px] mx-auto w-full px-4 mb-1.5">
            <div className="px-3.5 py-2 rounded-2xl bg-[color-mix(in_srgb,var(--error)_10%,transparent)] border border-[color-mix(in_srgb,var(--error)_20%,transparent)] text-[var(--error)] text-xs flex items-center justify-between gap-2 shadow-2xs anim-fade">
              <span className="min-w-0 break-words [overflow-wrap:anywhere]">{chatError}</span>
              <button onClick={clearChatError} className="text-[11px] underline opacity-70 hover:opacity-100 shrink-0 cursor-pointer">
                {t('dismiss')}
              </button>
            </div>
          </div>
        )}

        {/* Dangling request notice */}
        {danglingRequest && (
          <div className="max-w-[900px] mx-auto w-full px-4 mb-1.5">
            <div className="px-3.5 py-2 rounded-2xl bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border border-[color-mix(in_srgb,var(--warning)_25%,transparent)] text-[var(--text-primary)] text-xs flex items-center justify-between gap-2 shadow-2xs anim-fade">
              <span className="truncate">⚠️ {t('unansweredRunNotice')}</span>
              <button
                type="button"
                onClick={() => void start()}
                disabled={!canStart}
                className="px-2.5 py-0.5 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] shrink-0 cursor-pointer"
              >
                {t('continueOutput')}
              </button>
            </div>
          </div>
        )}

        {/* Continuable banner */}
        {!!activeConversationId && continuableConvId === activeConversationId && !running && !danglingRequest && (
          <div className="max-w-[900px] mx-auto w-full px-4 mb-1.5">
            <button
              type="button"
              onClick={() => void start()}
                disabled={!canStart}
              className="w-full flex items-center justify-center gap-1.5 px-3.5 py-2 rounded-2xl bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] transition-all shadow-2xs cursor-pointer"
            >
              <FiZap size={13} />
              <span>{t('continueOutput')}</span>
            </button>
          </div>
        )}

        {/* Pending Command Approval Card */}
        {pendingCommand && (
          <div className="max-w-[900px] mx-auto w-full px-4 mb-2">
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

        {/* Latest Question Prompt Card */}
        {latestQuestionMessage && (
          <div className="max-w-[900px] mx-auto w-full px-4 mb-2">
            <QuestionPromptCard
              key={latestQuestionMessage.id}
              message={latestQuestionMessage}
            />
          </div>
        )}

        {/* Compact RSI Progress & Direction Row (Identical to GoalProgressRow in Goal mode) */}
        {(orderedMessages.length > 0 || running || pendingCommand || latestQuestionMessage) && (
        <div className="max-w-[900px] mx-auto w-full px-4 mb-1.5">
          <div className="rsi-progress flex items-center gap-2.5 px-3.5 py-2 rounded-xl border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] bg-[color-mix(in_srgb,var(--glass-surface)_85%,transparent)] backdrop-blur-xl">
            <FiZap size={14} className={`text-[var(--accent)] shrink-0 ${running ? 'animate-pulse' : ''}`} />
            <div className="rsi-progress-summary flex-1 min-w-0 flex items-center gap-2">
              <span className="text-[10px] uppercase tracking-wide font-bold text-[var(--accent)] shrink-0">
                {running ? (activeStage ? `P${activeStage}` : t('rsiRunning')) : t(rsiStatusLabel(lastRun?.status ?? rsi?.status))}
              </span>
              {currentObjective ? (
                <span className="text-xs text-[var(--text-secondary)] truncate" title={currentObjective}>
                  {currentObjective}
                </span>
              ) : (
                <span className="text-xs text-[var(--text-muted)] truncate">
                  {t('rsiNoDirectionConfigured')}
                </span>
              )}
            </div>

            <div className="rsi-progress-actions flex items-center gap-1.5 shrink-0">
              <button
                type="button"
                onClick={() => setActiveTab('direction')}
                className="px-2 py-1 rounded-xl text-[11px] font-medium text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors cursor-pointer"
              >
                {t('rsiTabDirection')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('pipeline')}
                className="px-2 py-1 rounded-xl text-[11px] font-medium text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] transition-colors cursor-pointer"
              >
                {t('rsiTabPipeline')}
              </button>
              {running ? (
                <button
                  type="button"
                  onClick={stop}
                  className="p-1.5 rounded-lg text-[var(--error)] hover:bg-[color-mix(in_srgb,var(--error)_10%,transparent)] transition-colors cursor-pointer"
                  title={t('rsiStop')}
                >
                  <FiSquare size={12} />
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => void start()}
                  disabled={!canStart}
                  className="p-1.5 rounded-lg text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors disabled:opacity-40 cursor-pointer"
                  title={t('rsiStart')}
                >
                  <FiZap size={12} />
                </button>
              )}
            </div>
          </div>
        </div>
        )}

      </div>
    </div>
  );
}
