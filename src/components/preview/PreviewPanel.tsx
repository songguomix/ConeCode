import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  FiArrowLeft, FiArrowRight, FiRotateCw, FiX, FiExternalLink, FiMonitor, FiTablet,
  FiSmartphone, FiPlay, FiSquare, FiRefreshCw, FiTerminal, FiAlertCircle, FiFolder,
  FiTrash2, FiPlus, FiCrosshair, FiGlobe, FiCode,
} from 'react-icons/fi';
import { useWorkspaceStore, useLanguageStore, usePreviewStore, useUIStore } from '../../stores';
import { DEVICE_SIZES, type DevicePreset, type BrowserTab } from '../../stores/preview.store';
import { pickerScript, pickerStopScript, parsePick, pickToPrompt } from '../../core/preview/picker';
import { setAgentWebview } from '../../core/preview/agentpage';
import WorkbenchTabs from '../layout/WorkbenchTabs';

// The built-in browser. Tabs, an address bar and history like any browser, but
// its new-tab page lists the project's own dev server so previewing what the
// agent just built is one click — and the crosshair hands an element of the
// running page to the chat as context.

/** The subset of Electron's <webview> API this panel drives. */
type WebviewEl = HTMLElement & {
  loadURL: (url: string) => Promise<void>;
  reload: () => void;
  stop: () => void;
  goBack: () => void;
  goForward: () => void;
  canGoBack: () => boolean;
  canGoForward: () => boolean;
  getURL: () => string;
  executeJavaScript: (code: string) => Promise<any>;
};

const DEVICES: { id: DevicePreset; icon: typeof FiMonitor; labelKey: string }[] = [
  { id: 'desktop', icon: FiMonitor, labelKey: 'previewDesktop' },
  { id: 'tablet', icon: FiTablet, labelKey: 'previewTablet' },
  { id: 'mobile', icon: FiSmartphone, labelKey: 'previewMobile' },
];

/** Turn what the user typed into something loadable ("3000" → localhost:3000). */
function normalizeAddress(raw: string): string | null {
  const value = raw.trim();
  if (!value) return null;
  if (/^\d{2,5}$/.test(value)) return `http://localhost:${value}`;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(value)) return `http://${value}`;
  return value;
}

function hostLabel(url: string | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url);
    return parsed.port ? `${parsed.hostname}:${parsed.port}` : parsed.hostname;
  } catch {
    return url;
  }
}

function IconButton({ title, onClick, disabled, active, children }: {
  title: string; onClick: () => void; disabled?: boolean; active?: boolean; children: ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      title={title}
      className={`w-7 h-7 rounded-lg flex items-center justify-center shrink-0 transition-colors ${
        disabled
          ? 'text-[var(--text-muted)] opacity-40 cursor-default'
          : active
            ? 'text-[var(--accent)] bg-[var(--accent-soft)]'
            : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)]'
      }`}
    >
      {children}
    </button>
  );
}

