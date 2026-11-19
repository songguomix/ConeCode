import { useChatStore } from '../../stores/chat.store';
import { isHolding, useInstallGateStore } from '../../stores/installGate.store';
import { useModelStore } from '../../stores/model.store';
import { isImageFile, isValidFileName, useWorkspaceStore } from '../../stores/workspace.store';
import { REVIEW_OUTPUT_LIMIT, reviewPrompt } from '../workspace/review';

type WorkspaceCommand = Record<string, unknown>;
type WorkspaceReply = (data: Record<string, unknown>) => void;

const MAX_TEXT_BYTES = 512 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const WORKSPACE_MUTATIONS = new Set([
  'workspaceAddRoot', 'workspaceCloseRoot', 'workspaceSetRoot', 'workspaceFileAction', 'workspaceWriteFile',
  'workspaceCreateWorktree', 'workspaceOpenWorktree', 'workspaceRemoveWorktree',
]);
let workspaceMutating = false;

function stringField(value: unknown, max = 4096): string {
  return typeof value === 'string' && value.length <= max && !value.includes('\0') ? value : '';
}

function normalizePath(path: string): string {
  const slashes = path.replace(/\\/g, '/');
  return slashes.replace(/\/+$/, '') || slashes;
}

function isInWorkspace(path: string, roots: string[], allowRoot: boolean): boolean {
  const normalized = normalizePath(path);
  if (!normalized || normalized.split('/').some((part) => part === '.' || part === '..')) return false;
  return roots.some((root) => {
    const normalizedRoot = normalizePath(root);
    const prefix = normalizedRoot.endsWith('/') ? normalizedRoot : `${normalizedRoot}/`;
    return normalized === normalizedRoot ? allowRoot : normalized.startsWith(prefix);
  });
}

