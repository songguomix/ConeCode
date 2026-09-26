import { useRef, useEffect, useState, useMemo, useCallback, Fragment } from 'react';
import { FiMap, FiPlay, FiEdit3, FiChevronDown, FiChevronRight } from 'react-icons/fi';
import { useChatStore, useLanguageStore, useCodeChangesStore, useWorkspaceStore, useModelStore, useSettingsStore } from '../../stores';
import { orderForDisplay } from '../../stores/chat.store';
import ChatInput from './ChatInput';
import MessageBubble from './MessageBubble';
import MessageContent from './MessageContent';
import MessageChanges from './InlineChanges';
import CommandApprovalModal from './CommandApprovalModal';
import TodoList from './TodoList';
import DiffStatPill from './DiffStatPill';
import GoalProgressRow from './GoalProgressRow';
import AgentHome from '../home/AgentHome';
import { commandsForConversation } from './approvalPresentation';

export default function ChatView() {
  const rawMessages = useChatStore((s) => s.messages);
  const activeConversationId = useChatStore((s) => s.activeConversationId);
  // This conversation's own live run — other conversations may be streaming
  // concurrently without affecting what is shown here.
  const activeRun = useChatStore((s) => (activeConversationId ? s.streamingRuns[activeConversationId] : undefined));
  const isStreaming = !!activeRun;
  const streamingContent = activeRun?.content ?? '';
  const streamingStatus = activeRun?.status ?? null;
  const streamingToolName = activeRun?.toolName ?? null;
  const error = useChatStore((s) => s.error);
  const clearError = useChatStore((s) => s.clearError);
  const { t } = useLanguageStore();
  const approvalMode = useSettingsStore((s) => s.approvalMode);
  const addChange = useCodeChangesStore((s) => s.addChange);
  const { selectedFile, fileContent } = useWorkspaceStore();
  const planMode = useChatStore((s) => s.planMode);
  const setPlanMode = useChatStore((s) => s.setPlanMode);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const [planDismissedId, setPlanDismissedId] = useState<string | null>(null);
  const [reviewCommandId, setReviewCommandId] = useState<string | null>(null);
  // Compaction hides messages from the MODEL, never from the user. They stay
  // right where they were, folded behind the summary and one click away.
  const [showCompacted, setShowCompacted] = useState(false);
  const [editingMessageId, setEditingMessageId] = useState<string | null>(null);
  const onEditMessage = useCallback((id: string) => setEditingMessageId(id), []);
  const onCancelEditMessage = useCallback(() => setEditingMessageId(null), []);
  const isEditing = rawMessages.some((m) => m.id === editingMessageId);
  useEffect(() => { setEditingMessageId(null); }, [activeConversationId]);
  const messages = useMemo(() => orderForDisplay(rawMessages), [rawMessages]);
  const compactedIds = useMemo(() => {
    const lastSummaryIdx = messages.map((m) => !!m.isSummary).lastIndexOf(true);
    return lastSummaryIdx === -1
      ? new Set<string>()
      : new Set(messages.slice(0, lastSummaryIdx).map((m) => m.id));
  }, [messages]);
  // A folded message whose approval card is still unresolved must stay visible:
  // hiding it left the agent waiting on an approval the user could not reach.
  const changes = useCodeChangesStore((s) => s.changes);
  const awaitingApproval = useMemo(
    () => new Set(changes.filter((c) => c.status === 'pending').map((c) => c.messageId).filter(Boolean) as string[]),
    [changes],
  );
  const containerRef = useRef<HTMLDivElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);
  const lastProcessedRef = useRef<string>('');
  const isNearBottomRef = useRef(true);
  const lastPendingCommandsRef = useRef<string>('');
  const visibleMessageIds = useMemo(() => new Set(messages.map((message) => message.id)), [messages]);
  const conversationCommands = useMemo(
    () => commandsForConversation(changes, activeConversationId, visibleMessageIds),
    [changes, activeConversationId, visibleMessageIds],
  );
  const pendingCommandSignature = conversationCommands
    .filter((change) => change.status === 'pending')
    .map((change) => change.id)
    .join(',');
  const reviewCommand = conversationCommands.find((change) => change.id === reviewCommandId) || null;

  // Auto-open only when the pending queue changes. Closing a still-pending
  // dialog leaves it closed until the user clicks its compact transcript row.
  useEffect(() => {
    const scopedSignature = `${activeConversationId || ''}:${pendingCommandSignature}`;
    if (scopedSignature === lastPendingCommandsRef.current) return;
    lastPendingCommandsRef.current = scopedSignature;

    // Full-auto commands execute immediately. The change briefly enters the
    // pending store state before autoApply marks it applied, so opening a modal
    // here would flash an approval dialog for an action already being executed.
    if (approvalMode === 'fullAuto') {
      if (reviewCommand) setReviewCommandId(null);
      return;
    }

    const firstPending = conversationCommands.find((change) => change.status === 'pending');
    const selectedStillPending = reviewCommand?.status === 'pending';
    if (firstPending && !selectedStillPending) setReviewCommandId(firstPending.id);
    else if (!firstPending && !reviewCommand) setReviewCommandId(null);
  }, [activeConversationId, pendingCommandSignature, conversationCommands, reviewCommand, approvalMode]);

  const checkNearBottom = () => {
    const el = containerRef.current;
    if (!el) return;
    const threshold = 150;
    isNearBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < threshold;
  };

  const scrollToBottom = () => {
    if (!isNearBottomRef.current) return;
    bottomRef.current?.scrollIntoView({ behavior: 'instant' });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    el.addEventListener('scroll', checkNearBottom, { passive: true });
    return () => el.removeEventListener('scroll', checkNearBottom);
  }, []);

  // Forced jump-to-bottom (e.g. after "Apply all"), regardless of current
  // scroll position; also re-arms the near-bottom flag so streaming keeps
  // following.
  useEffect(() => {
    const onForce = () => {
      isNearBottomRef.current = true;
      requestAnimationFrame(() => bottomRef.current?.scrollIntoView({ behavior: 'instant' }));
    };
    window.addEventListener('conecode:scrollChatBottom', onForce);
    return () => window.removeEventListener('conecode:scrollChatBottom', onForce);
  }, []);

  useEffect(() => {
    scrollToBottom();
  }, [messages, streamingContent]);

  useEffect(() => {
    const lastMsg = messages[messages.length - 1];
    if (!lastMsg || lastMsg.role !== 'assistant' || lastMsg.id === lastProcessedRef.current) return;
    lastProcessedRef.current = lastMsg.id;

    if (lastMsg.content.includes('```json')) return;

    const codeBlocks = extractCodeBlocks(lastMsg.content);
    if (codeBlocks.length > 0 && selectedFile && fileContent) {
      const newCode = codeBlocks[0];
      if (newCode !== fileContent) {
        addChange({
          kind: 'edit',
          filePath: selectedFile,
          originalCode: fileContent,
          newCode,
          description: lastMsg.content.split('```')[0].trim().slice(0, 200),
          conversationId: activeConversationId || undefined,
          messageId: lastMsg.id,
        });
      }
    }
  }, [messages]);

  const isAiSide = (m: typeof messages[number]) => !(m.role === 'user' && !m.isToolResult);
  const lastMsg = messages[messages.length - 1];
  const streamContinues = !!lastMsg && isAiSide(lastMsg);

  const showPlanApproval =
    planMode && !isStreaming && !!lastMsg &&
    lastMsg.role === 'assistant' && !lastMsg.isToolResult && !lastMsg.isQuestion &&
    !lastMsg.isLocalNotice && lastMsg.id !== planDismissedId;

  const approvePlan = async () => {
    const model = getSelectedModel();
    const providerId = lastMsg?.providerId || model?.providerId;
    const modelId = lastMsg?.modelId || model?.id;
    if (!providerId || !modelId) return;
    setPlanMode(false);
    await sendMessage(t('planApproved'), providerId, modelId);
  };

  return (
    <div className="flex-1 flex flex-col min-h-0 bg-[var(--bg-0)]">
      <div ref={containerRef} className="flex-1 overflow-y-auto py-6">
        <div className="max-w-[900px] mx-auto w-full px-4">
        {/* Nothing said yet — instead of an empty prompt, show the agent's own
            reading of the workspace and offer concrete work to start. */}
        {messages.length === 0 && <AgentHome />}

        {messages.map((msg, i) => {
          const hidden = compactedIds.has(msg.id) && !showCompacted && !awaitingApproval.has(msg.id);
          if (hidden) return null;
          return (
            <Fragment key={msg.id}>
              {/* The fold marker sits exactly where the context was compacted. */}
              {msg.isSummary && (
                <button
                  onClick={() => setShowCompacted((v) => !v)}
                  className="mt-6 w-full flex items-center gap-2 text-xs text-[var(--text-muted)] hover:text-[var(--text-secondary)] transition-colors"
                >
                  <span className="h-px flex-1 bg-[var(--border)]" />
                  {showCompacted ? <FiChevronDown size={12} /> : <FiChevronRight size={12} />}
                  <span>
                    {showCompacted ? t('hideCompacted') : t('showCompacted')} ({compactedIds.size})
                  </span>
                  <span className="h-px flex-1 bg-[var(--border)]" />
                </button>
              )}
              <MessageBubble
                message={msg}
                isContinuation={i > 0 && isAiSide(messages[i - 1]) === isAiSide(msg)}
                dimmed={compactedIds.has(msg.id)}
                editing={editingMessageId === msg.id}
                onEdit={onEditMessage}
                onCancelEdit={onCancelEditMessage}
              />
              <MessageChanges messageId={msg.id} onReviewCommand={setReviewCommandId} />
            </Fragment>
          );
        })}

        {isStreaming && (
          <div className={`${streamContinues ? 'mt-1.5' : 'mt-6'}`}>
            <div className="min-w-0">
              {streamingContent
                ? <MessageContent content={streamingContent} streaming />
                : <span className="text-[15px] text-[var(--text-muted)] animate-pulse">
                    {streamingToolName
                      ? `${t('callingTool')} ${streamingToolName}...`
                      : streamingStatus === 'thinking' ? t('thinking') + '...' : '...'}
                  </span>}
            </div>
          </div>
        )}

        {error && (
          <div className="mt-3 p-3.5 rounded-xl bg-[var(--error)]/10 border border-[var(--error)]/20 text-[var(--error)] text-sm flex items-center justify-between">
            <span>{error}</span>
            <button onClick={clearError} className="text-xs underline opacity-70 hover:opacity-100">{t('dismiss')}</button>
          </div>
        )}

        <div ref={bottomRef} />
        </div>
      </div>

      {showPlanApproval && (
        <div className="max-w-[900px] mx-auto w-full px-4 mb-1">
          <div className="flex items-center gap-2 px-4 py-2.5 rounded-xl border border-[var(--accent)]/30 bg-[var(--accent-soft)]">
            <FiMap size={14} className="text-[var(--accent)] shrink-0" />
            <span className="text-xs text-[var(--text-secondary)] flex-1 min-w-0 truncate">{t('presentPlan')}</span>
            <button
              onClick={() => setPlanDismissedId(lastMsg!.id)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs border border-[var(--border)] bg-[var(--bg-2)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors"
            >
              <FiEdit3 size={11} /> {t('keepPlanning')}
            </button>
            <button
              onClick={approvePlan}
              className="inline-flex items-center gap-1 px-3 py-1 rounded-lg text-xs bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
            >
              <FiPlay size={11} /> {t('approvePlan')}
            </button>
          </div>
        </div>
      )}

      <GoalProgressRow />

      <TodoList />

      <DiffStatPill />

      <div hidden={isEditing}>
        <ChatInput />
      </div>

      {reviewCommand && approvalMode !== 'fullAuto' && (
        <CommandApprovalModal key={reviewCommand.id} change={reviewCommand} onClose={() => setReviewCommandId(null)} />
      )}
    </div>
  );
}

function extractCodeBlocks(content: string): string[] {
  const regex = /```([\w]*)\n([\s\S]*?)```/g;
  const blocks: string[] = [];
  let match;
  while ((match = regex.exec(content)) !== null) {
    if (match[1].toLowerCase() === 'json') continue;
    blocks.push(match[2].trim());
  }
  return blocks;
}