export default function PreviewPanel() {
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const openFolder = useWorkspaceStore((s) => s.openFolder);
  const setInputContent = useUIStore((s) => s.setInputContent);
  const { t } = useLanguageStore();

  const state = usePreviewStore((s) => s.state);
  const serverUrl = usePreviewStore((s) => s.url);
  const plan = usePreviewStore((s) => s.plan);
  const error = usePreviewStore((s) => s.error);
  const device = usePreviewStore((s) => s.device);
  const reloadNonce = usePreviewStore((s) => s.reloadNonce);
  const pageErrors = usePreviewStore((s) => s.pageErrors);
  const tabs = usePreviewStore((s) => s.tabs);
  const activeTabId = usePreviewStore((s) => s.activeTabId);
  const picking = usePreviewStore((s) => s.picking);
  // Selected one at a time (the actions are stable) so a chatty dev server
  // logging into the store doesn't re-render the whole panel.
  const detect = usePreviewStore((s) => s.detect);
  const start = usePreviewStore((s) => s.start);
  const stop = usePreviewStore((s) => s.stop);
  const restart = usePreviewStore((s) => s.restart);
  const setDevice = usePreviewStore((s) => s.setDevice);
  const requestReload = usePreviewStore((s) => s.requestReload);
  const appendLog = usePreviewStore((s) => s.appendLog);
  const setPicking = usePreviewStore((s) => s.setPicking);
  const openTab = usePreviewStore((s) => s.openTab);
  const closeTab = usePreviewStore((s) => s.closeTab);
  const selectTab = usePreviewStore((s) => s.selectTab);
  const navigateTab = usePreviewStore((s) => s.navigateTab);
  const noteTabUrl = usePreviewStore((s) => s.noteTabUrl);
  const setTabTitle = usePreviewStore((s) => s.setTabTitle);

  // One <webview> per tab, all kept mounted so switching tabs never reloads.
  const webviews = useRef(new Map<string, WebviewEl>());
  const viewportRef = useRef<HTMLDivElement>(null);
  const autoStarted = useRef<string | null>(null);
  const lastServerUrl = useRef<string | null>(null);

  const [address, setAddress] = useState('');
  const [addressFocused, setAddressFocused] = useState(false);
  const [loading, setLoading] = useState(false);
  const [canBack, setCanBack] = useState(false);
  const [canForward, setCanForward] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const [logsOpen, setLogsOpen] = useState(false);
  const [box, setBox] = useState({ width: 0, height: 0 });

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0];
  const activeWebview = () => webviews.current.get(activeTab?.id ?? '') ?? null;

  // The agent's page tools drive whichever tab is in front. Registered here (and
  // in the webview ref below) so switching tabs moves the agent with the user
  // rather than leaving it holding a torn-down element.
  useEffect(() => {
    setAgentWebview(activeWebview());
    return () => setAgentWebview(null);
  }, [activeTabId, tabs.length]);

  // ---- server lifecycle ----------------------------------------------------

  // Work out what we *would* run as soon as a folder is open, so the new-tab
  // page can name it before anything is spawned.
  useEffect(() => {
    if (rootPath) detect(rootPath);
  }, [rootPath, detect]);

  // Plain HTML folders have nothing to execute — we just serve them — so start
  // those on sight. Anything that runs a script waits for an explicit click.
  useEffect(() => {
    if (!rootPath || state !== 'idle' || plan?.mode !== 'static') return;
    if (autoStarted.current === rootPath) return;
    autoStarted.current = rootPath;
    start(rootPath);
  }, [rootPath, state, plan, start]);

  // The server came up (or came back on a new port): show it. A blank tab or one
  // still pointing at the old address is the natural place; otherwise open one.
  useEffect(() => {
    const previous = lastServerUrl.current;
    lastServerUrl.current = serverUrl;
    if (!serverUrl || serverUrl === previous) return;

    const current = usePreviewStore.getState();
    const active = current.tabs.find((tab) => tab.id === current.activeTabId);
    const reusable = active && (active.url === null || active.url === previous)
      ? active
      : current.tabs.find((tab) => tab.url === null);

    if (reusable) {
      navigateTab(reusable.id, serverUrl);
      selectTab(reusable.id);
      const wv = webviews.current.get(reusable.id);
      if (wv && reusable.mountUrl) wv.loadURL(serverUrl).catch(() => {});
    } else {
      openTab(serverUrl);
    }
  }, [serverUrl, navigateTab, selectTab, openTab]);

  const handleStart = (command?: string | null) => {
    if (!rootPath) return;
    autoStarted.current = rootPath;
    start(rootPath, command ?? null);
  };

  // ---- navigation ----------------------------------------------------------

  const go = (raw: string) => {
    const url = normalizeAddress(raw);
    if (!url || !activeTab) return;
    const wv = webviews.current.get(activeTab.id);
    navigateTab(activeTab.id, url);
    // Before the guest exists, mounting an element at this address *is* the
    // navigation (navigateTab set mountUrl); after that, keep its history.
    if (wv && activeTab.mountUrl) wv.loadURL(url).catch(() => {});
  };

  const syncHistory = (wv: WebviewEl) => {
    try {
      setCanBack(wv.canGoBack());
      setCanForward(wv.canGoForward());
    } catch {}
  };

  // Wire whichever webview is in front. Re-runs when the tab changes so the
  // toolbar always reflects the page you're looking at.
  useEffect(() => {
    const wv = activeWebview();
    if (!wv || !activeTab?.mountUrl) {
      setCanBack(false);
      setCanForward(false);
      setLoading(false);
      return;
    }
    const tabId = activeTab.id;

    const onStartLoading = () => { setLoading(true); setFailure(null); };
    const onStopLoading = () => { setLoading(false); syncHistory(wv); };
    const onNavigate = (e: any) => {
      if (e?.url) { setAddress(e.url); noteTabUrl(tabId, e.url); }
      syncHistory(wv);
    };
    const onTitle = (e: any) => { if (e?.title) setTabTitle(tabId, e.title); };
    const onFail = (e: any) => {
      // -3 is ABORTED, which every in-page navigation raises; not an error.
      if (e?.errorCode === -3) return;
      setLoading(false);
      setFailure(e?.errorDescription || String(e?.errorCode ?? ''));
    };
    const onConsole = (e: any) => {
      const picked = parsePick(e?.message ?? '');
      if (picked) {
        // The picker answers on the console channel; this is that answer, not
        // something the page meant to log.
        setInputContent(pickToPrompt(picked, t('previewPickedElement')));
        setPicking(false);
        return;
      }
      appendLog({
        stream: 'console',
        data: e?.message ?? '',
        level: e?.level >= 3 ? 'error' : e?.level === 2 ? 'warn' : 'info',
      });
    };

    wv.addEventListener('did-start-loading', onStartLoading);
    wv.addEventListener('did-stop-loading', onStopLoading);
    wv.addEventListener('did-navigate', onNavigate);
    wv.addEventListener('did-navigate-in-page', onNavigate);
    wv.addEventListener('page-title-updated', onTitle);
    wv.addEventListener('did-fail-load', onFail);
    wv.addEventListener('console-message', onConsole);
    syncHistory(wv);
    return () => {
      wv.removeEventListener('did-start-loading', onStartLoading);
      wv.removeEventListener('did-stop-loading', onStopLoading);
      wv.removeEventListener('did-navigate', onNavigate);
      wv.removeEventListener('did-navigate-in-page', onNavigate);
      wv.removeEventListener('page-title-updated', onTitle);
      wv.removeEventListener('did-fail-load', onFail);
      wv.removeEventListener('console-message', onConsole);
    };
  }, [activeTab?.id, activeTab?.mountUrl, appendLog, noteTabUrl, setTabTitle, setInputContent, setPicking, t]);

  // Reload requests come from the button and from main's file watcher (static
  // previews have no HMR of their own).
  useEffect(() => {
    if (!reloadNonce) return;
    try { activeWebview()?.reload(); } catch {}
  }, [reloadNonce]);

  // Keep the address bar in step with the page, unless the user is typing in it.
  useEffect(() => {
    if (!addressFocused) setAddress(activeTab?.url ?? '');
  }, [activeTab?.url, activeTab?.id, addressFocused]);

  // ---- element picker ------------------------------------------------------

  const togglePicking = () => {
    const wv = activeWebview();
    if (!wv || !activeTab?.url) return;
    const next = !picking;
    setPicking(next);
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() || '#C96442';
    wv.executeJavaScript(next ? pickerScript(accent) : pickerStopScript).catch(() => setPicking(false));
  };

  // Arming is per-page: a reload or a tab switch drops the injected script.
  useEffect(() => {
    if (picking) setPicking(false);
  }, [activeTab?.id, activeTab?.url]);

  // ---- device frame --------------------------------------------------------

  useLayoutEffect(() => {
    const el = viewportRef.current;
    if (!el) return;
    const observer = new ResizeObserver(([entry]) => {
      setBox({ width: entry.contentRect.width, height: entry.contentRect.height });
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // In a narrow panel the toolbar can't hold a segmented control *and* a usable
  // address bar, so the device presets collapse into one cycling button.
  const narrow = box.width > 0 && box.width < 520;
  const cycleDevice = () => {
    const order = DEVICES.map((d) => d.id);
    setDevice(order[(order.indexOf(device) + 1) % order.length]);
  };

  const frame = useMemo(() => {
    const size = DEVICE_SIZES[device];
    if (!size.width || !size.height) return { width: '100%', height: '100%', scale: 1 };
    // Shrink to fit rather than clip, so a phone frame still reads on a narrow panel.
    const scale = Math.min(1, (box.width - 32) / size.width, (box.height - 32) / size.height);
    return { width: size.width, height: size.height, scale: Number.isFinite(scale) && scale > 0 ? scale : 1 };
  }, [device, box]);

  // ---- render --------------------------------------------------------------

  const statusColor = state === 'running' ? 'bg-[var(--success)]'
    : state === 'starting' ? 'bg-[var(--warning)] animate-pulse'
    : state === 'error' ? 'bg-[var(--error)]'
    : 'bg-[var(--text-muted)]';
  const statusLabel = state === 'running' ? t('previewRunning')
    : state === 'starting' ? t('previewStarting')
    : state === 'error' ? t('previewFailed')
    : t('previewIdle');

  const actions = (
    <>
      {state !== 'idle' && (
        <IconButton title={t('previewRestart')} onClick={() => rootPath && restart(rootPath)}>
          <FiRefreshCw size={13} />
        </IconButton>
      )}
      {state === 'idle' ? (
        <IconButton title={t('previewStart')} onClick={() => handleStart()} disabled={!rootPath}>
          <FiPlay size={13} />
        </IconButton>
      ) : (
        <IconButton title={t('previewStop')} onClick={() => stop()}>
          <FiSquare size={12} />
        </IconButton>
      )}
    </>
  );

  return (
    <div className="flex flex-col h-full bg-[var(--bg-0)]">
      <WorkbenchTabs active="preview" subtitle={plan?.command || undefined} actions={actions} />

      {/* Browser tabs */}
      <div className="flex items-center gap-0.5 px-2 pt-1.5 shrink-0 overflow-x-auto">
        {tabs.map((tab) => (
          <TabChip
            key={tab.id}
            tab={tab}
            active={tab.id === activeTabId}
            onSelect={() => selectTab(tab.id)}
            onClose={() => { webviews.current.delete(tab.id); closeTab(tab.id); }}
            newTabLabel={t('previewNewTab')}
            closeLabel={t('close')}
          />
        ))}
        <button
          onClick={() => openTab()}
          title={t('previewNewTab')}
          className="w-6 h-6 rounded-lg flex items-center justify-center shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors"
        >
          <FiPlus size={14} />
        </button>
      </div>

      {/* Address + tools */}
      <div className="flex items-center gap-1 px-2 py-1.5 shrink-0">
        <IconButton title={t('previewBack')} onClick={() => activeWebview()?.goBack()} disabled={!canBack}>
          <FiArrowLeft size={14} />
        </IconButton>
        <IconButton title={t('previewForward')} onClick={() => activeWebview()?.goForward()} disabled={!canForward}>
          <FiArrowRight size={14} />
        </IconButton>
        <IconButton
          title={loading ? t('previewStopLoading') : t('refresh')}
          onClick={() => (loading ? activeWebview()?.stop() : requestReload())}
          disabled={!activeTab?.url}
        >
          {loading ? <FiX size={14} /> : <FiRotateCw size={13} />}
        </IconButton>

        <form className="flex-1 min-w-[96px]" onSubmit={(e) => {
          e.preventDefault();
          go(address);
          (e.currentTarget.querySelector('input') as HTMLInputElement | null)?.blur();
        }}>
          <div className="flex items-center gap-2 h-7 px-3 rounded-full bg-[var(--bg-2)] border border-[var(--border)] focus-within:border-[var(--accent)] transition-colors">
            {activeTab?.url && <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${statusColor}`} title={statusLabel} />}
            <input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              onFocus={(e) => { setAddressFocused(true); e.target.select(); }}
              onBlur={() => setAddressFocused(false)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setAddress(activeTab?.url || ''); (e.target as HTMLInputElement).blur(); }
              }}
              placeholder={t('previewAddressPlaceholder')}
              spellCheck={false}
              className="flex-1 min-w-0 bg-transparent text-[12px] ff-mono outline-none text-[var(--text-primary)] placeholder:text-[var(--text-muted)]"
            />
          </div>
        </form>

        <IconButton
          title={t('previewPick')}
          onClick={togglePicking}
          active={picking}
          disabled={!activeTab?.url}
        >
          <FiCrosshair size={14} />
        </IconButton>

        {narrow ? (
          <IconButton
            title={t(DEVICES.find((d) => d.id === device)!.labelKey)}
            onClick={cycleDevice}
            active={device !== 'desktop'}
          >
            {(() => {
              const Icon = DEVICES.find((d) => d.id === device)!.icon;
              return <Icon size={13} />;
            })()}
          </IconButton>
        ) : (
          <div className="flex items-center gap-0.5 p-0.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] shrink-0">
            {DEVICES.map(({ id, icon: Icon, labelKey }) => (
              <button
                key={id}
                onClick={() => setDevice(id)}
                title={t(labelKey)}
                className={`w-6 h-6 rounded-md flex items-center justify-center transition-colors ${
                  device === id
                    ? 'bg-[var(--bg-0)] text-[var(--accent)] shadow-sm'
                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                }`}
              >
                <Icon size={12} />
              </button>
            ))}
          </div>
        )}

        <IconButton
          title={t('previewOpenExternal')}
          onClick={() => activeTab?.url && (window as any).electronAPI?.preview?.openExternal(activeTab.url)}
          disabled={!activeTab?.url}
        >
          <FiExternalLink size={13} />
        </IconButton>
        <div className="relative shrink-0">
          <IconButton title={t('previewLogs')} onClick={() => setLogsOpen((v) => !v)} active={logsOpen}>
            <FiTerminal size={13} />
          </IconButton>
          {pageErrors > 0 && !logsOpen && (
            <span className="absolute -top-0.5 -right-0.5 min-w-[14px] h-[14px] px-1 rounded-full bg-[var(--error)] text-white text-[9px] font-medium flex items-center justify-center pointer-events-none">
              {pageErrors > 9 ? '9+' : pageErrors}
            </span>
          )}
        </div>
      </div>

      {/* Pages — every tab stays mounted; only the active one is visible */}
      <div ref={viewportRef} className="flex-1 min-h-0 relative bg-[var(--bg-1)] border-t border-[var(--border)]">
        {tabs.map((tab) => {
          const isActive = tab.id === activeTabId;
          return (
            <div
              key={tab.id}
              className="absolute inset-0 flex items-center justify-center overflow-hidden"
              // visibility (not display:none) keeps the box alive — a collapsed
              // <webview> comes back blank.
              style={{ visibility: isActive ? 'visible' : 'hidden' }}
            >
              {tab.mountUrl ? (
                <div
                  style={{
                    width: frame.width,
                    height: frame.height,
                    transform: frame.scale < 1 ? `scale(${frame.scale})` : undefined,
                  }}
                  className={`bg-white overflow-hidden shrink-0 ${
                    device === 'desktop' ? '' : 'rounded-[20px] border border-[var(--border)] shadow-2xl'
                  }`}
                >
                  <webview
                    ref={(el) => {
                      if (el) webviews.current.set(tab.id, el as WebviewEl);
                      else webviews.current.delete(tab.id);
                      // Keep the agent pointed at whatever the user is looking at.
                      if (tab.id === activeTabId) setAgentWebview((el as WebviewEl) ?? null);
                    }}
                    src={tab.mountUrl}
                    // Its own browsing session: cookies/localStorage behave like a
                    // real browser across reloads, but stay out of the app's storage.
                    partition="persist:conecode-preview"
                    style={{ width: '100%', height: '100%', display: 'inline-flex' }}
                  />
                </div>
              ) : (
                <NewTabPage
                  rootPath={rootPath}
                  state={state}
                  error={error}
                  plan={plan}
                  serverUrl={serverUrl}
                  onStart={handleStart}
                  onOpenServer={() => serverUrl && go(serverUrl)}
                  onOpenFolder={openFolder}
                  onShowLogs={() => setLogsOpen(true)}
                />
              )}
            </div>
          );
        })}

        {failure && activeTab?.mountUrl && (
          <div className="absolute inset-x-0 bottom-0 m-3 px-3 py-2 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] shadow-lg flex items-center gap-2">
            <FiAlertCircle size={14} className="text-[var(--error)] shrink-0" />
            <span className="flex-1 truncate text-[12px] text-[var(--text-secondary)]">{failure}</span>
            <button
              onClick={() => requestReload()}
              className="px-2 py-1 rounded-lg text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors"
            >
              {t('previewRetry')}
            </button>
            <button onClick={() => setFailure(null)} className="p-1 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)]">
              <FiX size={13} />
            </button>
          </div>
        )}

        {picking && (
          <div className="absolute top-3 left-1/2 -translate-x-1/2 px-3 py-1.5 rounded-full bg-[var(--bg-2)] border border-[var(--accent)] shadow-lg text-[12px] text-[var(--text-secondary)] pointer-events-none">
            {t('previewPickHint')}
          </div>
        )}
      </div>

      {logsOpen && <LogDrawer onClose={() => setLogsOpen(false)} />}
    </div>
  );
}

// ---- tab chip --------------------------------------------------------------

function TabChip({ tab, active, onSelect, onClose, newTabLabel, closeLabel }: {
  tab: BrowserTab; active: boolean; onSelect: () => void; onClose: () => void;
  newTabLabel: string; closeLabel: string;
}) {
  const label = tab.title || hostLabel(tab.url) || newTabLabel;
  return (
    <div
      className={`group flex items-center gap-1.5 pl-2.5 pr-1 h-7 rounded-lg shrink-0 max-w-[180px] transition-colors ${
        active ? 'bg-[var(--bg-3)] text-[var(--text-primary)]' : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]/60'
      }`}
    >
      <button onClick={onSelect} title={tab.url || newTabLabel} className="flex items-center gap-1.5 min-w-0 text-[12.5px] outline-none">
        {tab.url ? <FiGlobe size={11} className="shrink-0 text-[var(--text-muted)]" /> : <FiPlus size={11} className="shrink-0 text-[var(--text-muted)]" />}
        <span className="truncate">{label}</span>
      </button>
      <button
        onClick={onClose}
        title={closeLabel}
        aria-label={closeLabel}
        className="w-4 h-4 rounded flex items-center justify-center shrink-0 text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-4)] opacity-0 group-hover:opacity-100 focus:opacity-100 transition-opacity"
      >
        <FiX size={11} />
      </button>
    </div>
  );
}

// ---- new-tab page ----------------------------------------------------------

function NewTabPage({ rootPath, state, error, plan, serverUrl, onStart, onOpenServer, onOpenFolder, onShowLogs }: {
  rootPath: string | null;
  state: string;
  error: string | null;
  plan: { mode: string; command: string | null; framework?: string | null; staticDir?: string | null } | null;
  serverUrl: string | null;
  onStart: (command?: string | null) => void;
  onOpenServer: () => void;
  onOpenFolder: () => void;
  onShowLogs: () => void;
}) {
  const { t } = useLanguageStore();
  const [command, setCommand] = useState('');

  if (!rootPath) {
    return (
      <div className="w-full h-full flex flex-col items-center justify-center gap-3 p-8 text-center bg-[var(--bg-0)]">
        <div className="w-12 h-12 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] flex items-center justify-center">
          <FiFolder size={20} className="text-[var(--text-muted)]" />
        </div>
        <div className="text-[15px] font-medium">{t('previewNoFolder')}</div>
        <p className="text-[13px] text-[var(--text-secondary)] max-w-[320px]">{t('previewNoFolderHint')}</p>
        <button
          onClick={onOpenFolder}
          className="mt-1 px-3.5 py-2 rounded-xl bg-[var(--accent)] text-white text-[13px] hover:bg-[var(--accent-hover)] transition-colors"
        >
          {t('openFolder')}
        </button>
      </div>
    );
  }

  const running = state === 'running' && !!serverUrl;
  const starting = state === 'starting';
  const failed = state === 'error';
  const undetected = !plan || error === 'notDetected';
  const label = plan?.command || (plan?.mode === 'static' ? t('previewStaticFiles') : rootPath.split('/').pop() || '');

  return (
    <div className="w-full h-full overflow-y-auto flex flex-col items-center justify-center gap-3 p-8 bg-[var(--bg-0)]">
      {/* The project's own server, one click away — the reason this page exists. */}
      {!undetected && (
        <div className="w-full max-w-[440px] flex items-center gap-3 px-4 py-3 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)]">
          <div className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 ${running ? 'bg-[var(--success)]/10' : 'bg-[var(--accent-soft)]'}`}>
            {plan?.mode === 'static'
              ? <FiCode size={15} className={running ? 'text-[var(--success)]' : 'text-[var(--accent)]'} />
              : <FiTerminal size={15} className={running ? 'text-[var(--success)]' : 'text-[var(--accent)]'} />}
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] truncate">{label}</div>
            {plan?.framework && <div className="text-[11.5px] text-[var(--text-muted)] truncate">{plan.framework}</div>}
          </div>
          {running && <span className="text-[12px] ff-mono text-[var(--text-muted)] shrink-0">:{hostLabel(serverUrl).split(':')[1] || ''}</span>}
          <button
            onClick={running ? onOpenServer : () => onStart()}
            disabled={starting}
            title={running ? t('previewOpen') : t('previewStart')}
            className={`w-8 h-8 rounded-xl flex items-center justify-center shrink-0 border transition-colors ${
              starting
                ? 'border-[var(--border)] text-[var(--text-muted)]'
                : 'border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)] hover:text-[var(--accent)]'
            }`}
          >
            {starting
              ? <span className="w-3.5 h-3.5 rounded-full border-2 border-[var(--bg-4)] border-t-[var(--accent)] animate-spin" />
              : running ? <FiArrowRight size={14} /> : <FiPlay size={13} />}
          </button>
        </div>
      )}

      {failed && (
        <div className="w-full max-w-[440px] flex items-center gap-2 px-4 py-2.5 rounded-xl bg-[var(--bg-2)] border border-[var(--border)]">
          <FiAlertCircle size={14} className="text-[var(--error)] shrink-0" />
          <span className="flex-1 min-w-0 text-[12.5px] text-[var(--text-secondary)] truncate">
            {error?.startsWith('exit:') ? `${t('previewExited')} (${error.slice(5)})` : error}
          </span>
          <button onClick={onShowLogs} className="text-[12px] text-[var(--accent)] hover:underline shrink-0">
            {t('previewLogs')}
          </button>
        </div>
      )}

      {/* Anything else the project needs to be started with. */}
      <form
        className="w-full max-w-[440px] flex items-center gap-2"
        onSubmit={(e) => { e.preventDefault(); if (command.trim()) onStart(command.trim()); }}
      >
        <input
          value={command}
          onChange={(e) => setCommand(e.target.value)}
          placeholder={undetected ? t('previewCommandPlaceholder') : t('previewCustomCommand')}
          spellCheck={false}
          className="flex-1 min-w-0 px-3.5 h-9 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] focus:border-[var(--accent)] text-[12.5px] ff-mono outline-none transition-colors placeholder:text-[var(--text-muted)]"
        />
        <button
          type="submit"
          disabled={!command.trim()}
          title={t('previewStart')}
          className="w-9 h-9 rounded-xl flex items-center justify-center shrink-0 border border-[var(--border)] text-[var(--text-secondary)] enabled:hover:border-[var(--accent)] enabled:hover:text-[var(--accent)] disabled:opacity-40 transition-colors"
        >
          <FiPlay size={13} />
        </button>
      </form>

      <p className="text-[12px] text-[var(--text-muted)]">
        {undetected ? t('previewNotDetectedHint') : t('previewOrTypeUrl')}
      </p>
    </div>
  );
}

