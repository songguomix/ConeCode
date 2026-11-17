import { useState } from 'react';
import {
  FiCamera, FiCheckCircle, FiSliders, FiTrash2, FiMonitor, FiClock, FiSave, FiAlertCircle,
} from 'react-icons/fi';
import { useAutoScreenshotStore, type AutoScreenshotItem, type AutoScreenshotTarget } from '../../stores/autoScreenshot.store';
import { useLanguageStore } from '../../stores/language.store';

export default function AutoScreenshotPluginView() {
  const { config, history, capturing, lastError, setConfig, captureNow, removeHistoryItem, clearHistory } = useAutoScreenshotStore();
  const { t } = useLanguageStore();
  const [previewItem, setPreviewItem] = useState<AutoScreenshotItem | null>(null);

  const targets: { id: AutoScreenshotTarget; labelKey: string }[] = [
    { id: 'auto', labelKey: 'autoScreenshotTargetAuto' },
    { id: 'window', labelKey: 'autoScreenshotTargetWindow' },
    { id: 'preview', labelKey: 'autoScreenshotTargetPreview' },
    { id: 'screen', labelKey: 'autoScreenshotTargetScreen' },
  ];

  return (
    <div className="space-y-3.5 text-xs min-w-0">
      {/* Intro & Native Tool Status Banner */}
      <div className="p-3.5 rounded-xl bg-[var(--accent-soft)] border border-[color-mix(in_srgb,var(--accent)_15%,transparent)]">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0 flex-1 space-y-1">
            <div className="flex flex-wrap items-center gap-2">
              <span className="p-1.5 rounded-lg bg-[var(--accent)] text-white">
                <FiCamera size={15} />
              </span>
              <h3 className="font-semibold text-sm text-[var(--text-primary)]">
                {t('pluginName_auto-screenshot')}
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                <FiCheckCircle size={10} /> {t('nativeToolReady')}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {t('autoScreenshotPluginDesc')}
            </p>
          </div>
          <button
            type="button"
            onClick={() => void captureNow({ label: 'manual-test' })}
            disabled={capturing}
            className="px-2.5 py-1.5 rounded-lg bg-[var(--accent)] text-white font-medium text-xs flex items-center gap-1.5 hover:bg-[var(--accent-hover)] transition-colors shrink-0 cursor-pointer disabled:opacity-50"
          >
            <FiCamera size={13} />
            {capturing ? t('autoScreenshotCapturing') : t('autoScreenshotTestBtn')}
          </button>
        </div>
      </div>

      {lastError && (
        <div className="p-2.5 rounded-xl bg-[color-mix(in_srgb,var(--error)_10%,transparent)] border border-[color-mix(in_srgb,var(--error)_30%,transparent)] flex items-center gap-2 text-[11px] text-[var(--error)]">
          <FiAlertCircle size={13} className="shrink-0" />
          <span className="truncate">{lastError}</span>
        </div>
      )}

      {/* Capture Settings */}
      <div className="p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] space-y-3 shadow-2xs">
        <div className="flex items-center gap-2 pb-2 border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] text-[var(--text-primary)] font-medium">
          <FiSliders size={14} className="text-[var(--accent)]" />
          <span>{t('autoScreenshotSettings')}</span>
        </div>

        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
            <FiMonitor size={12} />
            <span>{t('autoScreenshotDefaultTarget')}</span>
          </label>
          <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
            {targets.map((item) => {
              const active = config.defaultTarget === item.id;
              return (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => setConfig({ defaultTarget: item.id })}
                  className={`py-1.5 px-2.5 rounded-lg text-center border transition-all cursor-pointer ${
                    active
                      ? 'bg-[var(--accent)] text-white border-[var(--accent)] shadow-2xs font-medium'
                      : 'bg-[var(--bg-1)] text-[var(--text-secondary)] border-[var(--border)] hover:bg-[var(--bg-3)]'
                  }`}
                >
                  <span className="text-[11px]">{t(item.labelKey)}</span>
                </button>
              );
            })}
          </div>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-1">
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center gap-1.5">
              <FiClock size={12} />
              <span>{t('autoScreenshotDelay')}</span>
            </label>
            <select
              value={config.captureDelayMs}
              onChange={(e) => setConfig({ captureDelayMs: Number(e.target.value) })}
              className="w-full px-2.5 py-1.5 rounded-lg bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] cursor-pointer"
            >
              <option value={0}>0 ms</option>
              <option value={150}>150 ms</option>
              <option value={300}>300 ms</option>
              <option value={600}>600 ms</option>
              <option value={1000}>1000 ms</option>
            </select>
          </div>

          <div className="flex items-center justify-between p-2.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)]">
            <div className="min-w-0 pr-2">
              <div className="text-[11px] font-medium text-[var(--text-primary)] flex items-center gap-1.5">
                <FiSave size={12} className="text-[var(--accent)]" />
                <span>{t('autoScreenshotSaveDisk')}</span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => setConfig({ autoSaveToDisk: !config.autoSaveToDisk })}
              className={`w-9 h-5 rounded-full transition-colors shrink-0 relative cursor-pointer ${config.autoSaveToDisk ? 'bg-[var(--accent)]' : 'bg-[var(--bg-4)]'}`}
            >
              <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${config.autoSaveToDisk ? 'left-[18px]' : 'left-0.5'}`} />
            </button>
          </div>
        </div>
      </div>

      {/* Agent Rule Tip */}
      <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] space-y-1">
        <p className="font-medium text-[var(--text-primary)] text-xs">
          {t('autoScreenshotAgentTipTitle')}
        </p>
        <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
          {t('autoScreenshotAgentTipDesc')}
        </p>
      </div>

      {/* Recent Captures */}
      {history.length > 0 && (
        <div className="p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] space-y-3 shadow-2xs">
          <div className="flex items-center justify-between gap-2">
            <span className="font-medium text-[var(--text-primary)]">
              {t('autoScreenshotHistory')} ({history.length})
            </span>
            <button
              type="button"
              onClick={clearHistory}
              className="text-[11px] text-[var(--text-muted)] hover:text-[var(--error)] flex items-center gap-1 cursor-pointer"
            >
              <FiTrash2 size={11} />
              <span>{t('autoScreenshotClear')}</span>
            </button>
          </div>
          <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
            {history.slice(0, 9).map((item) => (
              <div
                key={item.id}
                className="group relative rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-1)] hover:border-[var(--accent)] transition-all cursor-pointer"
                onClick={() => setPreviewItem(item)}
              >
                <img
                  src={item.dataUrl}
                  alt={item.label}
                  className="w-full aspect-video object-cover"
                  loading="lazy"
                />
                <div className="p-1.5 flex items-center justify-between gap-1 text-[10px]">
                  <span className="truncate font-medium text-[var(--text-primary)]">{item.label}</span>
                  <span className="text-[var(--text-muted)] shrink-0">{item.width}×{item.height}</span>
                </div>
                <button
                  type="button"
                  onClick={(e) => { e.stopPropagation(); removeHistoryItem(item.id); }}
                  className="absolute top-1.5 right-1.5 w-5 h-5 rounded-md bg-black/60 text-white opacity-0 group-hover:opacity-100 flex items-center justify-center transition-opacity cursor-pointer"
                >
                  <FiTrash2 size={10} />
                </button>
              </div>
            ))}
          </div>
        </div>
      )}

      {previewItem && (
        <div
          className="fixed inset-0 z-50 bg-black/75 flex items-center justify-center p-4"
          onClick={() => setPreviewItem(null)}
        >
          <div
            className="max-w-4xl w-full rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] overflow-hidden shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between px-3.5 py-2 border-b border-[var(--border)] text-xs">
              <span className="font-medium text-[var(--text-primary)]">
                {previewItem.label} · {previewItem.target} ({previewItem.width}×{previewItem.height})
              </span>
              <button
                type="button"
                onClick={() => setPreviewItem(null)}
                className="px-2 py-0.5 rounded-md bg-[var(--bg-3)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"
              >
                ESC
              </button>
            </div>
            <img src={previewItem.dataUrl} alt={previewItem.label} className="w-full max-h-[75vh] object-contain bg-black" />
          </div>
        </div>
      )}
    </div>
  );
}
