import { useEffect, useRef } from 'react';
import {
  FiX, FiMonitor, FiAlertTriangle, FiCheck, FiExternalLink, FiSlash, FiTrash2, FiCrosshair,
} from 'react-icons/fi';
import { useUIStore, useLanguageStore, useComputerStore, useSettingsStore } from '../../stores';

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
        granted ? 'bg-[var(--success)]/15 text-[var(--success)]' : 'bg-[var(--warning)]/15 text-[var(--warning)]'
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
  const { t } = useLanguageStore();
  const approvalMode = useSettingsStore((s) => s.approvalMode);
  const {
    enabled, supported, platform, accessibility, screenRecording, geometry,
    activity, lastShot, refresh, setEnabled, requestPermissions, panic, clearActivity,
  } = useComputerStore();
  const bottomRef = useRef<HTMLDivElement>(null);

  useEffect(() => { refresh(); }, [refresh]);
  useEffect(() => { bottomRef.current?.scrollIntoView({ block: 'end' }); }, [activity.length]);

  const isMac = platform === 'darwin';
  const ready = accessibility && screenRecording;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/20" onClick={closeComputer} />
      <div className="fixed right-4 top-16 z-50 w-[420px] max-h-[calc(100vh-6rem)] flex flex-col rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] shadow-2xl overflow-hidden">
        {/* Header */}
        <div className="flex items-center gap-2.5 px-4 py-3 border-b border-[var(--border)] shrink-0">
          <div className={`w-7 h-7 rounded-xl flex items-center justify-center ${
            enabled ? 'bg-[var(--error)]/15 text-[var(--error)]' : 'bg-[var(--accent-soft)] text-[var(--accent)]'
          }`}>
            <FiMonitor size={14} />
          </div>
          <div className="flex-1 min-w-0">
            <div className="text-[14px] font-medium">{t('computerControl')}</div>
            <div className="text-[11.5px] text-[var(--text-muted)]">
              {enabled ? t('computerActive') : t('computerInactive')}
            </div>
          </div>
          <button onClick={closeComputer}
            className="p-1.5 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors">
            <FiX size={15} />
          </button>
        </div>

        <div className="flex-1 min-h-0 overflow-y-auto p-4 space-y-3">
          {!supported ? (
            <div className="px-3 py-4 rounded-xl bg-[var(--bg-0)] border border-[var(--border)] text-[13px] text-[var(--text-secondary)]">
              {t('computerUnsupported')}
            </div>
          ) : (
            <>
              {/* What this actually grants */}
              <div className="px-3 py-2.5 rounded-xl bg-[var(--warning)]/10 border border-[var(--warning)]/25">
                <div className="flex items-center gap-1.5 text-[12.5px] font-medium text-[var(--warning)] mb-1">
                  <FiAlertTriangle size={12} /> {t('computerWarnTitle')}
                </div>
                <p className="text-[12px] text-[var(--text-secondary)] leading-relaxed">{t('computerWarnBody')}</p>
              </div>

              {/* Master switch */}
              <button
                onClick={() => setEnabled(!enabled)}
                className={`w-full flex items-center gap-3 px-3.5 py-3 rounded-xl border transition-colors ${
                  enabled
                    ? 'bg-[var(--error)]/10 border-[var(--error)]/30 hover:bg-[var(--error)]/15'
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
                <button
                  onClick={panic}
                  className="w-full flex items-center justify-center gap-2 px-3 py-2.5 rounded-xl bg-[var(--error)] text-white text-[13px] font-medium hover:opacity-90 transition-opacity"
                >
                  <FiSlash size={13} /> {t('computerStopNow')}
                </button>
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
                        className="shrink-0 flex items-center gap-1 px-2 py-1 rounded-lg text-[12px] text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors">
                        {t('computerOpenSettings')} <FiExternalLink size={11} />
                      </button>
                    }
                  />
                  <PermissionRow
                    granted={screenRecording}
                    label={t('computerScreenRecording')}
                    hint={screenRecording ? t('computerGranted') : t('computerScreenRecordingHint')}
                  />
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
                  {t('computerScreen')}: {geometry.logicalWidth}×{geometry.logicalHeight}
                  <span className="opacity-60">→</span>
                  {geometry.captureWidth}×{geometry.captureHeight} {t('computerAsSeen')}
                </div>
              )}

              {/* What the agent is looking at */}
              {lastShot && (
                <div className="rounded-xl overflow-hidden border border-[var(--border)]">
                  <div className="px-3 py-1.5 text-[11.5px] text-[var(--text-muted)] bg-[var(--bg-0)]">
                    {t('computerLastShot')}
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
                      className="p-1 rounded-lg text-[var(--text-muted)] hover:bg-[var(--bg-3)] transition-colors">
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
