import { useState } from 'react';
import { useLanguageStore } from '../../stores/language.store';

interface Props {
  requestPermission: () => Promise<unknown>;
  retry: () => Promise<unknown>;
  retryLabel: string;
}

export default function ScreenRecordingRecovery({ requestPermission, retry, retryLabel }: Props) {
  const { t } = useLanguageStore();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : t('rsiOperationFailed'));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="mt-2 space-y-2 text-xs leading-relaxed text-[var(--text-muted)]">
      <div className="flex flex-wrap gap-2">
        <button type="button" disabled={busy} onClick={() => void run(requestPermission)}
          className="rounded-lg bg-[var(--accent)] px-2.5 py-1 font-medium text-white hover:bg-[var(--accent-hover)] disabled:opacity-50">
          {t('rsiAskScreen')}
        </button>
        <button type="button" disabled={busy} onClick={() => void run(retry)}
          className="rounded-lg bg-[var(--bg-3)] px-2.5 py-1 font-medium text-[var(--text-secondary)] hover:bg-[var(--bg-4)] disabled:opacity-50">
          {retryLabel}
        </button>
      </div>
      <p>{t('computerRestartHint')}{' '}
        <button type="button" disabled={busy} onClick={() => void run(() => window.electronAPI.screenshot.relaunch())}
          className="text-[var(--accent)] underline disabled:opacity-50">{t('screenshotRelaunch')}</button>
      </p>
      <details>
        <summary className="cursor-pointer">{t('screenRecordingAfterUpdate')}</summary>
        <p className="mt-1">{t('screenRecordingAfterUpdateHint')}</p>
      </details>
      {error && <p role="alert" className="break-words text-[var(--error)]">{error}</p>}
    </div>
  );
}
