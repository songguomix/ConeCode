import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { OverviewDto } from '../../shared/types';
import { ApiError, apiFetch, formatDateTime } from '../api';
import { EmptyState, ErrorBanner, PageHeader, Skeleton, SuccessBanner, Switch } from '../components/ui';

export function OverviewPage() {
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ overview: OverviewDto }>('/api/overview');
      setOverview(data.overview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载概览失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(key: 'automationEnabled' | 'dryRun', next: boolean) {
    setSaving(key);
    setError(null);
    setNotice(null);
    try {
      await apiFetch('/api/settings', { method: 'PUT', body: JSON.stringify({ [key]: next }) });
      setNotice(next ? '已开启' : '已关闭');
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="概览"
        subtitle="默认关闭一切自动化。开启前请确认仓库与事件开关，并保持草稿审核。"
      />
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {notice ? <SuccessBanner message={notice} /> : null}
      {loading && !overview ? <Skeleton rows={4} /> : null}

      {overview ? (
        <>
          {overview.status.missingConfig.length > 0 ? (
            <div className="banner banner-warn" role="status">
              <strong>配置不完整：</strong> 缺少 {overview.status.missingConfig.join('、')}。
              未配置 GitHub App 凭据时无法读取或发布内容；未配置 ADMIN_TOKEN 时管理 API 不可用。
            </div>
          ) : null}
          {overview.status.dryRun ? (
            <div className="banner banner-warn" role="status">
              dry-run 已开启：即使批准也不会调用 GitHub 发布 API。确认无误后可在下方关闭。
            </div>
          ) : null}

          <section className="card">
            <h2>功能总开关</h2>
            <div className="switch-row">
              <div>
                <div className="switch-title">全局自动化</div>
                <p className="muted small">关闭时 webhook 只记录 skipped，不读取内容、不生成、不发布。</p>
              </div>
              <Switch
                label="全局自动化"
                checked={overview.status.automationEnabled}
                disabled={saving !== null}
                onChange={(next) => void toggle('automationEnabled', next)}
              />
            </div>
            <div className="switch-row">
              <div>
                <div className="switch-title">dry-run</div>
                <p className="muted small">生成并记录草稿，但禁止任何发布调用。</p>
              </div>
              <Switch
                label="dry-run"
                checked={overview.status.dryRun}
                disabled={saving !== null}
                onChange={(next) => void toggle('dryRun', next)}
              />
            </div>
          </section>

          <section className="stats-grid" aria-label="今日统计">
            <div className="stat">
              <span className="stat-label">今日运行</span>
              <strong>{overview.counts.runsToday}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">今日已发布</span>
              <strong>{overview.counts.postedToday}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">今日失败</span>
              <strong>{overview.counts.failedToday}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">待审草稿</span>
              <strong>{overview.counts.draftsPending}</strong>
            </div>
            <div className="stat">
              <span className="stat-label">已安装仓库</span>
              <strong>{overview.counts.repositories}</strong>
            </div>
          </section>

          {overview.counts.repositories === 0 ? (
            <EmptyState
              title="尚未安装到任何仓库"
              description="在 GitHub 上把 App 安装到仓库后，这里会出现仓库列表。然后在「仓库」页启用仓库并打开事件开关。"
              action={
                <Link className="btn btn-primary" to="/repos">
                  查看仓库
                </Link>
              }
            />
          ) : null}

          <section className="card">
            <h2>Webhook 健康</h2>
            <dl className="kv">
              <dt>最近接收</dt>
              <dd>{formatDateTime(overview.webhook.lastReceivedAt)}</dd>
              <dt>最近事件</dt>
              <dd>{overview.webhook.lastEvent ?? '—'}</dd>
              <dt>最近 delivery</dt>
              <dd className="mono">{overview.webhook.lastDeliveryId ?? '—'}</dd>
              <dt>最近被拒</dt>
              <dd>{formatDateTime(overview.webhook.lastRejectedAt)}</dd>
            </dl>
            <p className="hint">
              Webhook URL：<span className="mono">https://你的域名/webhook</span>；签名不规范时请求返回 401 并记录拒绝。
            </p>
          </section>
        </>
      ) : null}
    </div>
  );
}
