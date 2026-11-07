// In-memory RSI harness: no model requests, shell commands, or filesystem writes.
// Query flags: ?locale=en&theme=dark&running=1&history=1&failSave=1
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import RsiView from '../src/components/rsi/RsiView';
import RsiConversationList from '../src/components/rsi/RsiConversationList';
import AppShell from '../src/components/layout/AppShell';
import ImageGenPluginView from '../src/components/plugins/ImageGenPluginView';
import GithubReleaseView from '../src/components/plugins/GithubReleaseView';
import { useChatStore } from '../src/stores/chat.store';
import { useComputerStore } from '../src/stores/computer.store';
import { useLanguageStore, type Locale } from '../src/stores/language.store';
import { useModelStore } from '../src/stores/model.store';
import { useProviderStore } from '../src/stores/provider.store';
import { usePluginStore } from '../src/stores/plugin.store';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useUIStore } from '../src/stores/ui.store';
import { useThemeStore } from '../src/stores/theme.store';
import { useAgendaStore } from '../src/stores/agenda.store';
import { defaultRsiState } from '../src/core/agents/rsiConversation';
import type { AIModel, Conversation, Message } from '../src/types';

const params = new URLSearchParams(location.search);
const workbench = location.pathname.endsWith('/workbench.html');
const locale = params.get('locale') || 'zh';
if (['zh', 'zhHant', 'en', 'ja'].includes(locale)) useLanguageStore.setState({ locale: locale as Locale });
document.documentElement.classList.toggle('dark', params.get('theme') === 'dark');
useThemeStore.setState({ theme: params.get('theme') === 'dark' ? 'dark' : 'light', resolved: params.get('theme') === 'dark' ? 'dark' : 'light' });
const now = Date.now();
const root = '/preview/conecode';
const computerStatus = { enabled: false, supported: true, platform: 'darwin', accessibility: true, screenRecording: true, geometry: null };
const files = new Map<string, string>();
const terminalListeners = new Set<(event: { id: string; data: string }) => void>();
(window as any).electronAPI = {
  window: { minimize: () => {}, maximize: () => {}, close: () => {} },
  app: { getSystemInfo: async () => ({ platform: 'darwin', homeDir: '/preview', appVersion: 'preview' }) },
  settings: { get: async () => ({}), update: async () => ({}) },
  mcp: { listServers: async () => [], listTools: async () => [], getConfig: async () => ({ mcpServers: {} }) },
  git: {
    info: async () => ({ isRepo: true, branch: 'preview', dirty: 0 }),
    status: async () => '', diff: async () => '',
  },
  terminal: {
    spawn: (id: string) => { window.setTimeout(() => terminalListeners.forEach((listener) => listener({ id, data: 'Preview terminal · commands are not executed.\n' })), 20); },
    kill: () => {},
    write: (id: string) => { terminalListeners.forEach((listener) => listener({ id, data: 'Simulated response: command received.\n' })); },
    onData: (listener: (event: { id: string; data: string }) => void) => { terminalListeners.add(listener); return () => terminalListeners.delete(listener); },
    onExit: () => () => {},
  },
  computer: {
    status: async () => ({ ...computerStatus }),
    setEnabled: async (enabled: boolean) => Object.assign(computerStatus, { enabled }),
    requestPermissions: async () => ({ ...computerStatus }),
    screenshot: async () => null,
  },
  fs: {
    readFile: async (path: string) => files.get(path) ?? null,
    writeFile: async (path: string, content: string) => { files.set(path, content); },
    createDir: async () => true,
    glob: async () => ({ files: [], capped: false }),
    search: async () => ({ matches: [], capped: false }),
    readDir: async () => [],
    exists: async (path: string) => files.has(path),
  },
  skill: { list: async () => ({ global: [], project: [] }) },
  dialog: { openFolder: async () => null, openFile: async () => null },
};
useComputerStore.setState(computerStatus);
useWorkspaceStore.setState({ rootPath: root, fileList: [] });
useAgendaStore.setState({
  scanWorkspace: async () => useAgendaStore.getState().scan,
  loadCached: () => {}, findWork: async () => {}, generatedAt: now,
  scan: { rootPath: root, scannedAt: now, git: { isRepo: true, branch: 'preview', dirty: 3 }, statusText: '', diffText: '', todoComments: [], scripts: ['test', 'build', 'typecheck'], projectName: 'conecode', readmeHead: '', hasTests: true, fileCount: 128, languages: ['TypeScript', 'CSS'] },
  tasks: [
    { id: 'layout', title: '整理工作台布局', kind: 'refactor', effort: 'medium', risk: 'low', rationale: '改善侧栏、编辑器与对话区之间的空间分配。', prompt: '整理布局。', files: ['src/components/layout/AppShell.tsx'] },
    { id: 'rsi', title: '验证 RSI 暂停与恢复', kind: 'test', effort: 'quick', risk: 'low', rationale: '确认审批后延续验证记录，避免重复执行。', prompt: '验证 RSI。', files: ['src/core/agents/rsiRuntime.ts'] },
    { id: 'settings', title: '完善设置表单', kind: 'feature', effort: 'medium', risk: 'low', rationale: '让长字段、说明与操作按钮在窄窗口下保持清晰。', prompt: '完善设置。', files: ['src/components/provider/SettingsModal.tsx'] },
  ],
});
usePluginStore.setState({ disabled: ['github-sync'], setEnabled: () => {} });
const models = ['Preview Reasoning', 'Preview Fast'].map((name, index): AIModel => ({
  id: `preview-${index}`, name, providerId: 'preview', supportsText: true,
  supportsVision: true, supportsFunctionCalling: true, supportsReasoning: true,
  supportsImageGeneration: false, supportsAudioInput: false, supportsAudioOutput: false,
  contextWindow: 128000, maxOutputTokens: 8192, enabled: true,
}));
useModelStore.setState({ models: new Map([['preview', models]]), selectedModelId: models[0].id, selectedProviderId: 'preview' });
useProviderStore.setState({ providers: [{ id: 'preview', name: 'Local preview', type: 'openai', baseUrl: '', apiKey: '', defaultModel: models[0].id, timeout: 60000, enabled: true, createdAt: now, updatedAt: now }] });

