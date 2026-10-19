import { useEffect } from 'react';
import { FiRefreshCw, FiGift } from 'react-icons/fi';
import { useFreeStore } from '../../stores/free.store';
import { formatCount } from '../../core/pricing/cost';
import { FREE_WEEKLY_TOKEN_LIMIT } from '../../core/providers/free.adapter';
import { useModelStore } from '../../stores/model.store';
import { useLanguageStore } from '../../stores/language.store';
import { FREE_PROVIDER_ID } from '../../core/providers/free.adapter';

export default function FreeProviderCard() {
  const { status, loading, error, refresh } = useFreeStore();
  const weeklyUsed = useFreeStore((s) => s.weeklyUsed);
  const selectModel = useModelStore((s) => s.selectModel);
  const locale = useLanguageStore((s) => s.locale);
  const zh = locale.startsWith('zh');
  const date = (value: string) => new Date(value).toLocaleString(locale);

  useEffect(() => {
    void refresh();
  }, [refresh]);
  return (
    <section aria-label="ConeCode Free" className="bg-[var(--bg-2)] border border-[var(--accent)]/40 rounded-2xl p-4 shadow-2xs space-y-3">
      <div className="flex items-center gap-3">
        <FiGift className="text-[var(--accent)] shrink-0" size={20} />
        <div className="flex-1 min-w-0">
          <h3 className="font-semibold text-sm text-[var(--text-primary)]">ConeCode Free</h3>
          <p className="text-xs text-[var(--text-muted)] mt-1">{zh ? '赠送模型，无需配置 API Key。' : 'Gifted models. No API key required.'}</p>
        </div>
        <button type="button" onClick={() => void refresh()} disabled={loading} aria-label={zh ? '刷新免费服务状态' : 'Refresh free service'} className="p-2 rounded-lg hover:bg-[var(--bg-1)] text-[var(--text-secondary)] disabled:opacity-50">
          <FiRefreshCw size={15} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      <p role="status" className={`text-xs ${status?.available ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
        {error ? (zh ? error : 'ConeCode Free is temporarily unavailable. Please try again later.') : status?.available ? (zh ? '正在开放，可直接选择模型使用' : 'Available. Select a model to start.') : loading && !status ? (zh ? '正在获取开放状态…' : 'Checking availability…') : (zh ? '当前未开放' : 'Currently unavailable')}
      </p>
      {status?.mode === 'scheduled' && status.startsAt && status.endsAt && <p className="text-xs text-[var(--text-secondary)]">{zh ? '开放时间：' : 'Available: '}{date(status.startsAt)} — {date(status.endsAt)}</p>}
      {!!status?.models.length && <div className="flex flex-wrap gap-2">{status.models.map((model) => (
        <button key={model.id} type="button" onClick={() => selectModel(model.id, FREE_PROVIDER_ID)} title={model.id} className="px-2.5 py-1.5 text-xs rounded-lg border border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-primary)] hover:border-[var(--accent)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-[var(--accent)]">{model.name}</button>
      ))}</div>}
      {status?.available && (
        <div className="space-y-1.5">
          <div className="flex items-center justify-between text-xs text-[var(--text-secondary)]">
            <span>{zh ? '本周用量' : 'Weekly usage'}</span>
            <span className="text-[var(--text-primary)]">{formatCount(Math.max(status.usage?.used ?? status.usedTokens ?? 0, weeklyUsed))} / {formatCount(status.usage?.limit ?? status.weeklyLimit ?? FREE_WEEKLY_TOKEN_LIMIT)}</span>
          </div>
          <div className="h-1.5 w-full rounded-full bg-[var(--bg-3)] overflow-hidden">
            <div className="h-full rounded-full bg-[var(--accent)]" style={{ width: `${Math.min(100, ((Math.max(status.usage?.used ?? status.usedTokens ?? 0, weeklyUsed)) / (status.usage?.limit ?? status.weeklyLimit ?? FREE_WEEKLY_TOKEN_LIMIT)) * 100)}%` }} />
          </div>
          {(status.usage?.resetsAt ?? status.resetsAt) && <p className="text-[10px] text-[var(--text-muted)]">{zh ? '周期重置时间：' : 'Cycle Resets: '}{new Date((status.usage?.resetsAt ?? status.resetsAt)!).toLocaleString(locale)}</p>}
          {status.usageResetAt && (
            <p className="text-[10px] text-[var(--accent)] flex items-center gap-1">
              <span>●</span>
              <span>{zh ? `额度已重置：${new Date(status.usageResetAt).toLocaleString(locale)}` : `Usage reset at: ${new Date(status.usageResetAt).toLocaleString(locale)}`}</span>
            </p>
          )}
        </div>
      )}
    </section>
  );
}
