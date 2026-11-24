// Renderer-side bridge between the live ConeCode stores and the phone. The
// renderer stays the single source of truth (it runs the agent loop and owns
// every store); this module just (1) publishes a compact state snapshot to the
// main process whenever anything changes — fanned out to phones over SSE — and
// (2) applies commands the phone sends back into the existing store actions.
//
// No agent logic lives here; it only forwards intent to the same functions the
// desktop UI calls.

import { orderForDisplay, useChatStore } from '../../stores/chat.store';
import { checkpointRewindIndex, useCodeChangesStore } from '../../stores/codeChanges.store';
import { useTodosStore } from '../../stores/todos.store';
import { useModelStore } from '../../stores/model.store';
import { useThemeStore } from '../../stores/theme.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsStore } from '../../stores/settings.store';
import type { CodeChange } from '../../stores/codeChanges.store';
import { activeInstallLabel, isHolding, useInstallGateStore } from '../../stores/installGate.store';
import { remoteQuestion } from './questionScope';
import { requestRsiAction } from './rsiControl';
import { useUIStore } from '../../stores/ui.store';
import { activateWorkspaceView } from '../workspace/activateView';
import { isChatConversation, isRsiConversation, isUnarchivedConversation } from '../workspace/conversations';
import { rsiCanStart } from '../agents/rsiStart';
import { useComputerStore } from '../../stores/computer.store';
import { useGoalStore } from '../../stores/goal.store';
import { useLanguageStore } from '../../stores/language.store';
import { BUILTIN_COMMANDS, findCommand, parseSlashInput } from '../commands';
import { conversationCommandMode, conversationCommandNeedsModel, runConversationCommand } from '../conversationCommands';
import { buildHandoffMarkdown, handoffFilename, handoffMessages } from '../handoff/handoff';
import { remoteDesktopPanel, remoteWork } from './workbench';
import { remoteImageStudio } from './imageStudio';
import { handleWorkspaceControl } from './workspaceControl';
import { conversationPage, remoteImageAttachments, remoteMessageImage } from './conversation';

const pendingAnswers = new Set<string>();
const pendingSends = new Set<string | null>();
import { bulkApprovableChanges, changesForActiveConversation } from './approvalScope';

function currentChanges(): CodeChange[] {
  const chat = useChatStore.getState();
  return changesForActiveConversation(
    useCodeChangesStore.getState().changes,
    chat.activeConversationId,
    new Set(chat.messages.map((message) => message.id)),
  );
}

function conversationBusy(conversationId: string | null): boolean {
  const chat = useChatStore.getState();
  return pendingSends.has(null) || pendingSends.has(conversationId) ||
    !!(conversationId && (chat.streamingRuns[conversationId] || chat.messageEdits[conversationId] || pendingAnswers.has(conversationId))) ||
    isHolding(useInstallGateStore.getState().jobs);
}

function currentPlan() {
  const chat = useChatStore.getState();
  if (!chat.activeConversationId || !chat.planMode || chat.streamingRuns[chat.activeConversationId]) return null;
  const ordered = orderForDisplay(chat.messages);
  const message = ordered[ordered.length - 1];
  return message?.role === 'assistant' && !message.isToolResult && !message.isQuestion && !message.isLocalNotice
    ? message
    : null;
}

