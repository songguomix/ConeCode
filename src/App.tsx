import { useEffect, useRef } from 'react';
import { useProviderStore, useModelStore, useChatStore, useSettingsStore, useMemoryStore, useSkillsStore, usePreviewStore, useWorkspaceStore, useCodeChangesStore, useLanguageStore } from './stores';
import AppShell from './components/layout/AppShell';
import { initRemoteBridge } from './core/remote/bridge';

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
  }, []);

  // Project skills follow the active workspace. Keep this at app level so the
  // agent sees them even when the user never opens the Skills settings panel.
  useEffect(() => {
    void loadSkills();
  }, [loadSkills, rootPath]);

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
