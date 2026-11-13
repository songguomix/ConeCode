import { useCallback, useEffect, useRef, useState } from 'react';
import {
  FiX, FiMonitor, FiAlertTriangle, FiCheck, FiExternalLink, FiSlash, FiTrash2, FiCrosshair, FiRefreshCw,
} from 'react-icons/fi';
import { useUIStore, useLanguageStore, useComputerStore, useSettingsStore } from '../../stores';
import type { ComputerTarget } from '../../core/computer/computer';

// The consent surface for letting the agent drive the machine. Everything the
// user needs in order to decide is here: what it will be able to do, which OS
// permissions are missing, what it has done so far, and one button that takes
// the keys back. Mirrors the floating-card pattern of RemotePanel.

function PermissionRow({ granted, label, hint, action }: {
  granted: boolean; label: string; hint: string; action?: React.ReactNode;
}) {
  return (
    <div className="flex items-start gap-2.5 px-3 py-2.5 rounded-xl bg-[var(--bg-0)] border border-[var(--border)]">
      <div className={`w-5 h-5 rounded-lg flex items-center justify-center shrink-0 mt-0.5 ${
        granted ? 'bg-[color-mix(in_srgb,var(--success)_15%,transparent)] text-[var(--success)]' : 'bg-[color-mix(in_srgb,var(--warning)_15%,transparent)] text-[var(--warning)]'
      }`}>
        {granted ? <FiCheck size={12} /> : <FiAlertTriangle size={11} />}
      </div>
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-medium">{label}</div>
        <div className="text-[12px] text-[var(--text-muted)] leading-relaxed">{hint}</div>
      </div>
      {!granted && action}
    </div>
  );
}