function buildSnapshot() {
  const chat = useChatStore.getState();
  const todos = useTodosStore.getState().todos;
  const changes = useCodeChangesStore.getState().changes;
  const scopedChanges = changesForActiveConversation(
    changes,
    chat.activeConversationId,
    new Set(chat.messages.map((message) => message.id)),
  );
  const modelState = useModelStore.getState();
  const model = modelState.getSelectedModel();
  // Include providerId so duplicate model ids can still select the correct
  // provider (and therefore the correct context limit).
  const models = Array.from(modelState.models.values())
    .flat()
    .map((m) => ({ id: m.id, name: m.name, providerId: m.providerId }));
  const filesByConversation = new Map<string, string[]>();
  for (const change of changes) {
    if (!change.conversationId || change.filePath.startsWith('[')) continue;
    const name = change.filePath.split('/').pop() || change.filePath;
    const files = filesByConversation.get(change.conversationId) || [];
    if (!files.includes(name)) files.push(name);
    filesByConversation.set(change.conversationId, files.slice(0, 3));
  }
  // Several conversations can run at once; the phone mirror shows the ACTIVE
  // conversation's live stream, while the conversation list flags every
  // conversation that currently has a run.
  const runningIds = Object.keys(chat.streamingRuns);
  const activeRun = chat.activeConversationId ? chat.streamingRuns[chat.activeConversationId] : undefined;
  const question = remoteQuestion(chat.messages, chat.activeConversationId);
  const activeConversation = chat.conversations.find((c) => c.id === chat.activeConversationId);
  const installLabel = activeInstallLabel(useInstallGateStore.getState().jobs);
  const { t } = useLanguageStore.getState();
  const goal = chat.activeConversationId ? useGoalStore.getState().goals[chat.activeConversationId] : undefined;
  const computer = useComputerStore.getState();
  const rsi = activeConversation?.rsi;
  const conversations = chat.conversations.map((conversation) => ({
    id: conversation.id,
    title: conversation.title,
    viewMode: isRsiConversation(conversation) ? 'rsi' : isChatConversation(conversation) ? 'chat' : 'work',
    archived: !isUnarchivedConversation(conversation),
    rootPath: conversation.rootPath,
    isRunning: runningIds.includes(conversation.id),
    changedFiles: filesByConversation.get(conversation.id) || [],
  }));
  return {
    // The desktop's resolved theme so the phone mirror matches light/dark live.
    theme: useThemeStore.getState().resolved,
    // Project root, so the phone's file browser starts at the open folder.
    rootPath: useWorkspaceStore.getState().rootPath,
    workspaceRoots: useWorkspaceStore.getState().allRoots(),
    models,
    runningConversationId: runningIds[0] ?? null,
    runningConversationIds: runningIds,
    conversations: conversations.filter((conversation) => !conversation.archived),
    archivedConversations: conversations.filter((conversation) => conversation.archived),
    activeConversationId: chat.activeConversationId,
    ...conversationPage(orderForDisplay(chat.messages)),
    isStreaming: !!activeRun,
    streamingContent: activeRun?.content ?? '',
    streamingReasoningContent: activeRun?.reasoningContent ?? '',
    streamingStatus: activeRun?.status ?? null,
    streamingToolName: activeRun?.toolName ?? null,
    streamingRetry: activeRun?.retry ?? null,
    todos: todos.map((t) => ({ content: t.content, status: t.status })),
    // Keep recent changes; only ship a command's text (file diffs would bloat
    // the snapshot — the phone shows file name + kind, not the diff body).
    changes: scopedChanges.slice(0, 60).map((c) => ({
      id: c.id,
      kind: c.kind,
      filePath: c.filePath,
      status: c.status,
      newCode: c.kind === 'exec' ? c.newCode : undefined,
      conversationId: c.conversationId,
      messageId: c.messageId,
      description: c.description,
      cwd: c.cwd,
    })),
    model: model ? { id: model.id, name: model.name, providerId: model.providerId } : null,
    reasoningEffort: chat.reasoningEffort,
    capabilities: ['uuRemote', 'workModes', 'queue', 'renameConversation', 'changeDetail', 'questions', 'remoteSettings', 'workspaceViews', 'rsiControls', 'conversationActions', 'conversationImages', 'workspaceControl', 'remoteWork', 'remoteImageStudio', 'remoteDesktopPanel'],
    error: chat.error,
    planMessageId: currentPlan()?.id ?? null,
    goal,
    slashCommands: [
      ...BUILTIN_COMMANDS.map((command) => ({ name: command.name, description: t(command.description) })),
      ...useWorkspaceStore.getState().customCommands.map(({ name, description }) => ({ name, description })),
    ],
    installLabel,
    isEditingMessage: !!(chat.activeConversationId && chat.messageEdits[chat.activeConversationId]),
    canContinue: !!chat.activeConversationId && chat.continuableConvId === chat.activeConversationId &&
      !activeRun && !chat.messageEdits[chat.activeConversationId] && installLabel === null,
    question: question ? {
      id: question.id, conversationId: question.conversationId, content: question.content,
      options: question.questionOptions || [],
      canReply: !conversationBusy(question.conversationId),
    } : null,
    viewMode: chat.agentMode === 'rsi' ? 'rsi' : useUIStore.getState().viewMode,
    rsi: rsi ? {
      ...rsi,
      canStart: !activeRun && rsiCanStart({ isMac: computer.platform === 'darwin', screenRecording: computer.screenRecording, accessibility: computer.accessibility, hasModel: !!model }),
    } : null,
    agentMode: chat.agentMode,
    planMode: chat.planMode,
    reviewMode: chat.reviewMode,
    queuedMessages: (chat.activeConversationId ? chat.queuedMessages[chat.activeConversationId] : [])?.map(
      ({ id, content, steer, steerError, images }) => ({ id, content, steer, steerError, imageCount: images?.length ?? 0 }),
    ) ?? [],
  };
}