// ---- output drawer ---------------------------------------------------------

function LogDrawer({ onClose }: { onClose: () => void }) {
  const logs = usePreviewStore((s) => s.logs);
  const clearLogs = usePreviewStore((s) => s.clearLogs);
  const { t } = useLanguageStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [logs.length]);

  return (
    <div className="h-[180px] shrink-0 flex flex-col border-t border-[var(--border)] bg-[var(--bg-0)]">
      <div className="flex items-center gap-2 px-3 py-1.5 shrink-0">
        <span className="text-[12px] font-medium text-[var(--text-secondary)]">{t('previewLogs')}</span>
        <span className="text-[11px] text-[var(--text-muted)]">{logs.length}</span>
        <div className="flex-1" />
        <button onClick={clearLogs} title={t('previewClearLogs')}
          className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors">
          <FiTrash2 size={13} />
        </button>
        <button onClick={onClose} title={t('close')}
          className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-secondary)] hover:bg-[var(--bg-3)] transition-colors">
          <FiX size={14} />
        </button>
      </div>
      <div className="flex-1 min-h-0 overflow-y-auto px-3 pb-2 ff-mono text-[11.5px] leading-[17px]">
        {logs.length === 0 ? (
          <div className="text-[var(--text-muted)]">{t('previewNoOutput')}</div>
        ) : (
          logs.map((entry, i) => (
            <div
              key={i}
              className={`whitespace-pre-wrap break-all ${
                entry.level === 'error' || entry.stream === 'stderr' ? 'text-[var(--error)]'
                : entry.level === 'warn' ? 'text-[var(--warning)]'
                : entry.stream === 'system' ? 'text-[var(--text-muted)]'
                : entry.stream === 'console' ? 'text-[var(--syntax-property)]'
                : 'text-[var(--text-secondary)]'
              }`}
            >
              {entry.data.replace(/\n$/, '')}
            </div>
          ))
        )}
        <div ref={bottomRef} />
      </div>
    </div>
  );
}
