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
    <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <FiCamera size={14} className="text-[var(--accent)]" />
        <span className="font-medium text-sm">{t('screenshot')}</span>
        {shortcut ? (
          <kbd className="ml-auto text-[11px] px-2 py-1 rounded-lg bg-[var(--bg-3)] text-[var(--text-secondary)] font-sans">
            {prettyShortcut(shortcut)}
          </kbd>
        ) : (
          <span className="ml-auto text-[11px] px-2 py-1 rounded-lg bg-[var(--bg-3)] text-[var(--text-muted)]">
            {t('screenshotNoShortcut')}
          </span>
        )}
      </div>
      <p className="mb-3 text-xs text-[var(--text-muted)]">{t('screenshotShortcutDesc')}</p>
      <div className="flex items-center gap-2 flex-wrap">
        {recording ? (
          <button
            autoFocus
            onKeyDown={(e) => void onKey(e)}
            onBlur={() => setRecording(false)}
            className="px-3 py-1.5 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] text-xs font-medium animate-pulse outline-none"
          >
            {t('screenshotPressKeys')}
          </button>
        ) : (
          <button onClick={() => { setFailed(false); setRecording(true); }}
            className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors">
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
          className="px-3 py-1.5 rounded-lg bg-[var(--bg-3)] text-xs text-[var(--text-secondary)] hover:bg-[var(--bg-4)] transition-colors">
          {t('screenshotResetShortcut')}
        </button>
        {shortcut && (
          <button
            onClick={() => void (async () => {
              setFailed(false);
              setRecording(false);
              await applyShortcut(null);
            })()}
            className="px-3 py-1.5 rounded-lg text-xs text-[var(--text-muted)] hover:text-[var(--error)] transition-colors">
            {t('screenshotDisableShortcut')}
          </button>
        )}
        <button onClick={() => void start()}
          className="ml-auto px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs font-medium hover:bg-[var(--accent-hover)] transition-colors">
          {t('screenshotTakeNow')}
        </button>
      </div>
      {failed && <p className="mt-2 text-xs text-[var(--error)]">{t('screenshotShortcutFailed')}</p>}
    </div>
  );
}
