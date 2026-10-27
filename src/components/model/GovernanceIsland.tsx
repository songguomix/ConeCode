import { useEffect, useRef, useState } from 'react';
import { FiShield } from 'react-icons/fi';
import { useSettingsStore, useLanguageStore, useUIStore } from '../../stores';

const APPROVAL_MODES = [
  { value: 'suggest', labelKey: 'approvalSuggest', descKey: 'approvalSuggestDesc' },
  { value: 'autoEdit', labelKey: 'approvalAutoEdit', descKey: 'approvalAutoEditDesc' },
  { value: 'fullAuto', labelKey: 'approvalFullAuto', descKey: 'approvalFullAutoDesc' },
] as const;

const SANDBOX_MODES = [
  { value: 'workspaceWrite', labelKey: 'sandboxOn' },
  { value: 'off', labelKey: 'sandboxOff' },
] as const;

type ApprovalMode = (typeof APPROVAL_MODES)[number]['value'];
type SandboxMode = (typeof SANDBOX_MODES)[number]['value'];

/**
 * One compact "island" pill in the model row that carries the two runtime
 * safety decisions — operation approval and the command sandbox — which used
 * to live in Settings. The pill opens a small popup built like the model /
 * mode popups so they stay one visual family.
 */
export default function GovernanceIsland() {
  const { t } = useLanguageStore();
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  const baseApproval = useSettingsStore((s) => s.approvalMode);
  const overrideApproval = useSettingsStore((s) => s.approvalOverride);
  const sandboxMode = useSettingsStore((s) => s.sandboxMode);
  const sandboxAllowNetwork = useSettingsStore((s) => s.sandboxAllowNetwork);
  const updateSettings = useSettingsStore((s) => s.updateSettings);

  // Seatbelt is macOS-only; elsewhere the switch would be a lie.
  const sandboxSupported = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');

  // Unattended runs (RSI / Autopilot) borrow the switch temporarily.
  const effectiveApproval: ApprovalMode = overrideApproval ?? baseApproval;
  const overridden = !!overrideApproval && overrideApproval !== baseApproval;

  // A stale or hand-edited settings blob can carry a value that is no longer
  // (or never was) a real mode — fall back rather than crash on labelKey.
  const approvalMeta = APPROVAL_MODES.find((m) => m.value === effectiveApproval) ?? APPROVAL_MODES[0];
  const sandboxOn = sandboxMode === 'workspaceWrite' && sandboxSupported;
  const cautious = effectiveApproval === 'fullAuto';

  useEffect(() => {
    if (!open) return;
    const handleDown = (e: MouseEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', handleDown);
    return () => document.removeEventListener('mousedown', handleDown);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    // Same upward space as the model menu — one popup at a time.
    useUIStore.getState().closeModelSelector();
  }, [open]);

  return (
    <div
      ref={rootRef}
      className="relative shrink-0"
      onKeyDown={(e) => {
        if (e.key === 'Escape') { e.stopPropagation(); setOpen(false); }
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((o) => !o)}
        title={`${t('securityPolicy')} · ${t(approvalMeta.labelKey)} · ${t('sandbox')} ${sandboxOn ? t('sandboxOn') : t('sandboxOff')}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        className={`flex items-center gap-1.5 h-8 px-2.5 rounded-full border transition-all backdrop-blur-md shadow-2xs ${
          open
            ? 'bg-[var(--accent-soft)] border-[var(--accent)]/50 text-[var(--accent)] shadow-xs'
            : cautious
              ? 'bg-red-500/10 border-red-500/40 text-red-500 hover:bg-red-500/15'
              : 'bg-[var(--glass-card)] hover:bg-[var(--bg-2)] border-[var(--glass-border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
        }`}
      >
        <FiShield size={12} className={cautious ? 'shrink-0' : sandboxOn ? 'text-[var(--success)] shrink-0' : 'text-[var(--warning)] shrink-0'} />
        <span className="text-[11px] font-semibold whitespace-nowrap">{t('securityPolicy')}</span>
        <span className={`w-1.5 h-1.5 rounded-full shrink-0 ${sandboxOn ? 'bg-[var(--success)]' : 'bg-[var(--warning)]'}`} />
      </button>

      {open && (
        <div
          role="dialog"
          className="absolute bottom-full right-0 mb-2.5 w-[300px] p-1.5 rounded-2xl bg-[var(--glass-surface)] backdrop-blur-2xl border border-[var(--glass-border)] shadow-2xl z-50 anim-effort-pop ring-1 ring-black/5 dark:ring-white/10"
        >
          <div className="px-2.5 pt-1 pb-1.5 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
            <FiShield size={11} className="text-[var(--accent)]" />
            {t('governanceTitle')}
          </div>

          {/* Operation approval */}
          <div className="px-2.5 py-2 space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-[var(--text-primary)]">{t('approvalMode')}</span>
              <span className={`text-[10px] font-medium ${cautious ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>
                {t(approvalMeta.labelKey)}
              </span>
            </div>
            <div className="grid grid-cols-3 gap-1 p-0.5 bg-[var(--bg-3)] border border-[var(--glass-border)] rounded-lg">
              {APPROVAL_MODES.map((m) => (
                <button
                  key={m.value}
                  type="button"
                  onClick={() => updateSettings({ approvalMode: m.value })}
                  aria-pressed={effectiveApproval === m.value}
                  className={`py-1 text-[11px] font-medium rounded-md text-center transition-all cursor-pointer ${
                    effectiveApproval === m.value
                      ? m.value === 'fullAuto'
                        ? 'bg-red-500 text-white shadow-xs'
                        : 'bg-[var(--glass-card)] text-[var(--accent)] shadow-xs'
                      : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                  }`}
                >
                  {t(m.labelKey)}
                </button>
              ))}
            </div>
            <p className={`text-[11px] leading-relaxed ${cautious ? 'text-red-500 font-medium' : 'text-[var(--text-muted)]'}`}>
              {t(approvalMeta.descKey)}
            </p>
            {overridden && (
              <p className="px-2 py-1 rounded-lg bg-amber-500/10 border border-amber-500/25 text-[10.5px] text-amber-600 dark:text-amber-400 leading-relaxed">
                {t('approvalOverrideNotice')}
              </p>
            )}
          </div>

          <div className="mx-2.5 border-t border-[var(--glass-border)]" />

          {/* Command sandbox */}
          <div className="px-2.5 py-2 space-y-2">
            <div className="flex items-baseline justify-between">
              <span className="text-xs font-semibold text-[var(--text-primary)]">{t('sandbox')}</span>
              <span className={`text-[10px] font-medium ${sandboxOn ? 'text-[var(--success)]' : 'text-amber-500'}`}>
                {sandboxSupported ? (sandboxOn ? t('sandboxOn') : t('sandboxOff')) : ''}
              </span>
            </div>
            {sandboxSupported ? (
              <>
                <div className="grid grid-cols-2 gap-1 p-0.5 bg-[var(--bg-3)] border border-[var(--glass-border)] rounded-lg">
                  {SANDBOX_MODES.map((m) => (
                    <button
                      key={m.value}
                      type="button"
                      onClick={() => updateSettings({ sandboxMode: m.value })}
                      aria-pressed={sandboxMode === m.value}
                      className={`py-1 text-[11px] font-medium rounded-md text-center transition-all cursor-pointer ${
                        sandboxMode === m.value
                          ? sandboxOn
                            ? 'bg-[var(--success)] text-white shadow-xs'
                            : 'bg-red-500 text-white shadow-xs'
                          : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                      }`}
                    >
                      {t(m.labelKey)}
                    </button>
                  ))}
                </div>
                <p className={`text-[11px] leading-relaxed ${sandboxOn ? 'text-[var(--text-muted)]' : 'text-red-500 font-medium'}`}>
                  {t(sandboxOn ? 'sandboxOnDesc' : 'sandboxOffDesc')}
                </p>
                {sandboxOn && (
                  <label className="flex items-center justify-between gap-2 px-2 py-1.5 rounded-lg bg-[var(--bg-3)]/70 border border-[var(--glass-border)] text-[11px] text-[var(--text-secondary)] cursor-pointer">
                    <span>{t('sandboxNetwork')}</span>
                    <input
                      type="checkbox"
                      checked={sandboxAllowNetwork}
                      onChange={(e) => updateSettings({ sandboxAllowNetwork: e.target.checked })}
                      className="accent-[var(--accent)] shrink-0"
                    />
                  </label>
                )}
              </>
            ) : (
              <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
                {t('sandboxUnavailable')}
              </p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
