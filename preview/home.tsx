// Visual harness for AgentHome: stubs the preload bridge and seeds the stores
// with realistic data so the layout can be checked without Electron or a model.
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import AgentHome from '../src/components/home/AgentHome';
import { useAgendaStore } from '../src/stores/agenda.store';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useChatStore } from '../src/stores/chat.store';
import { useModelStore } from '../src/stores/model.store';
import { useAutopilotStore } from '../src/stores/autopilot.store';
import { FALLBACK_IDEAS } from '../src/core/agenda/newProject';

const ROOT = '/Users/dev/conecode';
const TODO_MSG = '```json\n' + JSON.stringify({
  action: 'update_todos',
  todos: [
    { content: 'Verify tool calling against a live provider', status: 'in_progress' },
    { content: 'Refresh the Windows installer', status: 'pending' },
    { content: 'Package the dmg', status: 'completed' },
  ],
}) + '\n```';

(window as any).electronAPI = {
  git: {
    info: async () => ({ isRepo: true, branch: 'main', dirty: 3 }),
    status: async () => ' M src/stores/chat.store.ts\n M electron/remote/mobileClient.ts',
    diff: async () => '--- a/src/stores/chat.store.ts\n+++ b/src/stores/chat.store.ts',
  },
  fs: {
    search: async () => [
      { file: ROOT + '/src/core/mcp/client.ts', line: 12, text: '// FIXME: tools do not refresh on restart' },
      { file: ROOT + '/src/stores/chat.store.ts', line: 880, text: '// TODO: split this loop out' },
    ],
    glob: async () => [ROOT + '/src/a.ts', ROOT + '/src/b.tsx', ROOT + '/src/app.css', ROOT + '/main.py'],
    readFile: async (p: string) =>
      p.endsWith('package.json') ? '{"name":"conecode","scripts":{"dev":"vite","test":"vitest"}}' : null,
  },
  message: {
    list: async (id: string) => id === 'c1'
      ? [
          { role: 'user', content: 'support tool calling then package it' },
          { role: 'assistant', content: TODO_MSG },
          { role: 'assistant', content: 'Packaged the dmg and verified it launches. The Windows installer is still the June build.' },
        ]
      : [
          { role: 'user', content: 'the revert logic is wrong' },
          { role: 'assistant', content: 'All six undo kinds now refuse rather than guess when the file moved on.' },
        ],
  },
  chat: { stream: async () => ({ choices: [{ message: { content: '{"tasks":[]}' } }] }) },
  dialog: { openFolder: async () => null },
};

useWorkspaceStore.setState({ rootPath: '/Users/dev/conecode' });
useModelStore.setState({
  models: new Map([['p1', [{
    id: 'm1', name: 'Claude Sonnet 4.5', providerId: 'p1', supportsText: true,
    supportsVision: true, supportsImageGeneration: false, supportsAudioInput: false,
    supportsAudioOutput: false, supportsFunctionCalling: true, supportsReasoning: true,
    contextWindow: 200000, maxOutputTokens: 8192, enabled: true,
  } as any]]]),
  selectedModelId: 'm1',
});
useChatStore.setState({
  messages: [],
  conversations: [
    { id: 'c1', title: '支持工具调用并打包', providerId: 'p1', modelId: 'm1', rootPath: ROOT, createdAt: 0, updatedAt: Date.now() - 20 * 3600 * 1000 },
    { id: 'c2', title: 'Revert 逻辑修复', providerId: 'p1', modelId: 'm1', rootPath: ROOT, createdAt: 0, updatedAt: Date.now() - 3 * 24 * 3600 * 1000 },
  ] as any,
});
useAgendaStore.setState({
  scan: {
    rootPath: '/Users/dev/conecode', scannedAt: Date.now(),
    git: { isRepo: true, branch: 'main', dirty: 3 },
    statusText: '', diffText: '',
    todoComments: [{ file: 'src/a.ts', line: 4, text: 'TODO' }, { file: 'src/b.ts', line: 9, text: 'FIXME' }],
    scripts: ['dev', 'test'], projectName: 'conecode', readmeHead: '',
    hasTests: false, fileCount: 128, languages: ['TypeScript', 'CSS'],
  },
  generatedAt: Date.now() - 42 * 60 * 1000,
  tasks: [
    { id: '1', title: 'Fix the stale MCP tool list after a reload', rationale: 'src/core/mcp/client.ts:12 has a FIXME about tools not refreshing when a server restarts.', kind: 'bug', effort: 'quick', risk: 'low', files: ['src/core/mcp/client.ts'], prompt: 'x' },
    { id: '2', title: 'Add the first test for the revert engine', rationale: 'The scan found no test files, and undoEffect has six branches that silently guard user data.', kind: 'test', effort: 'medium', risk: 'low', files: ['src/stores/codeChanges.store.ts'], prompt: 'x' },
    { id: '3', title: 'Finish the uncommitted compaction work', rationale: '3 uncommitted files touch orderForDisplay but the summary divider is not wired into the phone client yet.', kind: 'feature', effort: 'medium', risk: 'medium', files: ['electron/remote/mobileClient.ts', 'src/core/remote/bridge.ts'], prompt: 'x' },
    { id: '4', title: 'Split the 1900-line chat store', rationale: 'chat.store.ts holds the agent loop, compaction and tool plumbing in one file, which makes every change risky.', kind: 'refactor', effort: 'large', risk: 'high', files: ['src/stores/chat.store.ts'], prompt: 'x' },
  ],
  resume: [
    { conversationId: 'c1', title: '支持工具调用并打包', rootPath: '/Users/dev/conecode', updatedAt: Date.now() - 20 * 3600 * 1000, lastMessage: 'Packaged the dmg and verified it launches. Windows installer is still the June build.', openTodos: ['Verify tool calling against a live provider', 'Refresh the Windows installer'], pendingChanges: 2 },
    { conversationId: 'c2', title: 'Revert 逻辑修复', rootPath: '/Users/dev/conecode', updatedAt: Date.now() - 3 * 24 * 3600 * 1000, lastMessage: 'All six undo kinds now refuse rather than guess when the file moved on.', openTodos: [], pendingChanges: 0 },
  ],
});

useAutopilotStore.setState({
  ideas: FALLBACK_IDEAS.map((i, n) => ({ ...i, id: String(n) })),
  usingFallback: true,
  loadingIdeas: false,
  phase: (new URLSearchParams(location.search).get('phase') as any) || 'idle',
  running: { ...FALLBACK_IDEAS[0], id: '0' },
  projectDir: '/Users/dev/ConeCode Projects/mcp-server',
  attempt: 2,
  verifyCommand: 'npm test',
  lastOutput: 'FAIL  src/server.test.ts\n  ● tool listing › returns the registered tools\n\n    expected 3 tools, received 0',
  error: new URLSearchParams(location.search).get('phase') === 'failed' ? 'verification-failed' : null,
});

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div className="min-h-screen bg-[var(--bg-0)] p-8"><AgentHome /></div>,
);
