import { useCallback, useEffect, useState, type FormEvent } from 'react';
import type { GlobalSettingsDto, OverviewDto } from '../../shared/types';
import { ApiError, apiFetch, formatDateTime } from '../api';
import { ErrorBanner, PageHeader, Skeleton, SuccessBanner } from '../components/ui';

export function SettingsPage() {
  const [settings, setSettings] = useState<GlobalSettingsDto | null>(null);
  const [overview, setOverview] = useState<OverviewDto | null>(null);
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [settingsData, overviewData] = await Promise.all([
        apiFetch<{ settings: GlobalSettingsDto }>('/api/settings'),
        apiFetch<{ overview: OverviewDto }>('/api/overview'),
      ]);
      setSettings(settingsData.settings);
      setOverview(overviewData.overview);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载设置失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!settings) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    try {
      const data = await apiFetch<{ settings: GlobalSettingsDto }>('/api/settings', {
        method: 'PUT',
        body: JSON.stringify({
          automationEnabled: settings.automationEnabled,
          dryRun: settings.dryRun,
          generatorProvider: settings.generatorProvider,
          retentionDays: settings.retentionDays,
          defaultReplyLanguage: settings.defaultReplyLanguage,
        }),
      });
      setSettings(data.settings);
      setNotice('全局设置已保存');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="全局设置" />
        <Skeleton rows={4} />
      </div>
    );
  }

  if (!settings) {
    return (
      <div>
        <PageHeader title="全局设置" />
        <ErrorBanner message={error ?? '加载失败'} onRetry={() => void load()} />
      </div>
    );
  }

  return (
    <form onSubmit={save}>
      <PageHeader title="全局设置" subtitle="这些开关决定服务是否真的读取内容与发布评论。" />
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {notice ? <SuccessBanner message={notice} /> : null}
      {overview && overview.status.missingConfig.length > 0 ? (
        <div className="banner banner-warn" role="status">
          <strong>缺少配置：</strong> {overview.status.missingConfig.join('、')}。详见 README 的环境变量表。
        </div>
      ) : null}

      <section className="card">
        <h2>运行模式</h2>
        <label className="field">
          <span>全局自动化</span>
          <select
            value={settings.automationEnabled ? 'on' : 'off'}
            onChange={(event) => setSettings({ ...settings, automationEnabled: event.target.value === 'on' })}
          >
            <option value="off">关闭（仅记录 skipped）</option>
            <option value="on">开启</option>
          </select>
        </label>
        <label className="field">
          <span>dry-run</span>
          <select
            value={settings.dryRun ? 'on' : 'off'}
            onChange={(event) => setSettings({ ...settings, dryRun: event.target.value === 'on' })}
          >
            <option value="on">开启（禁止发布，只生成草稿）</option>
            <option value="off">关闭（允许批准后发布）</option>
          </select>
        </label>
      </section>

      <section className="card">
        <h2>生成器</h2>
        <label className="field">
          <span>生成器类型</span>
          <select
            value={settings.generatorProvider}
            onChange={(event) =>
              setSettings({ ...settings, generatorProvider: event.target.value as GlobalSettingsDto['generatorProvider'] })
            }
          >
            <option value="template">template（内置模板，离线）</option>
            <option value="http_llm">http_llm（兼容 OpenAI 的 HTTP 端点）</option>
          </select>
        </label>
        {settings.generatorProvider === 'http_llm' ? (
          <div className="banner banner-warn" role="status">
            启用 http_llm 会把 Issue/PR 上下文发送到你配置的第三方端点。请确认已在服务端配置
            `LLM_ENDPOINT`、`LLM_MODEL`（可选 `LLM_API_KEY`），并自行评估数据合规。
          </div>
        ) : null}
        <label className="field">
          <span>回复语言</span>
          <select
            value={settings.defaultReplyLanguage}
            onChange={(event) =>
              setSettings({
                ...settings,
                defaultReplyLanguage: event.target.value as GlobalSettingsDto['defaultReplyLanguage'],
              })
            }
          >
            <option value="auto">自动（中英文启发式）</option>
            <option value="zh-CN">中文</option>
            <option value="en">English</option>
          </select>
        </label>
      </section>

      <section className="card">
        <h2>数据保留</h2>
        <label className="field">
          <span>保留天数（1–365）</span>
          <input
            type="number"
            min={1}
            max={365}
            value={settings.retentionDays}
            onChange={(event) =>
              setSettings({ ...settings, retentionDays: Number(event.target.value) || 30 })
            }
          />
          <span className="hint">到期后会清理已结束的运行、草稿与审计日志。</span>
        </label>
      </section>

      {overview ? (
        <section className="card">
          <h2>Webhook 健康</h2>
          <dl className="kv">
            <dt>最近接收</dt>
            <dd>{formatDateTime(overview.webhook.lastReceivedAt)}</dd>
            <dt>最近事件</dt>
            <dd>{overview.webhook.lastEvent ?? '—'}</dd>
            <dt>最近 delivery</dt>
            <dd className="mono">{overview.webhook.lastDeliveryId ?? '—'}</dd>
            <dt>最近被拒签名</dt>
            <dd>{formatDateTime(overview.webhook.lastRejectedAt)}</dd>
            <dt>GitHub App 凭据</dt>
            <dd>{overview.status.githubConfigured ? '已配置' : '未配置'}</dd>
            <dt>Webhook 密钥</dt>
            <dd>{overview.status.webhookConfigured ? '已配置' : '未配置'}</dd>
          </dl>
        </section>
      ) : null}

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? '保存中…' : '保存全局设置'}
        </button>
      </div>
    </form>
  );
}