async function applyWorkspaceCommand(cmd: WorkspaceCommand, action: string, reply: WorkspaceReply) {
  const workspace = useWorkspaceStore.getState();
  const chat = useChatStore.getState();
  const { fs, git, worktree } = window.electronAPI;
  const roots = workspace.allRoots();
  const root = workspace.rootPath;
  const stillCurrent = () => useWorkspaceStore.getState().rootPath === root &&
    useChatStore.getState().activeConversationId === chat.activeConversationId &&
    JSON.stringify(useWorkspaceStore.getState().allRoots()) === JSON.stringify(roots);
  const fail = (error?: string) => reply({ ok: false, error: error?.slice(0, 1024) });
  const path = stringField(cmd.path);
  const dirtyTabs = () => Object.keys(useWorkspaceStore.getState().dirtyTabs);
  const hasDirtyTabsAt = () => dirtyTabs().some((tab) => isInWorkspace(tab, [path], true));
  const resolvedWorkspacePath = async (allowRoot = false) => {
    if (!isInWorkspace(path, roots, allowRoot)) return false;
    const [resolved, ...resolvedRoots] = await Promise.all([fs.realpath(path), ...roots.map((item) => fs.realpath(item))]);
    return resolved != null && isInWorkspace(resolved, resolvedRoots.filter((item): item is string => item != null), allowRoot);
  };
  const openRoot = async () => {
    if (!stillCurrent()) return fail('stale-workspace');
    if (dirtyTabs().length) return fail('unsaved-editor');
    const ok = await workspace.openFolderPath(path);
    if (ok && useChatStore.getState().activeConversationId === chat.activeConversationId) {
      await useChatStore.getState().setConversationFolder(path);
    }
    return reply({ ok, path });
  };
  const busyChat = () => {
    const current = useChatStore.getState();
    const conversationId = current.activeConversationId;
    return current.isStreaming || !!(conversationId && current.messageEdits[conversationId]) || isHolding(useInstallGateStore.getState().jobs);
  };

  if (action === 'workspaceAddRoot') {
    if (cmd.path !== undefined && (!path || !/^(\/|[a-z]:[\\/]|\\\\)/i.test(path))) return fail('invalid-path');
    const folder = path ? await fs.realpath(path) : await window.electronAPI.dialog.openFolder();
    if (path && !folder) return fail('invalid-path');
    if (!folder || !stillCurrent()) return fail();
    const result = await workspace.addRoot(folder);
    if (result.ok && useChatStore.getState().activeConversationId === chat.activeConversationId) {
      await useChatStore.getState().setConversationFolder(useWorkspaceStore.getState().rootPath);
    }
    return result.ok ? reply({ ok: true, path: result.path }) : fail(result.reason);
  }
  if (action === 'workspaceCloseRoot') {
    if (!roots.includes(path)) return fail();
    if (hasDirtyTabsAt()) return fail('unsaved-editor');
    workspace.closeRoot(path);
    return reply({ ok: true });
  }
  if (action === 'workspaceSetRoot') {
    if (!await resolvedWorkspacePath(true)) return fail();
    return openRoot();
  }
  if (action === 'workspaceSearch') {
    const query = stringField(cmd.query, 256).trim().toLocaleLowerCase();
    if (!query || !roots.length) return fail();
    const maxResults = Math.max(500, Math.floor(5000 / roots.length));
    const scans = await Promise.all(roots.map((dir) => fs.glob({ pattern: '**/*', dir, maxResults })));
    if (!stillCurrent()) return fail();
    const rootPrefixes = roots.map((item) => normalizePath(item).replace(/\/$/, '') + '/');
    const matches = scans.flatMap((scan) => scan.files).filter((file) => {
      const normalized = normalizePath(file);
      const prefix = rootPrefixes.find((item) => normalized.startsWith(item));
      return prefix && normalized.slice(prefix.length).toLocaleLowerCase().includes(query);
    });
    return reply({ ok: true, files: matches.slice(0, 100), capped: matches.length > 100 || scans.some((scan) => scan.capped) });
  }

  if (action === 'workspaceReadFile') {
    if (!await resolvedWorkspacePath()) return fail();
    const stat = await fs.stat(path);
    const image = isImageFile(path) && !/\.svg$/i.test(path);
    if (!stat?.isFile) return fail();
    if (stat.size > (image ? MAX_IMAGE_BYTES : MAX_TEXT_BYTES)) return fail('file-too-large');
    const content = image ? await fs.readFileBase64(path) : await fs.readFile(path);
    if (content == null) return fail();
    if (content.length > (image ? Math.ceil(MAX_IMAGE_BYTES / 3) * 4 + 64 : MAX_TEXT_BYTES)) return fail('file-too-large');
    if (!image && content.includes('\0')) return fail('unsupported-file');
    return reply(image ? { ok: true, image: content } : { ok: true, content });
  }
  if (action === 'workspaceWriteFile') {
    const { content, previous } = cmd;
    if (typeof content !== 'string' || typeof previous !== 'string' || !await resolvedWorkspacePath()) return fail();
    if (new TextEncoder().encode(content).length > MAX_TEXT_BYTES || previous.length > MAX_TEXT_BYTES) return fail('file-too-large');
    const status = await fs.stat(path);
    if (!status?.isFile || status.size > MAX_TEXT_BYTES || (isImageFile(path) && !/\.svg$/i.test(path))) return fail('unsupported-file');
    if (await fs.readFile(path) !== previous || hasDirtyTabsAt() || !stillCurrent()) {
      return fail('unsaved-editor');
    }
    const ok = await fs.writeFile(path, content, { expected: previous });
    if (ok && stillCurrent() && useWorkspaceStore.getState().selectedFile === path) await workspace.selectFile(path);
    return reply({ ok });
  }

  if (action === 'workspaceFileAction') {
    const operation = stringField(cmd.operation, 32);
    const isCreate = operation === 'createFile' || operation === 'createFolder';
    if (!await resolvedWorkspacePath(isCreate)) return fail();
    const stat = await fs.stat(path);
    if (!stat || !stillCurrent()) return fail();
    if (operation === 'delete') {
      if (hasDirtyTabsAt()) return fail('unsaved-editor');
      return reply({ ok: await workspace.deletePath(path, stat.isDirectory) });
    }

    const name = stringField(cmd.name, 255).trim();
    if (!isValidFileName(name) || /[/\\]/.test(name)) return fail('invalid-name');
    const normalizedPath = normalizePath(path);
    const folder = isCreate ? normalizedPath : normalizedPath.slice(0, normalizedPath.lastIndexOf('/'));
    const dest = `${folder}/${name}`;
    if (isCreate && !stat.isDirectory) return fail();
    if (dest !== normalizedPath && await fs.exists(dest)) return fail('already-exists');
    if (!stillCurrent()) return fail();
    if (operation === 'rename' && hasDirtyTabsAt()) return fail('unsaved-editor');
    const result = operation === 'createFile' ? await workspace.createFile(path, name)
      : operation === 'createFolder' ? await workspace.createFolder(path, name)
      : operation === 'rename' ? await workspace.renamePath(path, name) : null;
    return reply({ ok: !!result, path: result });
  }

  if (!root || root !== cmd.root) return fail('stale-workspace');
  switch (action) {
    case 'workspaceGitInfo': {
      const info = await git.info(root);
      if (!info.isRepo) return fail('not-a-repository');
      const branches = await git.branches(root);
      return reply({ ok: true, ...info, branches: branches.slice(0, 300) });
    }
    case 'workspaceGitDiff':
    case 'workspaceGitReview': {
      const scope = cmd.scope;
      const target = stringField(cmd.target, 240).trim();
      if (scope !== 'uncommitted' && ((scope !== 'base' && scope !== 'commit') || !target || target.startsWith('-'))) {
        return fail('invalid-revision');
      }
      if (action === 'workspaceGitReview' && ((cmd.conversationId || null) !== chat.activeConversationId || busyChat())) {
        return fail('stale-conversation');
      }
      const result = await git.review(root, { scope, target: scope === 'uncommitted' ? undefined : target });
      if (!result.ok) return fail(result.error);
      const status = (result.status || '').slice(0, REVIEW_OUTPUT_LIMIT);
      const diff = (result.diff || '').slice(0, REVIEW_OUTPUT_LIMIT);
      const truncated = (result.diff || '').length > REVIEW_OUTPUT_LIMIT || (result.status || '').length > REVIEW_OUTPUT_LIMIT;
      if (action === 'workspaceGitDiff') return reply({ ok: true, status, diff, truncated });
      const currentChat = useChatStore.getState();
      const model = useModelStore.getState().getSelectedModel();
      if (!stillCurrent() || busyChat() || !model) return fail('stale-conversation');
      if (!status.trim() && !diff.trim()) return fail('no-changes');

      const previousReviewMode = currentChat.reviewMode;
      currentChat.setReviewMode(true);
      reply({ ok: true });
      try {
        await currentChat.sendMessage(reviewPrompt(scope, result), model.providerId, model.id, { keepComposerImages: true });
      } catch (error) {
        if (stillCurrent()) useChatStore.setState({ error: error instanceof Error ? error.message : String(error) });
      } finally {
        useChatStore.getState().setReviewMode(previousReviewMode);
      }
      return;
    }
    case 'workspaceWorktrees': {
      const result = await worktree.list(root);
      if (!result.ok) return fail(result.error);
      return reply({ ok: true, currentPath: result.currentPath, worktrees: result.worktrees.slice(0, 150) });
    }
    case 'workspaceCreateWorktree': {
      const ref = stringField(cmd.ref, 240);
      const name = stringField(cmd.name, 255).trim();
      if (!ref || ref.startsWith('-')) return fail('invalid-revision');
      const result = await worktree.create(root, { ref, name });
      return result.ok ? reply({ ok: true, path: result.path }) : fail(result.error);
    }
    case 'workspaceOpenWorktree': {
      const item = (await worktree.list(root)).worktrees.find((entry) => entry.path === path);
      if (!item || !stillCurrent()) return fail('stale-workspace');
      return openRoot();
    }
    case 'workspaceRemoveWorktree': {
      const list = await worktree.list(root);
      const item = list.worktrees.find((entry) => entry.path === path);
      if (!item?.managed || item.isMain || item.path === list.currentPath || !stillCurrent()) return fail('stale-workspace');
      const result = await worktree.remove(root, path);
      return result.ok ? reply({ ok: true }) : fail(result.error);
    }
    default:
      return fail();
  }
}

export async function handleWorkspaceControl(cmd: WorkspaceCommand, reply: WorkspaceReply): Promise<void> {
  const action = stringField(cmd.action, 48);
  const mutatesWorkspace = WORKSPACE_MUTATIONS.has(action);
  if (mutatesWorkspace && workspaceMutating) {
    reply({ ok: false, error: 'workspace-busy' });
    return;
  }
  if (mutatesWorkspace) workspaceMutating = true;
  try {
    await applyWorkspaceCommand(cmd, action, reply);
  } catch (error) {
    reply({ ok: false, error: (error instanceof Error ? error.message : String(error)).slice(0, 1024) });
  } finally {
    if (mutatesWorkspace) workspaceMutating = false;
  }
}
