import { useEffect, useRef } from 'react';
import { useProviderStore, useModelStore, useChatStore, useSettingsStore, useMemoryStore, useSkillsStore, usePreviewStore, useWorkspaceStore, useCodeChangesStore, useLanguageStore } from './stores';
import { useMemoryV2Store } from './stores/memoryV2.store';
import { useScreenshotStore } from './stores/screenshot.store';
import { useBackgroundStore } from './stores/background.store';
import { useMonitorStore } from './stores/monitor.store';
import AppShell from './components/layout/AppShell';
import { initRemoteBridge } from './core/remote/bridge';
import { useFreeStore } from './stores/free.store';
import { useUpdateStore } from './stores/update.store';
import { useComputerStore } from './stores/computer.store';

export default function App() {
  const fetchProviders = useProviderStore((s) => s.fetchProviders);
  const fetchAllModels = useModelStore((s) => s.fetchAllModels);
  const fetchConversations = useChatStore((s) => s.fetchConversations);
  const loadSettings = useSettingsStore((s) => s.loadSettings);
  const loadMemory = useMemoryStore((s) => s.load);
  const loadSkills = useSkillsStore((s) => s.load);
  const rootPath = useWorkspaceStore((s) => s.rootPath);
  const subscribePreview = usePreviewStore((s) => s.subscribe);
  const isStreaming = useChatStore((s) => s.isStreaming);
  const pendingApprovalIds = useCodeChangesStore((s) => s.changes
    .filter((change) => change.status === 'pending')
    .map((change) => change.id)
    .sort()
    .join(','));
  const notificationMode = useSettingsStore((s) => s.notificationMode);
  const notifyApprovals = useSettingsStore((s) => s.notifyApprovals);
  const preventSleepWhileRunning = useSettingsStore((s) => s.preventSleepWhileRunning);
  const t = useLanguageStore((s) => s.t);
  const bootstrapped = useRef(false);
  const previousStreaming = useRef(false);
  const knownApprovals = useRef<Set<string> | null>(null);
  const initScreenshot = useScreenshotStore((s) => s.init);

  useEffect(() => useComputerStore.getState().subscribeStatus(), []);

  useEffect(() => {
    // React StrictMode intentionally re-runs mount effects in development. Do
    // not double every provider request, database read and preview subscription.
    if (bootstrapped.current) return;
    bootstrapped.current = true;

    void (async () => {
      // Settings and providers determine how models should be presented; load
      // them together, then fetch models once. Other startup reads are independent.
      await Promise.all([loadSettings(), fetchProviders()]);
      await fetchAllModels();

      // Honor the configured defaults. If they are missing/stale, prefer each
      // provider's own default model, then fall back to the first available one.
      const modelState = useModelStore.getState();
      if (!modelState.getSelectedModel()) {
        const settings = useSettingsStore.getState();
        const providers = useProviderStore.getState().providers.filter((provider) => provider.enabled);
        const allModels = Array.from(modelState.models.values()).flat();
        let preferred = allModels.find((model) =>
          (!settings.defaultProviderId || model.providerId === settings.defaultProviderId)
          && !!settings.defaultModelId && model.id === settings.defaultModelId,
        );
        if (!preferred) {
          for (const provider of providers) {
            const providerModels = modelState.models.get(provider.id) || [];
            preferred = providerModels.find((model) => model.id === provider.defaultModel) || providerModels[0];
            if (preferred) break;
          }
        }
        preferred ||= allModels[0];
        if (preferred) modelState.selectModel(preferred.id, preferred.providerId, false);
      }
    })();
    // Long-term memory is part of the very first prompt, so load it up front.
    void loadMemory();
    // Memory 2.0 owns retrieval/extraction once its durable store is available;
    // the legacy store above remains the fallback when there is no bridge.
    void useMemoryV2Store.getState().init(useWorkspaceStore.getState().rootPath);
    // Do NOT auto-create a conversation on launch. It raced with the lazy create
    // inside sendMessage, so the first message could spawn a second, empty chat.
    // The conversation is created only on the first send; until then we show the
    // empty "start a conversation" state.
    void fetchConversations();
    // Start mirroring state to / accepting commands from any connected phone.
    initRemoteBridge();
    // Follow the preview dev server even while its panel is closed, so the
    // sidebar's status dot and the log stay accurate.
    subscribePreview();
    // Self-update: ask agibase for the newest release. A newer build opens the
    // dialog; closing it parks the same offer in Settings → Updates.
    void useUpdateStore.getState().initialize();
    // Re-register the stored screenshot hotkey (main forgets on quit) and
    // answer its trigger.
    const stopScreenshot = initScreenshot();
    // Background tasks (opencode-style): reconcile detached runs so finished
    // ones badge + notify even while the user chats elsewhere.
    const initBackground = useBackgroundStore.getState().init;
    const stopBackground = initBackground();
    // RSI performance monitor: auto-read renderer errors, resume sampling when
    // it was left on (persisted flag).
    const monitor = useMonitorStore.getState();
    const onWindowError = (e: ErrorEvent) => {
      const src = e.filename ? `${e.filename.split('/').pop()}:${e.lineno ?? 0}` : 'window.onerror';
      monitor.captureError(e.message || 'unknown error', src);
    };
    const onUnhandledRejection = (e: PromiseRejectionEvent) => {
      const reason = e.reason as any;
      const msg = typeof reason === 'string' ? reason : reason?.message || String(reason);
      monitor.captureError(msg, 'unhandledrejection');
    };
    window.addEventListener('error', onWindowError);
    window.addEventListener('unhandledrejection', onUnhandledRejection);
    if (monitor.enabled) monitor.start();
    // The fullscreen overlay window reports confirmed shots here (it has no
    // access to this window's chat state). Main already copied the PNG to the
    // system clipboard natively, so just drop it into the chat.
    const stopShotResult = (window as any).electronAPI?.screenshot?.onResult?.(
      (dataUrl: string) => {
        useWorkspaceStore.getState().addPastedImage(dataUrl, `screenshot-${Date.now()}.png`);
      },
    );
    return () => {
      stopScreenshot();
      stopBackground();
      monitor.stop();
      window.removeEventListener('error', onWindowError);
      window.removeEventListener('unhandledrejection', onUnhandledRejection);
      stopShotResult?.();
    };
  }, []);

  useEffect(() => {
    const refresh = () => { void useFreeStore.getState().refresh(); };
    refresh();
    const timer = window.setInterval(refresh, 30000);
    window.addEventListener('focus', refresh);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); };
  }, []);

  // Long sessions still notice a release: poll every 6h, plus when the window
  // regains focus after a sleep. The store throttles repeats to 30 minutes.
  useEffect(() => {
    const recheck = () => { void useUpdateStore.getState().check({ auto: true }); };
    const timer = window.setInterval(recheck, 6 * 60 * 60 * 1000);
    window.addEventListener('focus', recheck);
    return () => { window.clearInterval(timer); window.removeEventListener('focus', recheck); };
  }, []);

  // Project skills follow the active workspace. Keep this at app level so the
  // agent sees them even when the user never opens the Skills settings panel.
  useEffect(() => {
    void loadSkills();
  }, [loadSkills, rootPath]);

  // Project memory follows the workspace too. Switching projects must swap the
  // retrieval boundary before the next prompt is built, otherwise one project's
  // facts can leak into another's context.
  useEffect(() => {
    const memory = useMemoryV2Store.getState();
    if (memory.initialized) void memory.setProject(rootPath);
  }, [rootPath]);

  useEffect(() => {
    const shouldPrevent = preventSleepWhileRunning && isStreaming;
    void window.electronAPI.power.setPreventSleep(shouldPrevent);
    return () => {
      if (shouldPrevent) void window.electronAPI.power.setPreventSleep(false);
    };
  }, [isStreaming, preventSleepWhileRunning]);

  useEffect(() => {
    if (previousStreaming.current && !isStreaming && !pendingApprovalIds) {
      void window.electronAPI.notification.show({
        title: t('taskReadyTitle'),
        body: t('taskReadyBody'),
        mode: notificationMode,
      });
    }
    previousStreaming.current = isStreaming;
  }, [isStreaming, notificationMode, pendingApprovalIds, t]);

  useEffect(() => {
    const current = new Set(pendingApprovalIds ? pendingApprovalIds.split(',') : []);
    if (knownApprovals.current == null) {
      knownApprovals.current = current;
      return;
    }
    const hasNewApproval = Array.from(current).some((id) => !knownApprovals.current!.has(id));
    knownApprovals.current = current;
    if (hasNewApproval && notifyApprovals) {
      void window.electronAPI.notification.show({
        title: t('approvalReadyTitle'),
        body: t('approvalReadyBody'),
        mode: notificationMode,
      });
    }
  }, [notificationMode, notifyApprovals, pendingApprovalIds, t]);

  return <AppShell />;
}
