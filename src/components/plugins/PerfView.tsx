import { useMonitorStore } from '../../stores/monitor.store';
import { useLanguageStore } from '../../stores';
import { formatBytes } from '../../core/monitor/perf';

function timeAgo(ts: number): string {
  const s = Math.max(0, Math.round((Date.now() - ts) / 1000));
  if (s < 60) return `${s}s`;
  return `${Math.floor(s / 60)}m`;
}

/** Full-size performance monitor view inside the plugin library. */
export default function PerfView() {
  const enabled = useMonitorStore((s) => s.enabled);
  const setEnabled = useMonitorStore((s) => s.setEnabled);
  const samples = useMonitorStore((s) => s.samples);
  const anomalies = useMonitorStore((s) => s.anomalies);
  const errors = useMonitorStore((s) => s.errors);
  const clearErrors = useMonitorStore((s) => s.clearErrors);
  const { t } = useLanguageStore();

  const last = samples[samples.length - 1] ?? null;

  return (
    <div className="px-2 py-1">
      <div className="flex items-center gap-2 px-1 mb-2">
        <span className="text-[13px] text-[var(--text-secondary)] flex-1">
          {enabled ? `${t('monitorHeap')} · ${t('monitorMain')} · ${t('monitorLoad')}` : t('monitorOffHint')}
        </span>
        <button
          onClick={() => setEnabled(!enabled)}
          className={`px-3 py-1.5 rounded-lg text-[12px] font-medium transition-colors shrink-0 ${
            enabled
              ? 'bg-[var(--bg-3)] text-[var(--text-secondary)] hover:bg-[var(--bg-4)]'
              : 'bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)]'
          }`}
        >
          {t(enabled ? 'monitorOff' : 'monitorOn')}
        </button>
      </div>

      {last ? (
        <div className="mx-1 mb-3 px-3 py-2.5 rounded-xl bg-[var(--bg-2)] grid grid-cols-2 gap-x-3 gap-y-1.5 text-[13px]">
          <span className="text-[var(--text-muted)]">{t('monitorHeap')}</span>
          <span className="text-right font-mono">{formatBytes(last.jsHeapBytes)}</span>
          <span className="text-[var(--text-muted)]">{t('monitorMain')}</span>
          <span className="text-right font-mono">{formatBytes(last.mainRSSBytes)}</span>
          <span className="text-[var(--text-muted)]">{t('monitorFree')}</span>
          <span className="text-right font-mono">{formatBytes(last.freeMemBytes)}</span>
          <span className="text-[var(--text-muted)]">{t('monitorLoad')}</span>
          <span className="text-right font-mono">{last.loadPerCpu.toFixed(1)}</span>
        </div>
      ) : null}

      {anomalies.slice(0, 5).map((a) => (
        <div key={a.id} className="mb-1.5 px-3 py-2 rounded-xl bg-[var(--error)]/10 text-[12px] text-[var(--text-secondary)]">
          <span className="text-[var(--text-muted)]">{timeAgo(a.t)} · </span>
          {a.summary}
        </div>
      ))}

      <div className="flex items-center px-1 mt-2 mb-1">
        <span className="text-[11px] uppercase tracking-wider text-[var(--text-muted)] flex-1">
          {t('monitorErrors')} · {errors.length}
        </span>
        {errors.length > 0 && (
          <button onClick={clearErrors} className="text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] transition-colors">
            {t('monitorClear')}
          </button>
        )}
      </div>
      {errors.length === 0 ? (
        <p className="px-1 text-[12px] text-[var(--text-muted)]">{t('monitorNoErrors')}</p>
      ) : (
        errors.slice(-10).reverse().map((e, i) => (
          <p key={`${e.t}-${i}`} className="px-1 text-[11px] font-mono text-[var(--text-secondary)] truncate mb-0.5" title={e.message}>
            [{e.source}] {e.message}
          </p>
        ))
      )}
    </div>
  );
}