// A cheap signature of everything EXCEPT the live streaming text. When only the
// signature is unchanged but the model is streaming, we publish a tiny `stream`
// delta instead of the whole snapshot — otherwise every token would re-send the
// full message history + model list, saturating a tunnel and making it crawl.
function structuralSig(): string {
  const chat = useChatStore.getState();
  const todos = useTodosStore.getState().todos;
  const changes = useCodeChangesStore.getState().changes;
  const scopedChanges = changesForActiveConversation(
    changes,
    chat.activeConversationId,
    new Set(chat.messages.map((message) => message.id)),
  );
  const modelState = useModelStore.getState();
  const model = modelState.getSelectedModel();
  const lastMsg = chat.messages[chat.messages.length - 1];
  // Include the available-model set so adding/removing a model on the desktop
  // pushes a fresh snapshot (otherwise the phone keeps showing deleted models).
  const allModels = Array.from(modelState.models.values()).flat();
  return [
    chat.activeConversationId,
    Object.keys(chat.streamingRuns).join(','),
    chat.conversations.map((c) => `${c.id}:${c.title}:${c.updatedAt}:${c.archivedAt}:${c.rootPath}`).join(','),
    chat.messages.length,
    lastMsg ? `${lastMsg.id}:${lastMsg.content.length}:${lastMsg.reasoning_content?.length || 0}:${lastMsg.toolCalls?.length || 0}:${lastMsg.isToolResult ? 1 : 0}:${lastMsg.toolName || ''}` : '',
    (chat.activeConversationId ? chat.streamingRuns[chat.activeConversationId]?.toolName : '') || '',
    todos.map((t) => t.status + ':' + t.content).join(','),
    scopedChanges.slice(0, 60).map((c) => c.id + ':' + c.status).join(','),
    model ? `${model.providerId}:${model.id}` : '',
    allModels.length + ':' + allModels.map((m) => `${m.providerId}:${m.id}`).join(','),
    chat.reasoningEffort,
    chat.agentMode, chat.planMode, chat.reviewMode, chat.error,
    useUIStore.getState().viewMode,
    JSON.stringify(chat.conversations.find((c) => c.id === chat.activeConversationId)?.rsi || null),
    useComputerStore.getState().screenRecording, useComputerStore.getState().accessibility,
    lastMsg?.isQuestion, JSON.stringify(lastMsg?.questionOptions || []),
    activeInstallLabel(useInstallGateStore.getState().jobs),
    chat.continuableConvId,
    JSON.stringify(chat.activeConversationId ? useGoalStore.getState().goals[chat.activeConversationId] : null),
    JSON.stringify(chat.activeConversationId ? chat.streamingRuns[chat.activeConversationId]?.retry : null),
    !!(chat.activeConversationId && chat.messageEdits[chat.activeConversationId]),
    !!(chat.activeConversationId && pendingAnswers.has(chat.activeConversationId)),
    pendingSends.has(null) || pendingSends.has(chat.activeConversationId),
    JSON.stringify(chat.activeConversationId ? chat.queuedMessages[chat.activeConversationId]?.map(
      ({ id, steer, steerError }) => [id, steer, steerError],
    ) : []),
    useThemeStore.getState().resolved,
    JSON.stringify(useWorkspaceStore.getState().allRoots()),
    JSON.stringify(useWorkspaceStore.getState().customCommands.map(({ name, description }) => [name, description])),
    useLanguageStore.getState().locale,
  ].join('|');
}

let lastSig: string | null = null;
let lastStreaming = false;
let lastMessages: ReturnType<typeof useChatStore.getState>['messages'] | undefined;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
function publishSoon() {
  const api = (window as any).electronAPI?.remote;
  if (!api) return;
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    const chat = useChatStore.getState();
    const sig = structuralSig();
    const streamingNow = !!(chat.activeConversationId && chat.streamingRuns[chat.activeConversationId]);
    try {
      if (sig !== lastSig || streamingNow !== lastStreaming || lastMessages !== chat.messages) {
        // Something material changed (new message, approval, todo, model, theme,
        // or streaming just started/stopped) → send the full snapshot.
        lastSig = sig;
        lastStreaming = streamingNow;
        lastMessages = chat.messages;
        api.publish({ type: 'state', snapshot: buildSnapshot() });
      } else if (streamingNow) {
        // Pure token growth → send only the streaming fields (of the active
        // conversation's run).
        const run = chat.activeConversationId ? chat.streamingRuns[chat.activeConversationId] : undefined;
        api.publish({
          type: 'stream',
          isStreaming: true,
          streamingContent: run?.content ?? '',
          streamingReasoningContent: run?.reasoningContent ?? '',
          streamingStatus: run?.status ?? null,
          streamingToolName: run?.toolName ?? null,
        });
      }
      // else: nothing changed → skip.
    } catch {}
  }, 120);
}

