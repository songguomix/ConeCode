// Visual harness for the app chrome: sidebar toolbar, workbench tabs, and the
// edited-files pill — rendered side by side in light and dark so a hardcoded
// colour or a cramped toolbar is obvious at a glance.
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import Sidebar from '../src/components/layout/Sidebar';
import WorkbenchTabs from '../src/components/layout/WorkbenchTabs';
import DiffStatPill from '../src/components/chat/DiffStatPill';
import { useChatStore } from '../src/stores/chat.store';
import { useUIStore } from '../src/stores/ui.store';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { usePreviewStore } from '../src/stores/preview.store';
import { useComputerStore } from '../src/stores/computer.store';
import { useCodeChangesStore } from '../src/stores/codeChanges.store';
import { useLanguageStore } from '../src/stores/language.store';

(window as any).electronAPI = {
  git: { info: async () => ({ isRepo: true, branch: 'main', dirty: 3 }) },
  dialog: { openFile: async () => ['/Users/dev/proj/src/other.ts'] },
  fs: { readFile: async () => 'export const x = 1;\n' },
  window: { minimize: () => {}, maximize: () => {}, close: () => {} },
  settings: { update: async () => ({}) },
};

useLanguageStore.setState({ locale: 'zh' } as any);
useWorkspaceStore.setState({
  rootPath: '/Users/dev/proj',
  selectedFile: '/Users/dev/proj/src/components/layout/Sidebar.tsx',
  fileContent: 'x',
  files: [],
  extraRoots: [],
  contextFiles: [],
} as any);
useChatStore.setState({
  conversations: [
    { id: 'c1', title: '优化提示词', providerId: 'p1', modelId: 'm1', createdAt: 0, updatedAt: 0 },
    { id: 'c2', title: '修复回滚逻辑', providerId: 'p1', modelId: 'm1', createdAt: 0, updatedAt: 0 },
  ] as any,
  activeConversationId: 'c1',
  messages: [],
});
// Live state that must stay visible once the toggles fold into a menu.
usePreviewStore.setState({ state: 'running' } as any);
useComputerStore.setState({ enabled: false } as any);
useUIStore.setState({ previewOpen: true, terminalOpen: true } as any);
useCodeChangesStore.setState({
  changes: [
    { id: '1', kind: 'edit', filePath: '/p/a.ts', originalCode: 'a\nb\nc\n', newCode: 'a\nB\nc\nd\ne\n', status: 'applied', createdAt: 0 },
    { id: '2', kind: 'edit', filePath: '/p/b.ts', originalCode: 'x\ny\nz\n', newCode: 'x\nz\n', status: 'applied', createdAt: 0 },
  ] as any,
});

// theme.store puts `dark` on <html> at import time; clear it so the light pane
// really is light and each pane carries its own palette.
document.documentElement.classList.remove('dark');

// Exposed so live state (dev server, agent driving the mouse) can be flipped
// from the console to check the collapsed toolbar still surfaces it.
(window as any).stores = { useUIStore, usePreviewStore, useComputerStore, useWorkspaceStore };

function Pane({ dark, label }: { dark: boolean; label: string }) {
  return (
    <div className={dark ? 'dark' : ''} style={{ flex: 1, minWidth: 0 }}>
      <div className="bg-[var(--bg-0)] text-[var(--text-primary)] h-screen flex flex-col">
        <div className="px-4 py-2 text-xs text-[var(--text-muted)] border-b border-[var(--border)]">{label}</div>
        <div className="flex flex-1 min-h-0">
          <Sidebar />
          <div className="flex-1 min-w-0 flex flex-col border-l border-[var(--border)]">
            <WorkbenchTabs active="code" subtitle="src/components/layout/Sidebar.tsx" />
            <div className="flex-1 bg-[var(--bg-0)]" />
            <DiffStatPill />
            <div className="h-16 border-t border-[var(--border)] bg-[var(--bg-0)]" />
          </div>
        </div>
      </div>
    </div>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(
  <div style={{ display: 'flex', gap: 0 }}>
    <Pane dark={false} label="LIGHT" />
    <Pane dark={true} label="DARK" />
  </div>,
);