const conversations: Conversation[] = [
  { id: 'rsi-preview', title: '前端质量与 RSI 迭代', providerId: 'preview', modelId: models[0].id, rootPath: root, createdAt: now, updatedAt: now, agentMode: 'rsi', rsi: {
    ...defaultRsiState(), directionConfig: {
      objective: '保留现有风格，修复界面缺陷，让 RSI 的状态、验证与执行更加可靠。',
      priorities: 'P0：修复状态与异步竞态\nP1：整理布局和键盘操作',
      metrics: '类型检查通过；相关回归测试通过；窄窗口内容完整可用',
      scope: 'src/components/, src/core/agents/', constraints: '保持公共 API 与已有交互一致。',
    },
  } },
  { id: 'rsi-second', title: 'A separate conversation with a long title to verify truncation', providerId: 'preview', modelId: models[0].id, rootPath: root, createdAt: now - 60000, updatedAt: now - 60000, agentMode: 'rsi', rsi: defaultRsiState() },
];
const history: Record<string, Message[]> = {
  'rsi-preview': params.has('history') ? Array.from({ length: 16 }, (_, index) => ({
    id: `message-${index}`, conversationId: 'rsi-preview', role: index % 2 ? 'assistant' : 'user',
    content: index % 2 ? 'Phase A: 正在核对界面的状态、边界与布局。\n\n保留当前设计，并对实际缺陷补充回归验证。' : '请检查界面和 RSI 的执行流程。', createdAt: now - (16 - index) * 10000,
  })) : [],
  'rsi-second': [],
};

