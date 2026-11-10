import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RepositoryDto } from '../../shared/types';
import { ApiError, apiFetch } from '../api';
import { EmptyState, ErrorBanner, PageHeader, Skeleton, Switch } from '../components/ui';

export function ReposPage() {
  const [repos, setRepos] = useState<RepositoryDto[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [savingId, setSavingId] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<{ items: RepositoryDto[] }>('/api/repos');
      setRepos(data.items);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载仓库列表失败');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  async function toggle(repo: RepositoryDto, next: boolean) {
    setSavingId(repo.id);
    setError(null);
    try {
      const data = await apiFetch<{ repo: RepositoryDto }>(`/api/repos/${repo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ repoEnabled: next }),
      });
      setRepos((current) => current.map((item) => (item.id === repo.id ? data.repo : item)));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSavingId(null);
    }
  }

  return (
    <div>
      <PageHeader
        title="仓库"
        subtitle="安装到仓库后默认关闭。逐个仓库启用并配置事件与发布策略。"
        actions={
          <button type="button" className="btn btn-ghost" onClick={() => void load()}>
            刷新
          </button>
        }
      />
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {loading ? <Skeleton rows={3} /> : null}
      {!loading && repos.length === 0 ? (
        <EmptyState
          title="尚未安装到任何仓库"
          description="在 GitHub App 设置中安装到目标仓库，或同步 installation 事件后刷新本页。"
        />
      ) : null}
      {!loading && repos.length > 0 ? (
        <div className="list">
          {repos.map((repo) => (
            <div className="card list-row" key={repo.id}>
              <div>
                <div className="list-title">
                  {repo.owner}/{repo.name}
                </div>
                <p className="muted small">
                  {repo.repoEnabled ? '已启用自动处理' : '未启用（webhook 只会记录 skipped）'} · 每小时上限{' '}
                  {repo.settings.rateLimitPerHour} 次
                </p>
              </div>
              <div className="row-actions">
                <Switch
                  label={`启用 ${repo.owner}/${repo.name}`}
                  checked={repo.repoEnabled}
                  disabled={savingId === repo.id}
                  onChange={(next) => void toggle(repo, next)}
                />
                <Link className="btn btn-small" to={`/repos/${repo.id}`}>
                  设置
                </Link>
              </div>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}
