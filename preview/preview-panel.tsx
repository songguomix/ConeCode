// Visual harness for the built-in browser.
//   ?state=running|starting|error|idle|nofolder  — dev-server state to render
//   ?tabs=2                                      — extra browser tabs
//   ?tab=code                                    — show it next to an open file
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import PreviewPanel from '../src/components/preview/PreviewPanel';
import EditorPanel from '../src/components/editor/EditorPanel';
import { usePreviewStore } from '../src/stores/preview.store';
import * as picker from '../src/core/preview/picker';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useUIStore } from '../src/stores/ui.store';

// <webview> only exists inside Electron (and "webview" is not a legal custom
// element name), so fill any that React renders with an iframe and the handful
// of methods the panel calls. Enough to eyeball the frames and layout.
function fakeWebview(el: HTMLElement) {
  if ((el as any).__faked) return;
  (el as any).__faked = true;
  const frame = document.createElement('iframe');
  frame.src = el.getAttribute('src') || '';
  frame.style.cssText = 'width:100%;height:100%;border:0;display:block';
  el.appendChild(frame);
  Object.assign(el, {
    loadURL: (url: string) => { frame.src = url; return Promise.resolve(); },
    reload: () => { frame.src = frame.src; },
    stop: () => {},
    goBack: () => {},
    goForward: () => {},
    canGoBack: () => true,
    canGoForward: () => false,
    getURL: () => frame.src,
    executeJavaScript: () => Promise.resolve(),
  });
}
new MutationObserver(() => document.querySelectorAll('webview').forEach((el) => fakeWebview(el as HTMLElement)))
  .observe(document.documentElement, { childList: true, subtree: true });

// Exposed so the picker's injected script can be exercised against this page.
(window as any).picker = picker;

const params = new URLSearchParams(location.search);
const state = params.get('state') || 'running';

(window as any).electronAPI = {
  preview: {
    detect: async () => ({ mode: 'script', command: 'npm run dev', cwd: '/Users/dev/proj', framework: 'Vite' }),
    start: async () => usePreviewStore.getState(),
    stop: async () => usePreviewStore.getState(),
    status: async () => usePreviewStore.getState(),
    openExternal: async () => true,
    onStatus: () => () => {},
    onLog: () => () => {},
    onReload: () => () => {},
  },
  fs: { readFile: async () => '<h1>hello</h1>\n' },
  dialog: { openFolder: async () => null },
};

if (state !== 'nofolder') useWorkspaceStore.setState({ rootPath: '/Users/dev/proj' });
useUIStore.setState({ previewOpen: true, workbenchTab: params.get('tab') === 'code' ? 'code' : 'preview' });
if (params.get('tab') === 'code') {
  useWorkspaceStore.setState({ selectedFile: '/Users/dev/proj/src/index.html', fileContent: '<h1>hello</h1>\n' });
}

const plan = { mode: 'script' as const, command: 'npm run dev', cwd: '/Users/dev/proj', framework: 'Vite' };
const logs = [
  { stream: 'system' as const, data: '$ npm run dev\n' },
  { stream: 'stdout' as const, data: '  VITE v5.0.10  ready in 312 ms\n' },
  { stream: 'stdout' as const, data: '  ➜  Local:   http://localhost:5173/\n' },
  { stream: 'console' as const, data: '[vite] connected.', level: 'info' as const },
  { stream: 'stderr' as const, data: 'Warning: styles.css not found\n' },
];

const url = 'https://example.com/';
const tabs = state === 'running'
  ? [{ id: 'tab-1', mountUrl: url, url, title: 'Example Domain' }]
  : [{ id: 'tab-1', mountUrl: null, url: null, title: null }];
if (params.get('tabs') === '2') {
  tabs.push({ id: 'tab-2', mountUrl: null, url: null, title: null });
}

usePreviewStore.setState({
  plan,
  logs: state === 'idle' ? [] : logs,
  tabs,
  activeTabId: 'tab-1',
  pageErrors: state === 'running' ? 2 : 0,
  ...(state === 'running' ? { state: 'running' as const, url }
    : state === 'starting' ? { state: 'starting' as const, url: null }
    : state === 'error' ? { state: 'error' as const, url: null, error: 'exit:1' }
    : { state: 'idle' as const, url: null }),
});

function Harness() {
  const tab = useUIStore((s) => s.workbenchTab);
  return (
    <div className="h-screen bg-[var(--bg-0)] flex">
      <div className="w-[52%] border-r border-[var(--border)] relative">
        <div className="absolute inset-0" style={{ visibility: tab === 'code' ? 'visible' : 'hidden' }}>
          <EditorPanel />
        </div>
        <div className="absolute inset-0" style={{ visibility: tab === 'preview' ? 'visible' : 'hidden' }}>
          <PreviewPanel />
        </div>
      </div>
      <div className="flex-1 flex items-center justify-center text-[13px] text-[var(--text-muted)]">chat column</div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