const simulateRun = async (content?: string) => {
  const state = useChatStore.getState();
  const id = state.activeConversationId!;
  if (content) history[id] = [...(history[id] ?? []), { id: `user-${Date.now()}`, conversationId: id, role: 'user', content, createdAt: Date.now() }];
  useChatStore.setState({
    messages: history[id],
    streamingRuns: { ...state.streamingRuns, [id]: { content: 'Phase A: 正在建立可复现的验证基线。', reasoningContent: '', status: 'writing', toolName: null, retry: null } },
    conversations: state.conversations.map((conv) => conv.id !== id ? conv : {
      ...conv, rsi: { ...conv.rsi!, status: 'running', runs: [...conv.rsi!.runs, { id: `run-${Date.now()}`, status: 'running', iteration: 1, result: null, createdAt: Date.now() - 65000, updatedAt: Date.now() }] },
    }),
  });
};
useChatStore.setState({
  conversations, activeConversationId: conversations[0].id, agentMode: 'rsi', messages: history['rsi-preview'], streamingRuns: {},
  sendMessage: async (content) => { await simulateRun(content); },
  continueGeneration: async () => { await simulateRun(); },
  stopGeneration: (conversationId) => {
    const state = useChatStore.getState();
    const id = conversationId ?? state.activeConversationId;
    const runs = { ...state.streamingRuns };
    if (id) delete runs[id];
    useChatStore.setState({ streamingRuns: runs, conversations: state.conversations.map((conv) => conv.id !== id ? conv : {
      ...conv, rsi: { ...conv.rsi!, status: 'idle', runs: conv.rsi!.runs.map((run) => run.status === 'running' ? { ...run, status: 'stopped', updatedAt: Date.now() } : run) },
    }) });
  },
  setActiveConversation: async (id) => { useChatStore.setState({ activeConversationId: id, messages: history[id] ?? [] }); },
  updateRsiDirection: async (id, patch) => {
    await new Promise((resolve) => window.setTimeout(resolve, 500));
    if (params.has('failSave')) throw new Error('Preview: save failed; the draft is preserved.');
    useChatStore.setState((state) => ({ conversations: state.conversations.map((conv) => conv.id === id ? { ...conv, rsi: { ...conv.rsi!, directionConfig: { ...conv.rsi!.directionConfig, ...patch } } } : conv) }));
  },
  renameConversation: async (id, title) => { useChatStore.setState((state) => ({ conversations: state.conversations.map((conv) => conv.id === id ? { ...conv, title } : conv) })); },
  deleteConversation: async (id) => { useChatStore.setState((state) => ({ conversations: state.conversations.filter((conv) => conv.id !== id), activeConversationId: state.activeConversationId === id ? null : state.activeConversationId, messages: state.activeConversationId === id ? [] : state.messages })); },
  createRsiConversation: async () => {
    const id = `preview-${Date.now()}`;
    useChatStore.setState((state) => ({ conversations: [{ ...conversations[1], id, title: 'New RSI conversation', rsi: defaultRsiState(), createdAt: Date.now(), updatedAt: Date.now() }, ...state.conversations], activeConversationId: id, messages: [] }));
    history[id] = [];
    return id;
  },
  // Preview mirror of the real reuse rule: keep the blank conversation that is
  // already on screen instead of stacking another fixture row.
  newConversation: async (providerId, modelId, folderPath) => {
    const state = useChatStore.getState();
    if (state.activeConversationId && state.messages.length === 0) return state.activeConversationId;
    const id = `preview-${Date.now()}`;
    const rootPath = folderPath !== undefined ? folderPath : null;
    useChatStore.setState((state) => ({
      conversations: [{
        ...conversations[0], id, title: 'New Chat', providerId, modelId, rootPath,
        isChatMode: rootPath == null, agentMode: 'standard', rsi: undefined,
        createdAt: Date.now(), updatedAt: Date.now(),
      }, ...state.conversations],
      activeConversationId: id,
      messages: [],
    }));
    history[id] = [];
    return id;
  },
  newRsiConversation: async (providerId, modelId) => {
    const state = useChatStore.getState();
    if (state.activeConversationId) {
      const active = state.conversations.find((conv) => conv.id === state.activeConversationId);
      if (active?.agentMode === 'rsi' && state.messages.length === 0) return active.id;
    }
    const id = `preview-${Date.now()}`;
    useChatStore.setState((state) => ({
      conversations: [{
        ...conversations[1], id, title: 'New RSI conversation', providerId, modelId,
        rsi: defaultRsiState(), createdAt: Date.now(), updatedAt: Date.now(),
      }, ...state.conversations],
      activeConversationId: id,
      messages: [],
    }));
    history[id] = [];
    return id;
  },
});
if (params.has('running')) void simulateRun();
if (workbench) {
  const sourcePath = `${root}/src/example.ts`;
  const source = 'interface Project {\n  name: string;\n  status: "ready" | "running";\n}\n\nexport function describeProject(project: Project): string {\n  return `${project.name}: ${project.status}`;\n}\n';
  files.set(sourcePath, source);
  useWorkspaceStore.setState({
    selectedFile: params.get('editor') === '0' ? null : sourcePath,
    openTabs: [sourcePath], fileContent: source, dirtyTabs: {},
    files: [{ name: 'src', path: `${root}/src`, type: 'directory', expanded: true, children: [{ name: 'example.ts', path: sourcePath, type: 'file' }] }],
  });
  useChatStore.setState((state) => ({
    agentMode: params.get('mode') === 'rsi' ? 'rsi' : 'standard',
    conversations: state.conversations.map((conv) => ({ ...conv, agentMode: params.get('mode') === 'rsi' ? 'rsi' : 'standard' })),
    messages: params.has('empty') ? [] : params.get('mode') === 'rsi' ? state.messages : [
      { id: 'work-user', conversationId: 'rsi-preview', role: 'user', content: '保持现在的风格，整理界面布局和细节。', createdAt: now - 120000 },
      { id: 'work-assistant', conversationId: 'rsi-preview', role: 'assistant', content: '保留当前配色与玻璃卡片样式，修复窄窗口下的布局与交互。\n\n- 侧栏与编辑器支持调整尺寸\n- 终端保持独立滚动\n- 对话输入始终可用\n\n```ts\nconst status = "ready";\n```', createdAt: now - 60000 },
    ],
  }));
  useUIStore.setState({
    viewMode: params.get('view') === 'chat' ? 'chat' : 'work', sidebarOpen: params.get('sidebar') !== '0', terminalOpen: params.get('terminal') !== '0',
    settingsOpen: params.has('settings'), previewOpen: params.get('panel') === 'preview', computerOpen: params.get('panel') === 'computer', remoteOpen: false,
    worktreesOpen: false, backgroundOpen: false, reviewOpen: false, changedFilesOpen: false,
    sidebarWidthPx: 260, editorWidthPct: 45, terminalHeightPx: 220,
  });
}
ReactDOM.createRoot(document.getElementById('root')!).render(
  params.get('screen') ? <div className="h-screen overflow-y-auto p-4 bg-[var(--bg-0)]"><div className="max-w-[1120px] mx-auto">
    {params.get('screen') === 'image' ? <ImageGenPluginView /> : <GithubReleaseView />}
  </div></div> : workbench ? <AppShell /> : <div className="h-screen min-w-0 flex bg-[var(--bg-0)] text-[var(--text-primary)]"><RsiConversationList /><RsiView /></div>,
);