// Send a one-off reply frame back to the phone for a request carrying a `reqId`.
// Reuses the SSE fan-out; reply frames are transient (the server only replays
// the latest `state` frame), so the phone matches them by reqId.
function reply(reqId: any, data: Record<string, any>) {
  const api = (window as any).electronAPI?.remote;
  if (api && reqId) {
    try { api.publish({ type: 'reply', reqId, ...data }); } catch {}
  }
}

async function handleCommand(cmd: any) {
  if (!cmd || typeof cmd.type !== 'string') return;
  const chat = useChatStore.getState();
  const changes = useCodeChangesStore.getState();
  const fs = (window as any).electronAPI?.fs;
  switch (cmd.type) {
    case 'remoteWork':
      if (cmd.reqId) reply(cmd.reqId, remoteWork(cmd));
      break;
    case 'remoteImageStudio':
      if (cmd.reqId) reply(cmd.reqId, await remoteImageStudio(cmd));
      break;
    case 'remoteDesktopPanel':
      if (cmd.reqId) reply(cmd.reqId, remoteDesktopPanel(cmd.panel));
      break;
    case 'remoteSettings': {
      if (typeof cmd.reqId !== 'string') break;
      const { handleRemoteSettings } = await import('./settings');
      reply(cmd.reqId, await handleRemoteSettings(cmd));
      break;
    }
    case 'send': {
      const model = useModelStore.getState().getSelectedModel();
      const images = remoteImageAttachments(cmd.images);
      const conversationId = chat.activeConversationId;
      if (typeof cmd.text !== 'string' || !images || (!cmd.text.trim() && !images.length) ||
        (cmd.conversationId !== undefined && cmd.conversationId !== conversationId) || conversationBusy(conversationId)) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      // Older clients send literal text without an explicit conversation scope.
      const slash = cmd.conversationId === undefined ? null : parseSlashInput(cmd.text.trim());
      const command = slash ? findCommand(slash.name, useWorkspaceStore.getState().customCommands) : undefined;
      if ((!model && (!command || conversationCommandNeedsModel(command))) ||
        (command?.name === 'mode' && !conversationCommandMode(slash?.args ?? '')) ||
        (command?.name === 'goal' && !slash?.args.trim())) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      pendingSends.add(conversationId);
      try {
        reply(cmd.reqId, { ok: true });
        const options = { images, keepComposerImages: true };
        if (command && slash) await runConversationCommand(command, slash.args, options);
        else if (model) await chat.sendMessage(cmd.text, model.providerId, model.id, options);
      } finally {
        pendingSends.delete(conversationId);
        publishSoon();
      }
      break;
    }
    case 'answerQuestion': {
      const question = remoteQuestion(chat.messages, chat.activeConversationId);
      if (!question || cmd.id !== question.id || cmd.conversationId !== question.conversationId ||
        typeof cmd.text !== 'string' || !cmd.text.trim() || cmd.text.length > 16_384 ||
        conversationBusy(question.conversationId)) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      const model = useModelStore.getState().getSelectedModel();
      const providerId = question.providerId || model?.providerId;
      const modelId = question.modelId || model?.id;
      if (!providerId || !modelId) { reply(cmd.reqId, { ok: false }); break; }
      pendingAnswers.add(question.conversationId);
      publishSoon();
      reply(cmd.reqId, { ok: true });
      try {
        await chat.sendMessage(cmd.text.trim(), providerId, modelId, { keepComposerImages: true });
      } finally {
        pendingAnswers.delete(question.conversationId);
        publishSoon();
      }
      break;
    }
    case 'rsiControl': {
      if (chat.agentMode !== 'rsi' || cmd.conversationId !== chat.activeConversationId ||
        (cmd.action !== 'start' && cmd.action !== 'stop')) { reply(cmd.reqId, { ok: false }); break; }
      reply(cmd.reqId, { ok: requestRsiAction(cmd.conversationId, cmd.action) });
      break;
    }
    case 'rsiDirection': {
      const current = chat.conversations.find((c) => c.id === chat.activeConversationId);
      if (!current || !isRsiConversation(current) || cmd.conversationId !== current.id ||
        chat.streamingRuns[current.id] || !cmd.direction || typeof cmd.direction !== 'object') {
        reply(cmd.reqId, { ok: false }); break;
      }
      const fields = ['objective', 'priorities', 'metrics', 'scope', 'constraints'] as const;
      if (!fields.every((key) => typeof cmd.direction[key] === 'string' && cmd.direction[key].length <= 16_384)) {
        reply(cmd.reqId, { ok: false }); break;
      }
      await chat.updateRsiDirection(current.id, Object.fromEntries(fields.map((key) => [key, cmd.direction[key]])));
      reply(cmd.reqId, { ok: true });
      break;
    }
    case 'setViewMode':
      if (cmd.value === 'chat' || cmd.value === 'work' || cmd.value === 'rsi') await activateWorkspaceView(cmd.value);
      break;
    case 'setAgentMode':
      if (cmd.value === 'standard' || cmd.value === 'goal' || cmd.value === 'orchestrate') chat.setAgentMode(cmd.value);
      break;
    case 'setPlanMode':
      if (typeof cmd.value === 'boolean') chat.setPlanMode(cmd.value);
      break;
    case 'setReviewMode':
      if (typeof cmd.value === 'boolean') chat.setReviewMode(cmd.value);
      break;
    case 'renameConversation':
      if (typeof cmd.id === 'string' && typeof cmd.title === 'string' && cmd.title.trim() && cmd.title.length <= 200 && chat.conversations.some((c) => c.id === cmd.id)) {
        await chat.renameConversation(cmd.id, cmd.title.trim());
      }
      break;
    case 'enqueueMessage': {
      const model = useModelStore.getState().getSelectedModel();
      const images = remoteImageAttachments(cmd.images);
      const conversationId = chat.activeConversationId;
      if (!model || !conversationId || typeof cmd.text !== 'string' || !images || (!cmd.text.trim() && !images.length) ||
        (cmd.conversationId !== undefined && cmd.conversationId !== conversationId) ||
        chat.messageEdits[conversationId] || isHolding(useInstallGateStore.getState().jobs)) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      const accepted = chat.enqueueMessage(conversationId, cmd.text, model.providerId, model.id, images);
      reply(cmd.reqId, { ok: accepted !== 'dropped' });
      break;
    }
    case 'dequeueMessage':
      if (chat.activeConversationId && typeof cmd.id === 'string') chat.dequeueMessage(chat.activeConversationId, cmd.id);
      break;
    case 'steerQueuedMessage':
      if (chat.activeConversationId && cmd.conversationId === chat.activeConversationId && typeof cmd.id === 'string') {
        chat.steerQueuedMessage(chat.activeConversationId, cmd.id);
      }
      break;
    case 'conversationHistory': {
      if (!chat.activeConversationId || cmd.conversationId !== chat.activeConversationId || typeof cmd.beforeId !== 'string') {
        reply(cmd.reqId, { ok: false });
        break;
      }
      const page = conversationPage(orderForDisplay(chat.messages), cmd.beforeId);
      reply(cmd.reqId, page ? { ok: true, ...page } : { ok: false });
      break;
    }
    case 'conversationImage': {
      const dataUrl = chat.activeConversationId && cmd.conversationId === chat.activeConversationId && typeof cmd.id === 'string'
        ? remoteMessageImage(chat.messages, cmd.id, cmd.index)
        : null;
      reply(cmd.reqId, dataUrl ? { ok: true, dataUrl } : { ok: false });
      break;
    }
    case 'conversationHandoff': {
      const conversation = chat.conversations.find((item) => item.id === cmd.conversationId && item.id === chat.activeConversationId);
      if (!conversation) { reply(cmd.reqId, { ok: false }); break; }
      const messages = await window.electronAPI.message.list(conversation.id).catch(() => null);
      if (!messages || useChatStore.getState().activeConversationId !== conversation.id || !handoffMessages(messages).length) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      const { t } = useLanguageStore.getState();
      const selected = useModelStore.getState().getSelectedModel();
      const exportedAt = Date.now();
      const markdown = buildHandoffMarkdown({
        title: conversation.title,
        modelLabel: conversation.providerId && conversation.modelId
          ? conversation.providerId + '/' + conversation.modelId
          : (selected ? selected.providerId + '/' + selected.id : '—'),
        projectPath: conversation.rootPath || useWorkspaceStore.getState().rootPath || '',
        exportedAt,
        prompt: t('handoffPrompt'),
        howTo: t('handoffHow'),
        messages,
        includeTools: cmd.includeTools === true,
        includeToolResults: cmd.includeToolResults === true,
      });
      if (new TextEncoder().encode(markdown).length > 2_000_000) {
        reply(cmd.reqId, { ok: false, error: 'too-large' });
        break;
      }
      reply(cmd.reqId, { ok: true, filename: handoffFilename(conversation.title, exportedAt), markdown });
      break;
    }
    case 'conversationCheckpoint': {
      const id = chat.activeConversationId;
      const change = currentChanges().find((item) => item.id === cmd.id);
      if (!id || cmd.conversationId !== id || !change?.messageId || conversationBusy(id)) {
        reply(cmd.reqId, { ok: false, error: 'unavailable' });
        break;
      }
      const index = checkpointRewindIndex(chat.messages, change.messageId);
      if (index < 0) { reply(cmd.reqId, { ok: false, error: 'unavailable' }); break; }
      const removed = new Set(chat.messages.slice(index).map((message) => message.id));
      const affected = changes.changes.filter((item) => item.messageId && removed.has(item.messageId) &&
        (item.status === 'pending' || item.status === 'applied'));
      const revision = [chat.messages[chat.messages.length - 1]?.id, affected.map((item) => item.id + ':' + item.status).join(',')].join('|');
      if (cmd.action === 'preview') {
        const files = [...new Set(affected.filter((item) => item.kind !== 'exec' && item.kind !== 'computer').map((item) => item.filePath))];
        const retainedEffects = affected.filter((item) => (item.kind === 'exec' || item.kind === 'computer') && item.status === 'applied').length;
        reply(cmd.reqId, { ok: true, revision, files: files.slice(0, 25), fileCount: files.length, retainedEffects, messageCount: removed.size });
      } else if (cmd.action === 'restore' && cmd.revision === revision) {
        pendingSends.add(id);
        try {
          const result = await changes.revertToMessage(change.messageId);
          reply(cmd.reqId, { ok: result.success, error: result.error });
        } catch (error) {
          reply(cmd.reqId, { ok: false, error: String(error) });
        } finally {
          pendingSends.delete(id);
          publishSoon();
        }
      } else {
        reply(cmd.reqId, { ok: false, error: 'stale' });
      }
      break;
    }
    case 'undoConversationChange': {
      const change = currentChanges().find((item) => item.id === cmd.id);
      if (!chat.activeConversationId || cmd.conversationId !== chat.activeConversationId ||
          !change || change.status !== 'applied' || change.kind === 'exec' || change.kind === 'computer') {
        reply(cmd.reqId, { ok: false });
        break;
      }
      const result = await changes.revertChange(change.id);
      reply(cmd.reqId, { ok: result.success, error: result.error });
      break;
    }
    case 'setConversationArchived': {
      const conversation = chat.conversations.find((item) => item.id === cmd.id);
      if (conversation && typeof cmd.archived === 'boolean' && !chat.streamingRuns[conversation.id] && !chat.messageEdits[conversation.id]) {
        await chat.setConversationArchived(conversation.id, cmd.archived);
      }
      break;
    }
    case 'editConversationMessage':
    case 'resendConversationMessage': {
      const conversationId = chat.activeConversationId;
      const message = chat.messages.find((item) => item.id === cmd.id && item.conversationId === conversationId);
      if (!conversationId || conversationId !== cmd.conversationId || !message || message.role !== 'user' ||
        message.isToolResult || message.isLocalNotice || chat.messageEdits[conversationId] ||
        isHolding(useInstallGateStore.getState().jobs)) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      if (cmd.type === 'resendConversationMessage') {
        reply(cmd.reqId, { ok: true });
        await chat.resendMessage(message.id);
        break;
      }
      const model = useModelStore.getState().getSelectedModel();
      if (!model || typeof cmd.text !== 'string' || !cmd.text.trim()) {
        reply(cmd.reqId, { ok: false });
        break;
      }
      reply(cmd.reqId, { ok: true });
      await chat.editMessage(message.id, cmd.text, model.providerId, model.id);
      break;
    }
    case 'continueConversation': {
      const conversationId = chat.activeConversationId;
      if (conversationId && cmd.conversationId === conversationId && chat.continuableConvId === conversationId) {
        await chat.continueGeneration(conversationId);
      }
      break;
    }
    case 'compactConversation': {
      const model = useModelStore.getState().getSelectedModel();
      if (model && chat.activeConversationId && cmd.conversationId === chat.activeConversationId &&
        !chat.streamingRuns[chat.activeConversationId] && !chat.messageEdits[chat.activeConversationId] &&
        !isHolding(useInstallGateStore.getState().jobs)) {
        await chat.compactConversation(model.providerId, model.id);
      }
      break;
    }
    case 'clearConversationError':
      if (cmd.conversationId === chat.activeConversationId) chat.clearError();
      break;
    case 'approveConversationPlan': {
      if (!chat.activeConversationId || cmd.conversationId !== chat.activeConversationId || conversationBusy(chat.activeConversationId)) break;
      const plan = currentPlan();
      if (!plan || cmd.id !== plan.id) break;
      const model = useModelStore.getState().getSelectedModel();
      const providerId = plan.providerId || model?.providerId;
      const modelId = plan.modelId || model?.id;
      if (!providerId || !modelId) break;
      pendingSends.add(chat.activeConversationId);
      try {
        chat.setPlanMode(false);
        await chat.sendMessage(useLanguageStore.getState().t('planApproved'), providerId, modelId, { keepComposerImages: true });
      } finally {
        pendingSends.delete(chat.activeConversationId);
        publishSoon();
      }
      break;
    }
    case 'conversationGoal': {
      const id = chat.activeConversationId;
      if (!id || cmd.conversationId !== id) break;
      const goals = useGoalStore.getState();
      const goal = goals.goals[id];
      if (!goal) break;
      if (cmd.action === 'pause' && goal.status === 'running') {
        goals.setStatus(id, 'paused');
        if (chat.streamingRuns[id]) chat.stopGeneration(id);
      } else if (cmd.action === 'clear') {
        if (chat.streamingRuns[id]) chat.stopGeneration(id);
        goals.clearGoal(id);
      } else if (cmd.action === 'edit' && goal.status !== 'completed' &&
        typeof cmd.text === 'string' && cmd.text.trim() && cmd.text.length <= 32_000) {
        goals.updateGoal(id, cmd.text.trim());
        const model = useModelStore.getState().getSelectedModel();
        if (model && !conversationBusy(id)) {
          const prompt = useLanguageStore.getState().t('goalUpdatedPrompt');
          await chat.sendMessage(prompt + ' ' + cmd.text.trim(), model.providerId, model.id, { keepComposerImages: true });
        }
      } else if (cmd.action === 'resume' && goal.status === 'paused' && !conversationBusy(id)) {
        const model = useModelStore.getState().getSelectedModel();
        if (!model) break;
        goals.setStatus(id, 'running');
        await chat.sendMessage(useLanguageStore.getState().t('goalResumePrompt'), model.providerId, model.id, { keepComposerImages: true });
      }
      break;
    }
    case 'changeDetail': {
      const change = currentChanges().find((c) => c.id === cmd.id);
      reply(cmd.reqId, change ? { ok: true, originalCode: change.originalCode, newCode: change.newCode } : { ok: false });
      break;
    }
    case 'stop':
      chat.stopGeneration();
      break;
    case 'switchConversation':
      if (cmd.id) await chat.setActiveConversation(cmd.id);
      break;
    case 'newConversation': {
      const model = useModelStore.getState().getSelectedModel();
      if (chat.agentMode === 'rsi') {
        await chat.newRsiConversation(model?.providerId || '', model?.id || '');
      } else {
        await chat.newConversation(model?.providerId || '', model?.id || '');
      }
      break;
    }
    case 'deleteConversation':
      if (cmd.id) await chat.deleteConversation(cmd.id);
      break;
    case 'setModel':
      if (cmd.id) useModelStore.getState().selectModel(cmd.id, cmd.providerId);
      break;
    case 'setReasoningEffort':
      if (cmd.value === 'auto' || cmd.value === 'low' || cmd.value === 'medium' || cmd.value === 'high') {
        chat.setReasoningEffort(cmd.value);
      }
      break;
    case 'approve':
      if (cmd.id && currentChanges().some((change) => change.id === cmd.id && change.status === 'pending')) {
        await changes.applyChange(cmd.id);
      }
      break;
    case 'reject':
      if (cmd.id && currentChanges().some((change) => change.id === cmd.id && change.status === 'pending')) {
        await changes.revertChange(cmd.id);
      }
      break;
    case 'approveAll': {
      // Commands always remain one-by-one decisions, just like the desktop
      // approval dialog. Bulk approval is for file changes in this chat only.
      const pending = bulkApprovableChanges(currentChanges());
      for (const c of pending) await useCodeChangesStore.getState().applyChange(c.id);
      break;
    }
    case 'rejectAll': {
      const pending = bulkApprovableChanges(currentChanges());
      for (const c of pending) await useCodeChangesStore.getState().revertChange(c.id);
      break;
    }

    // ---- File browser / editor / terminal (request → reply by reqId) ----
    case 'workspaceControl':
      if (cmd.reqId) await handleWorkspaceControl(cmd, (data) => reply(cmd.reqId, data));
      break;
    case 'listDir': {
      const path = String(cmd.path || '');
      const entries = path ? await fs?.readDir(path) : [];
      reply(cmd.reqId, { ok: true, path, entries: entries || [] });
      break;
    }
    case 'readFile': {
      const path = String(cmd.path || '');
      const content = path ? await fs?.readFile(path) : null;
      reply(cmd.reqId, { ok: content !== null && content !== undefined, path, content: content ?? '' });
      break;
    }
    case 'writeFile': {
      const path = String(cmd.path || '');
      const ok = path ? await fs?.writeFile(path, String(cmd.content ?? '')) : false;
      if (ok) {
        const workspace = useWorkspaceStore.getState();
        // Keep both tree and open editor consistent with a save made from phone.
        if (workspace.selectedFile === path) await workspace.selectFile(path);
        else await workspace.refreshFiles().catch(() => {});
      }
      reply(cmd.reqId, { ok: !!ok, path });
      break;
    }
    case 'uploadFile': {
      // Phone → desktop upload: save base64 content under <root>/.conecode/uploads.
      const root = useWorkspaceStore.getState().rootPath;
      if (!root) { reply(cmd.reqId, { ok: false, error: 'no folder open' }); break; }
      const safe = String(cmd.name || 'upload.bin').replace(/[/\\]/g, '_').replace(/^\.+/, '');
      const dest = `${root}/.conecode/uploads/${safe}`;
      const ok = await fs?.writeFileBase64(dest, String(cmd.data || ''));
      if (ok) useWorkspaceStore.getState().refreshFiles().catch(() => {});
      reply(cmd.reqId, { ok: !!ok, path: dest });
      break;
    }
    case 'exec': {
      const command = String(cmd.command || '');
      const cwd = cmd.cwd ? String(cmd.cwd) : (useWorkspaceStore.getState().rootPath || undefined);
      const settings = useSettingsStore.getState();
      const r = command
        ? await (window as any).electronAPI?.exec?.run(command, cwd, {
            mode: settings.sandboxMode,
            allowNetwork: settings.sandboxAllowNetwork,
          })
        : { success: false, stdout: '', stderr: 'empty command', exitCode: 1 };
      reply(cmd.reqId, { ok: !!r?.success, stdout: r?.stdout || '', stderr: r?.stderr || '', exitCode: r?.exitCode ?? 0, cwd: cwd || '' });
      break;
    }
    case 'openFolder': {
      let path: string | null = cmd.path ? String(cmd.path) : null;
      // No path → ask on the desktop (native dialog).
      if (!path) path = await (window as any).electronAPI?.dialog?.openFolder();
      let ok = false;
      if (path) {
        // Same path as the desktop's Open Folder: load the tree/config and bind
        // the folder to the active conversation (persisted across restarts).
        ok = await useWorkspaceStore.getState().openFolderPath(path).catch(() => false);
        if (ok) await useChatStore.getState().setConversationFolder(path);
        publishSoon();
      }
      reply(cmd.reqId, { ok, path: path || '' });
      break;
    }
  }
}

let started = false;
export function initRemoteBridge() {
  if (started) return;
  started = true;
  // Any store change → republish (debounced).
  useChatStore.subscribe(publishSoon);
  useCodeChangesStore.subscribe(publishSoon);
  useTodosStore.subscribe(publishSoon);
  useModelStore.subscribe(publishSoon);
  useThemeStore.subscribe(publishSoon);
  useWorkspaceStore.subscribe(publishSoon);
  useUIStore.subscribe((state, previous) => {
    if (state.viewMode !== previous.viewMode) publishSoon();
  });
  useComputerStore.subscribe(publishSoon);
  useInstallGateStore.subscribe(publishSoon);
  useGoalStore.subscribe(publishSoon);
  useLanguageStore.subscribe(publishSoon);
  (window as any).electronAPI?.remote?.onCommand((cmd: any) => {
    void handleCommand(cmd).catch(() => reply(cmd?.reqId, { ok: false, error: 'Desktop operation failed' }));
  });
  publishSoon();
}
