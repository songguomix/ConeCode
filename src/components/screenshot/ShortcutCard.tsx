import { useState } from 'react';
import { FiCamera } from 'react-icons/fi';
import { useScreenshotStore, DEFAULT_SCREENSHOT_SHORTCUT } from '../../stores/screenshot.store';
import { formatAccelerator, prettyShortcut } from '../../core/screenshot/shortcut';

/** Screenshot card in Settings → General: trigger now + customize the hotkey. */
export default function ShortcutCard({ t }: { t: (k: string) => string }) {
  const shortcut = useScreenshotStore((s) => s.shortcut);
  const applyShortcut = useScreenshotStore((s) => s.applyShortcut);
  const start = useScreenshotStore((s) => s.start);
  const [recording, setRecording] = useState(false);
  const [failed, setFailed] = useState(false);
  const [busy, setBusy] = useState(false);

  const onKey = async (e: React.KeyboardEvent) => {
    e.preventDefault();
    e.stopPropagation();
    if (e.key === 'Escape' && !e.metaKey && !e.ctrlKey && !e.shiftKey && !e.altKey) {
      setRecording(false);
      return;
    }
    const acc = formatAccelerator(e);
    if (!acc || busy) return;
    setBusy(true);
    const ok = await applyShortcut(acc);
    setBusy(false);
    setFailed(!ok);
    if (ok) setRecording(false);
  };

  return (
    <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs">
      <div className="flex items-center justify-between gap-4">
        <div className="flex-1 min-w-0 pr-4">
          <div className="flex items-center gap-2">
            <FiCamera size={14} className="text-[var(--accent)]" />
            <span className="font-semibold text-sm text-[var(--text-primary)]">{t('screenshot')}</span>
            {shortcut ? (
              <kbd className="text-[11px] px-2 py-0.5 rounded-lg bg-[var(--bg-1)] border border-[var(--border)] text-[var(--text-primary)] font-mono shadow-2xs">
                {prettyShortcut(shortcut)}
              </kbd>
            ) : (
              <span className="text-[11px] px-2 py-0.5 rounded-lg bg-[var(--bg-1)] text-[var(--text-muted)] border border-[var(--border)]">
                {t('screenshotNoShortcut')}
              </span>
            )}
          </div>
          <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed">{t('screenshotShortcutDesc')}</p>
          {failed && <p className="mt-1 text-xs text-[var(--error)] font-medium">{t('screenshotShortcutFailed')}</p>}
        </div>

        <div className="flex items-center gap-2 shrink-0 flex-wrap justify-end">
          {recording ? (
            <button
              autoFocus
              onKeyDown={(e) => void onKey(e)}
              onBlur={() => setRecording(false)}
              className="px-3 py-1.5 rounded-xl bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)] text-xs font-semibold animate-pulse outline-none cursor-pointer"
            >
              {t('screenshotPressKeys')}
            </button>
          ) : (
            <button
              onClick={() => { setFailed(false); setRecording(true); }}
              className="px-3 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50 transition-all cursor-pointer shadow-2xs"
            >
              {t('screenshotChangeShortcut')}
            </button>
          )}
          <button
            onClick={() => void (async () => {
              setFailed(false);
              setRecording(false);
              const ok = await applyShortcut(DEFAULT_SCREENSHOT_SHORTCUT);
              setFailed(!ok);
            })()}
            className="px-3 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:border-[var(--accent)]/50 transition-all cursor-pointer shadow-2xs"
          >
            {t('screenshotResetShortcut')}
          </button>
          {shortcut && (
            <button
              onClick={() => void (async () => {
                setFailed(false);
                setRecording(false);
                await applyShortcut(null);
              })()}
              className="px-2.5 py-1.5 rounded-xl text-xs text-[var(--text-muted)] hover:text-[var(--error)] transition-colors cursor-pointer"
            >
              {t('screenshotDisableShortcut')}
            </button>
          )}
          <button
            onClick={() => void start()}
            className="px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-medium hover:opacity-95 shadow-2xs transition-all cursor-pointer"
          >
            {t('screenshotTakeNow')}
          </button>
        </div>
      </div>
    </div>
  );
}