export default function ComputerPanel() {
  const closeComputer = useUIStore((s) => s.closeComputer);
  const { t, locale } = useLanguageStore();
  const approvalMode = useSettingsStore((s) => s.approvalOverride ?? s.approvalMode);
  const {
    enabled, supported, platform, accessibility, screenRecording, geometry, target,
    activity, lastShot, refresh, setEnabled, requestPermissions, panic, clearActivity, previewVisible, refreshPreview, setLastShot,
  } = useComputerStore();
  const bottomRef = useRef<HTMLDivElement>(null);
  const [openingPreview, setOpeningPreview] = useState(false);
  const [previewError, setPreviewError] = useState<string>();
  const [apps, setApps] = useState<ComputerTarget[] | null>(null);
  const [appBusy, setAppBusy] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { void refreshPreview().catch(() => undefined); }, [refreshPreview]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [activity.length]);

  const isMac = platform === 'darwin';
  const ready = accessibility && screenRecording;
  const loadApps = useCallback(async () => {
    setAppBusy(true);
    setAppError(null);
    try {
      const result = await window.electronAPI.computer.act({ action: 'list_apps' });
      if (!result.ok) throw new Error(result.message);
      setApps(result.targets!);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setAppBusy(false);
    }
  }, []);
  useEffect(() => {
    if (enabled) void loadApps();
    else {
      setApps(null);
      setAppError(null);
    }
  }, [enabled, loadApps]);

  const selectApp = async (targetId: string) => {
    setAppBusy(true);
    setAppError(null);
    try {
      const api = window.electronAPI.computer;
      const { targetRevision } = await api.status();
      const result = await api.act({ action: 'switch_app', targetId, targetRevision });
      if (!result.ok) throw new Error(result.message);
      const shot = await api.screenshot(targetRevision + 1);
      if ('error' in shot) throw new Error(shot.error);
      setLastShot(shot);
    } catch (error) {
      setAppError(error instanceof Error ? error.message : String(error));
    } finally {
      setAppBusy(false);
    }
  };
  const openPreview = async () => {
    setOpeningPreview(true);
    setPreviewError(undefined);
    try {
      if (previewVisible) {
        await window.electronAPI.computer.closePreview();
      } else {
        const result = await window.electronAPI?.computer?.openPreview?.({
          locale,
          theme: document.documentElement.classList.contains('dark') ? 'dark' : 'light',
        });
        if (!result?.ok) throw new Error(result?.error || 'Unavailable');
      }
      await refreshPreview();
      if (!previewVisible) closeComputer();
    } catch { setPreviewError(t('computerPreviewOpenFailed')); }
    finally { setOpeningPreview(false); }
  };

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20 backdrop-blur-xs" onClick={closeComputer} />
      <div className="fixed right-4 top-16 z-50 w-[420px] max-w-[calc(100vw-2rem)] max-h-[calc(100vh-6rem)] flex flex-col rounded-2xl bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] shadow-2xl overflow-hidden anim-menu ring-1 ring-black/5 dark:ring-white/10">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--glass-border)] shrink-0">
          <div className={`w-7 h-7 rounded-xl flex items-center justify-center ${
            enabled ? 'bg-[color-mix(in_srgb,var(--error)_15%,transparent)] text-[var(--error)]' : 'bg-[var(--accent-soft)] text-[var(--accent)]'
          }`}>
            <FiMonitor size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[13.5px] font-serif font-bold text-[var(--text-primary)] tracking-tight">{t('computerControl')}</div>
            <div className="text-[11.5px] text-[var(--text-muted)]">
              {enabled ? t('computerActive') : t('computerInactive')}
            </div>
          </div>
          <button type="button" onClick={() => void openPreview()} disabled={openingPreview}
            title={t(previewVisible ? 'computerPreviewHide' : 'computerPreviewOpen')} aria-label={t(previewVisible ? 'computerPreviewHide' : 'computerPreviewOpen')}
            className="flex items-center gap-1.5 px-2 py-1.5 rounded-lg text-[11.5px] text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors cursor-pointer disabled:opacity-50 disabled:cursor-wait">
            <FiExternalLink size={12} /><span>{t(previewVisible ? 'computerPreviewHide' : 'computerPreviewOpen')}</span>
          </button>
          <button aria-label={t('close')} onClick={closeComputer}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer">
            <FiX size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {previewError && <p role="alert" className="text-[12px] text-[var(--error)]">{previewError}</p>}
          {!supported ? (
            <div className="px-3 py-4 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-[13px] text-[var(--text-secondary)]">
              {t('computerUnsupported')}
            </div>
          ) : (
            <>
              {/* What this actually grants */}
              <div className="px-3 py-2.5 rounded-xl bg-[color-mix(in_srgb,var(--warning)_10%,transparent)] border border-[color-mix(in_srgb,var(--warning)_25%,transparent)]">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--warning)] mb-1">
                  <FiAlertTriangle size={12} /> {t('computerWarnTitle')}
                </div>
                <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">{t('computerWarnBody')}</p>
              </div>

              {/* Master switch */}
              <button
                onClick={() => setEnabled(!enabled)}
                className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border transition-colors cursor-pointer ${
                  enabled
                    ? 'bg-[color-mix(in_srgb,var(--error)_10%,transparent)] border-[color-mix(in_srgb,var(--error)_30%,transparent)] hover:bg-[color-mix(in_srgb,var(--error)_15%,transparent)]'
                    : 'bg-[var(--bg-0)] border-[var(--border)] hover:bg-[var(--bg-3)]'
                }`}
              >
                <span className={`w-9 h-5 rounded-full shrink-0 flex items-center px-0.5 transition-colors ${
                  enabled ? 'bg-[var(--error)] justify-end' : 'bg-[var(--bg-4)] justify-start'
                }`}>
                  <span className="w-4 h-4 rounded-full bg-white shadow-sm" />
                </span>
                <span className="flex-1 text-left">
                  <span className="block text-[13px] font-medium">
                    {enabled ? t('computerDisable') : t('computerEnable')}
                  </span>
                <span className="block text-[11.5px] text-[var(--text-muted)]">{t('computerSessionOnly')}</span>
                </span>
              </button>

              {enabled && (
                <>
                  <div className="space-y-2 rounded-xl border border-[var(--border)] bg-[var(--bg-0)] p-3">
                    <div className="flex items-center justify-between gap-2">
                      <label htmlFor="computer-target" className="text-[13px] font-medium">{t('computerTarget')}</label>
                      <button type="button" onClick={loadApps} disabled={appBusy}
                        className="inline-flex items-center gap-1.5 rounded-md px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)] disabled:opacity-50">
                        <FiRefreshCw size={12} aria-hidden="true" /> {t('refresh')}
                      </button>
                    </div>
                    <select id="computer-target" disabled={appBusy || !apps?.length}
                      value={target?.id ?? ''} onChange={(event) => void selectApp(event.target.value)}
                      className="w-full rounded-lg border border-[var(--border)] bg-[var(--bg-2)] px-2 py-1.5 text-xs">
                      <option value="" disabled>{t('computerPickApp')}</option>
                      {target && !apps?.some((app) => app.id === target.id) && (
                        <option value={target.id}>{target.name}{target.title ? ` · ${target.title}` : ''}</option>
                      )}
                      {apps?.map((app) => (
                        <option key={app.id} value={app.id}>{app.name}{app.title ? ` · ${app.title}` : ''}</option>
                      ))}
                    </select>
                    <p className="text-xs text-[var(--text-muted)]">{t(apps?.length === 0 ? 'computerNoApps' : 'computerTargetHint')}</p>
                    {appError && <p role="alert" className="break-words text-xs text-[var(--error)]">{appError}</p>}
                  </div>
                  <button
                    onClick={panic}
                    className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--error)] text-white text-[13px] font-medium hover:opacity-90 transition-opacity cursor-pointer"
                  >
                    <FiSlash size={13} /> {t('computerStopNow')}
                  </button>
                </>
              )}

              {/* Permissions */}
              {isMac && (
                <div className="space-y-2">
                  <div className="text-[12px] font-medium text-[var(--text-secondary)]">{t('computerPermissions')}</div>
                  <PermissionRow
                    granted={accessibility}
                    label={t('computerAccessibility')}
                    hint={accessibility ? t('computerGranted') : t('computerAccessibilityHint')}
                    action={
                      <button onClick={requestPermissions}
                        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors cursor-pointer">
                        {t('computerOpenSettings')} <FiExternalLink size={11} />
                      </button>
                    }
                  />
                  <PermissionRow
                    granted={screenRecording}
                    label={t('computerScreenRecording')}
                    hint={screenRecording ? t('computerGranted') : t('computerScreenRecordingHint')}
                    action={
                      <button type="button" onClick={() => {
                        void window.electronAPI.computer.openScreenSettings().catch((error: Error) => setAppError(error.message));
                      }} className="shrink-0 rounded-lg px-2 py-1 text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)]">
                        {t('computerOpenSettings')} <FiExternalLink className="inline" size={11} />
                      </button>
                    }
                  />
                  {!enabled && appError && <p role="alert" className="break-words text-xs text-[var(--error)]">{appError}</p>}
                  {!ready && (
                    <p className="text-[11.5px] text-[var(--text-muted)] leading-relaxed px-1">
                      {t('computerRestartHint')}
                    </p>
                  )}
                </div>
              )}

              {/* How each action gets approved */}
              <div className="px-3 py-2.5 rounded-xl bg-[var(--bg-0)] border border-[var(--border)]">
                <div className="text-[12.5px] font-medium mb-0.5">{t('computerApproval')}</div>
                <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">
                  {approvalMode === 'fullAuto' ? t('computerApprovalAuto') : t('computerApprovalAsk')}
                </p>
              </div>

              {geometry && (
                <div className="flex items-center gap-2 px-1 text-[11.5px] text-[var(--text-muted)]">
                  <FiCrosshair size={11} />
                  {t('computerTarget')}: {geometry.logicalWidth}×{geometry.logicalHeight}
                  <span className="opacity-60">→</span>
                  {geometry.captureWidth}×{geometry.captureHeight} {t('computerAsSeen')}
                </div>
              )}

              {/* What the agent is looking at */}
              {lastShot && (
                <div className="rounded-xl overflow-hidden border border-[var(--border)]">
                  <div className="px-3 py-1.5 text-[11.5px] text-[var(--text-muted)] bg-[var(--bg-0)]">
                    {t('computerLastShot')}{target ? ` · ${target.name}` : ''}
                  </div>
                  <img src={lastShot} alt={t('computerLastShot')} className="w-full block" />
                </div>
              )}

              {/* Activity */}
              <div>
                <div className="flex items-center gap-2 mb-1.5">
                  <span className="text-[12px] font-medium text-[var(--text-secondary)]">{t('computerActivity')}</span>
                  <span className="text-[11px] text-[var(--text-muted)]">{activity.length}</span>
                  <div className="flex-1" />
                  {activity.length > 0 && (
                    <button onClick={clearActivity} title={t('previewClearLogs')}
                      className="p-1 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer">
                      <FiTrash2 size={12} />
                    </button>
                  )}
                </div>
                <div className="max-h-[180px] overflow-y-auto rounded-xl bg-[var(--bg-0)] border border-[var(--border)] p-2 space-y-1">
                  {activity.length === 0 ? (
                    <div className="text-[12px] text-[var(--text-muted)] px-1 py-1">{t('computerNoActivity')}</div>
                  ) : (
                    activity.map((entry) => (
                      <div key={entry.id} className="flex items-start gap-2 text-[12px]">
                        <span className={`w-1.5 h-1.5 rounded-full shrink-0 mt-1.5 ${
                          entry.ok ? 'bg-[var(--success)]' : 'bg-[var(--error)]'
                        }`} />
                        <span className="text-[var(--text-muted)] ff-mono shrink-0">
                          {new Date(entry.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })}
                        </span>
                        <span className="flex-1 text-[var(--text-secondary)] break-words">{entry.description}</span>
                      </div>
                    ))
                  )}
                  <div ref={bottomRef} />
                </div>
              </div>
            </>
          )}
        </div>
      </div>
    </>
  );
}
