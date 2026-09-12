// Renderer-side bridge between the live ConeCode stores and the phone. The
// renderer stays the single source of truth (it runs the agent loop and owns
// every store); this module just (1) publishes a compact state snapshot to the
// main process whenever anything changes — fanned out to phones over SSE — and
// (2) applies commands the phone sends back into the existing store actions.
//
// No agent logic lives here; it only forwards intent to the same functions the
// desktop UI calls.

import { useChatStore } from '../../stores/chat.store';
import { useCodeChangesStore } from '../../stores/codeChanges.store';
import { useTodosStore } from '../../stores/todos.store';
import { useModelStore } from '../../stores/model.store';
import { useThemeStore } from '../../stores/theme.store';
import { useWorkspaceStore } from '../../stores/workspace.store';
import { useSettingsStore } from '../../stores/settings.store';
import type { CodeChange } from '../../stores/codeChanges.store';
import { bulkApprovableChanges, changesForActiveConversation } from './approvalScope';

function currentChanges(): CodeChange[] {
  const chat = useChatStore.getState();
  return changesForActiveConversation(
    useCodeChangesStore.getState().changes,
    chat.activeConversationId,
    new Set(chat.messages.map((message) => message.id)),
  );
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
  return {
    // The desktop's resolved theme so the phone mirror matches light/dark live.
    theme: useThemeStore.getState().resolved,
    // Project root, so the phone's file browser starts at the open folder.
    rootPath: useWorkspaceStore.getState().rootPath,
    models,
    runningConversationId: runningIds[0] ?? null,
    runningConversationIds: runningIds,
    conversations: chat.conversations.map((c) => ({
      id: c.id,
      title: c.title,
      isRunning: runningIds.includes(c.id),
      changedFiles: filesByConversation.get(c.id) || [],
    })),
    activeConversationId: chat.activeConversationId,
    // Cap history so a long conversation doesn't make every frame huge over a
    // (possibly cross-region) tunnel — the phone is a live mirror, not an archive.
    messages: chat.messages.slice(-50).map((m) => ({
      id: m.id,
      role: m.role,
      content: m.content,
      isToolResult: m.isToolResult,
      isLocalNotice: m.isLocalNotice,
      reasoningContent: m.reasoning_content,
      toolCallId: m.toolCallId,
      toolName: m.toolName,
      isSummary: m.isSummary,
      summaryUpToId: m.summaryUpToId,
      // Native tool calls have no text body — send the names so a tool-only
      // turn shows what the agent did instead of an empty bubble.
      toolCalls: m.toolCalls?.map((tc) => ({ id: tc.id, name: tc.name })),
      thinkingTime: m.thinkingTime,
      tokensUsed: m.tokensUsed,
    })),
    isStreaming: chat.isStreaming,
    streamingContent: activeRun?.content ?? '',
    streamingReasoningContent: activeRun?.reasoningContent ?? '',
    streamingStatus: activeRun?.status ?? null,
    streamingToolName: activeRun?.toolName ?? null,
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
    chat.conversations.length,
    chat.conversations.map((c) => `${c.id}:${c.title}:${c.updatedAt}`).join(','),
    chat.messages.length,
    lastMsg ? `${lastMsg.id}:${lastMsg.content.length}:${lastMsg.reasoning_content?.length || 0}:${lastMsg.toolCalls?.length || 0}:${lastMsg.isToolResult ? 1 : 0}:${lastMsg.toolName || ''}` : '',
    (chat.activeConversationId ? chat.streamingRuns[chat.activeConversationId]?.toolName : '') || '',
    todos.map((t) => t.status + ':' + t.content).join(','),
    scopedChanges.slice(0, 60).map((c) => c.id + ':' + c.status).join(','),
    model ? `${model.providerId}:${model.id}` : '',
    allModels.length + ':' + allModels.map((m) => `${m.providerId}:${m.id}`).join(','),
    chat.reasoningEffort,
    useThemeStore.getState().resolved,
    useWorkspaceStore.getState().rootPath || '',
  ].join('|');
}

let lastSig: string | null = null;
let lastStreaming = false;
let publishTimer: ReturnType<typeof setTimeout> | null = null;
function publishSoon() {
  const api = (window as any).electronAPI?.remote;
  if (!api) return;
  if (publishTimer) return;
  publishTimer = setTimeout(() => {
    publishTimer = null;
    const chat = useChatStore.getState();
    const sig = structuralSig();
    const streamingNow = chat.isStreaming;
    try {
      if (sig !== lastSig || streamingNow !== lastStreaming) {
        // Something material changed (new message, approval, todo, model, theme,
        // or streaming just started/stopped) → send the full snapshot.
        lastSig = sig;
        lastStreaming = streamingNow;
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
    case 'send': {
      const model = useModelStore.getState().getSelectedModel();
      if (!model || !cmd.text) return;
      await chat.sendMessage(String(cmd.text), model.providerId, model.id);
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
      await chat.createConversation(model?.providerId || '', model?.id || '');
      break;
    }
    case 'deleteConversation':
      if (cmd.id) await chat.deleteConversation(cmd.id);
      break;
    case 'setModel':
      if (cmd.id) useModelStore.getState().selectModel(cmd.id, cmd.providerId);
      break;
    case 'setReasoningEffort':
      if (cmd.value === 'low' || cmd.value === 'medium' || cmd.value === 'high') {
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
  (window as any).electronAPI?.remote?.onCommand(handleCommand);
  publishSoon();
}
