import { describe, it, expect, beforeEach } from 'vitest';
import { usePreviewStore } from './preview.store';

// The browser's tab bookkeeping. `mountUrl` is the subtle one: it's the address
// a tab's <webview> element was created with, so it must NOT follow ordinary
// navigation — changing it would replace the element and wipe the tab's history.

const reset = () => {
  const first = { id: 'tab-1', mountUrl: null, url: null, title: null };
  usePreviewStore.setState({ tabs: [first], activeTabId: first.id, picking: false });
};

beforeEach(reset);

describe('tabs', () => {
  it('starts with one blank tab', () => {
    const { tabs, activeTabId } = usePreviewStore.getState();
    expect(tabs).toHaveLength(1);
    expect(tabs[0].url).toBeNull();
    expect(activeTabId).toBe(tabs[0].id);
  });

  it('opens a tab and brings it to the front', () => {
    const id = usePreviewStore.getState().openTab('http://localhost:5173/');
    const { tabs, activeTabId } = usePreviewStore.getState();
    expect(tabs).toHaveLength(2);
    expect(activeTabId).toBe(id);
    expect(tabs[1]).toMatchObject({ url: 'http://localhost:5173/', mountUrl: 'http://localhost:5173/' });
  });

  it('mounts an element the first time a blank tab is navigated', () => {
    const { navigateTab, activeTabId } = usePreviewStore.getState();
    navigateTab(activeTabId, 'http://localhost:3000/');
    expect(usePreviewStore.getState().tabs[0]).toMatchObject({
      url: 'http://localhost:3000/',
      mountUrl: 'http://localhost:3000/',
    });
  });

  it('keeps the element (and its history) on later navigation', () => {
    const { navigateTab, activeTabId } = usePreviewStore.getState();
    navigateTab(activeTabId, 'http://localhost:3000/');
    navigateTab(activeTabId, 'http://localhost:3000/about');
    expect(usePreviewStore.getState().tabs[0]).toMatchObject({
      url: 'http://localhost:3000/about',
      mountUrl: 'http://localhost:3000/',
    });
  });

  it('follows where the page actually went without remounting', () => {
    const { navigateTab, noteTabUrl, activeTabId } = usePreviewStore.getState();
    navigateTab(activeTabId, 'http://localhost:3000/');
    noteTabUrl(activeTabId, 'http://localhost:3000/login');
    const tab = usePreviewStore.getState().tabs[0];
    expect(tab.url).toBe('http://localhost:3000/login');
    expect(tab.mountUrl).toBe('http://localhost:3000/');
  });

  it('moves focus to a neighbour when the active tab closes', () => {
    const store = usePreviewStore.getState();
    const second = store.openTab('http://a.test/');
    const third = store.openTab('http://b.test/');
    expect(usePreviewStore.getState().activeTabId).toBe(third);

    usePreviewStore.getState().closeTab(third);
    expect(usePreviewStore.getState().activeTabId).toBe(second);
  });

  it('leaves focus alone when a background tab closes', () => {
    const store = usePreviewStore.getState();
    const second = store.openTab('http://a.test/');
    const third = store.openTab('http://b.test/');
    usePreviewStore.getState().closeTab(second);
    expect(usePreviewStore.getState().activeTabId).toBe(third);
    expect(usePreviewStore.getState().tabs).toHaveLength(2);
  });

  it('never leaves the browser with no tab', () => {
    const { tabs, closeTab } = usePreviewStore.getState();
    closeTab(tabs[0].id);
    const after = usePreviewStore.getState();
    expect(after.tabs).toHaveLength(1);
    expect(after.tabs[0].url).toBeNull();
    expect(after.activeTabId).toBe(after.tabs[0].id);
  });

  it('ignores a close for a tab that is already gone', () => {
    usePreviewStore.getState().closeTab('tab-does-not-exist');
    expect(usePreviewStore.getState().tabs).toHaveLength(1);
  });

  it('disarms the element picker when switching tabs', () => {
    const store = usePreviewStore.getState();
    const second = store.openTab('http://a.test/');
    usePreviewStore.getState().setPicking(true);
    usePreviewStore.getState().selectTab(second);
    expect(usePreviewStore.getState().picking).toBe(false);
  });
});

describe('logs', () => {
  beforeEach(() => usePreviewStore.setState({ logs: [], pageErrors: 0 }));

  it('counts page errors for the drawer badge', () => {
    const { appendLog } = usePreviewStore.getState();
    appendLog({ stream: 'console', data: 'boom', level: 'error' });
    appendLog({ stream: 'console', data: 'hmm', level: 'warn' });
    appendLog({ stream: 'stdout', data: 'ready' });
    expect(usePreviewStore.getState().pageErrors).toBe(1);
    expect(usePreviewStore.getState().logs).toHaveLength(3);
  });

  it('caps the log so a chatty server cannot grow it forever', () => {
    const { appendLog } = usePreviewStore.getState();
    for (let i = 0; i < 500; i++) appendLog({ stream: 'stdout', data: `line ${i}` });
    const { logs } = usePreviewStore.getState();
    expect(logs).toHaveLength(400);
    // The cap drops the oldest lines, not the newest.
    expect(logs[logs.length - 1].data).toBe('line 499');
  });

  it('clears the badge with the log', () => {
    const { appendLog, clearLogs } = usePreviewStore.getState();
    appendLog({ stream: 'console', data: 'boom', level: 'error' });
    clearLogs();
    expect(usePreviewStore.getState()).toMatchObject({ logs: [], pageErrors: 0 });
  });
});
