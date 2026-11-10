import { useCallback, useEffect, useState } from 'react';
import { Link } from 'react-router-dom';
import type { RunListDto, RunStatus } from '../../shared/types';
import { RUN_STATUSES } from '../../shared/types';
import { ApiError, apiFetch, formatDateTime } from '../api';
import { EmptyState, ErrorBanner, PageHeader, Skeleton, StatusBadge } from '../components/ui';

const PAGE_SIZE = 20;

export function RunsPage() {
  const [data, setData] = useState<RunListDto | null>(null);
  const [status, setStatus] = useState<RunStatus | ''>('');
  const [page, setPage] = useState(1);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams({ page: String(page), pageSize: String(PAGE_SIZE) });
      if (status) params.set('status', status);
      const result = await apiFetch<RunListDto>(`/api/runs?${params.toString()}`);
      setData(result);
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载运行记录失败');
    } finally {
      setLoading(false);
    }
  }, [page, status]);

  useEffect(() => {
    void load();
  }, [load]);

  const totalPages = data ? Math.max(1, Math.ceil(data.total / data.pageSize)) : 1;

  return (
    <div>
      <PageHeader
        title="运行记录"
        subtitle="每次 webhook 都会留下记录：跳过的原因、生成的草稿与发布结果都可见。"
        actions={
          <label className="field inline">
            <span>状态筛选</span>
            <select
              value={status}
              onChange={(event) => {
                setStatus(event.target.value as RunStatus | '');
                setPage(1);
              }}
            >
              <option value="">全部</option>
              {RUN_STATUSES.map((value) => (
                <option value={value} key={value}>
                  {value}
                </option>
              ))}
            </select>
          </label>
        }
      />
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {loading ? <Skeleton rows={4} /> : null}
      {!loading && data && data.items.length === 0 ? (
        <EmptyState
          title={status ? '没有符合筛选条件的运行' : '还没有运行记录'}
          description="在 GitHub 上创建 Issue 或 PR，或检查 webhook 是否已正确配置到 /webhook。"
        />
      ) : null}
      {!loading && data && data.items.length > 0 ? (
        <div className="table-wrap">
          <table className="table">
            <thead>
              <tr>
                <th>#</th>
                <th>仓库</th>
                <th>事件</th>
                <th>触发者</th>
                <th>状态</th>
                <th>原因</th>
                <th>创建时间</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {data.items.map((run) => (
                <tr key={run.id}>
                  <td className="mono">{run.id}</td>
                  <td>{run.repository ?? '—'}</td>
                  <td>
                    {run.eventType}.{run.action}
                    <span className="muted small"> ({run.triggerKind})</span>
                  </td>
                  <td>{run.actorLogin}</td>
                  <td>
                    <StatusBadge status={run.status} />
                  </td>
                  <td className="muted small">{run.reason ?? '—'}</td>
                  <td className="muted small">{formatDateTime(run.createdAt)}</td>
                  <td>
                    <Link className="btn btn-small" to={`/runs/${run.id}`}>
                      详情
                    </Link>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
      {data && data.total > PAGE_SIZE ? (
        <div className="pagination">
          <button
            type="button"
            className="btn btn-small"
            disabled={page <= 1}
            onClick={() => setPage((current) => Math.max(1, current - 1))}
          >
            上一页
          </button>
          <span className="muted small">
            第 {page} / {totalPages} 页 · 共 {data.total} 条
          </span>
          <button
            type="button"
            className="btn btn-small"
            disabled={page >= totalPages}
            onClick={() => setPage((current) => current + 1)}
          >
            下一页
          </button>
        </div>
      ) : null}
    </div>
  );
}
