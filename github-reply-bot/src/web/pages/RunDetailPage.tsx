import { useCallback, useEffect, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { AuditLogDto, GlobalSettingsDto, JobDto, RunDto } from '../../shared/types';
import { ApiError, apiFetch, formatDateTime } from '../api';
import { ConfirmDialog, ErrorBanner, PageHeader, Skeleton, StatusBadge, SuccessBanner } from '../components/ui';

interface RunDetailResponse {
  run: RunDto;
  jobs: JobDto[];
  audit: AuditLogDto[];
}

interface ContextSummaryView {
  title?: string;
  author?: string;
  labels?: string[];
  bodyExcerpt?: string;
  bodyChars?: number;
  comments?: Array<{ author: string; excerpt: string }>;
  commentsRead?: number;
  files?: Array<{ filename: string; status: string; additions: number; deletions: number }>;
  totalChangedFiles?: number | null;
  htmlUrl?: string;
}

type DialogKind = 'approve' | 'reject' | 'retry' | null;

export function RunDetailPage() {
  const { id } = useParams<{ id: string }>();
  const [detail, setDetail] = useState<RunDetailResponse | null>(null);
  const [dryRun, setDryRun] = useState(false);
  const [reply, setReply] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [dialog, setDialog] = useState<DialogKind>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const data = await apiFetch<RunDetailResponse>(`/api/runs/${id}`);
      setDetail(data);
      setReply(data.run.editedReply ?? data.run.generatedReply ?? '');
      try {
        const settings = await apiFetch<{ settings: GlobalSettingsDto }>('/api/settings');
        setDryRun(settings.settings.dryRun);
      } catch {
        setDryRun(false);
      }
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载运行详情失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  async function act(kind: Exclude<DialogKind, null>) {
    if (!id) return;
    setBusy(true);
    setError(null);
    try {
      if (kind === 'approve') {
        await apiFetch(`/api/runs/${id}/approve`, {
          method: 'POST',
          body: JSON.stringify({ reply: reply.trim() }),
        });
        setNotice('已批准，正在发布…');
      } else if (kind === 'reject') {
        await apiFetch(`/api/runs/${id}/reject`, { method: 'POST', body: JSON.stringify({}) });
        setNotice('已拒绝，不会发布');
      } else {
        await apiFetch(`/api/runs/${id}/retry`, { method: 'POST', body: JSON.stringify({}) });
        setNotice('已重新排队');
      }
      setDialog(null);
      await load();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '操作失败');
      setDialog(null);
    } finally {
      setBusy(false);
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="运行详情" />
        <Skeleton rows={5} />
      </div>
    );
  }

  if (!detail) {
    return (
      <div>
        <PageHeader title="运行详情" />
        <ErrorBanner message={error ?? '运行记录不存在'} onRetry={() => void load()} />
        <Link className="btn" to="/runs">
          返回列表
        </Link>
      </div>
    );
  }

  const { run, jobs, audit } = detail;
  const context = (run.contextSummary ?? {}) as ContextSummaryView;
  const approvable = ['drafted', 'rejected', 'failed'].includes(run.status);
  const rejectable = ['drafted', 'approved', 'failed', 'blocked_sensitive'].includes(run.status);
  const retryable = ['failed', 'retrying'].includes(run.status);

  return (
    <div>
      <PageHeader
        title={`运行 #${run.id}`}
        subtitle={
          <>
            {run.repository ?? '未知仓库'} · {run.eventType}.{run.action} · 触发者 {run.actorLogin}
            {run.actorIsBot ? '（bot）' : ''}
          </>
        }
        actions={
          <Link className="btn btn-ghost" to="/runs">
            返回列表
          </Link>
        }
      />
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {notice ? <SuccessBanner message={notice} /> : null}

      <section className="card">
        <h2>状态</h2>
        <dl className="kv">
          <dt>状态</dt>
          <dd>
            <StatusBadge status={run.status} />
          </dd>
          <dt>原因</dt>
          <dd>{run.reason ?? '—'}</dd>
          <dt>创建 / 更新</dt>
          <dd>
            {formatDateTime(run.createdAt)} / {formatDateTime(run.updatedAt)}
          </dd>
          <dt>尝试次数</dt>
          <dd>{run.attempts}</dd>
          <dt>已发布评论</dt>
          <dd className="mono">{run.postedCommentId ?? '—'}</dd>
          {run.fallbackUsed ? (
            <>
              <dt>生成器</dt>
              <dd>LLM 调用失败，已回退模板</dd>
            </>
          ) : null}
          {run.errorCode ? (
            <>
              <dt>错误代码</dt>
              <dd className="mono">{run.errorCode}</dd>
              <dt>错误信息</dt>
              <dd className="error-text">{run.errorMessage}</dd>
            </>
          ) : null}
        </dl>
        {dryRun ? (
          <div className="banner banner-warn" role="status">
            当前为 dry-run 模式：批准不会调用 GitHub 发布 API。请先在全局设置里关闭 dry-run。
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>上下文摘要</h2>
        {context.title ? (
          <dl className="kv">
            <dt>标题</dt>
            <dd>{context.title}</dd>
            <dt>作者 / 标签</dt>
            <dd>
              {context.author ?? '—'} · {(context.labels ?? []).join(', ') || '无标签'}
            </dd>
            <dt>正文摘要</dt>
            <dd className="pre-wrap">{context.bodyExcerpt ?? '（未读取到正文）'}</dd>
            <dt>最近评论</dt>
            <dd>
              已读取 {context.commentsRead ?? 0} 条
              {context.comments && context.comments.length > 0 ? (
                <ul className="compact-list">
                  {context.comments.map((comment, index) => (
                    <li key={index}>
                      <strong>{comment.author}</strong>：{comment.excerpt}
                    </li>
                  ))}
                </ul>
              ) : null}
            </dd>
            <dt>变更文件</dt>
            <dd>
              {context.files && context.files.length > 0 ? (
                <ul className="compact-list mono">
                  {context.files.map((file) => (
                    <li key={file.filename}>
                      {file.filename} ({file.status}, +{file.additions}/-{file.deletions})
                    </li>
                  ))}
                </ul>
              ) : (
                '无（仅 PR 会读取，且受 max_changed_files 限制）'
              )}
              {typeof context.totalChangedFiles === 'number' ? (
                <span className="muted small"> 共 {context.totalChangedFiles} 个文件</span>
              ) : null}
            </dd>
          </dl>
        ) : (
          <p className="muted">尚未构建上下文（可能在开关关闭时跳过）。</p>
        )}
      </section>

      {run.eventPayload ? (
        <section className="card">
          <details>
            <summary>已保存的 webhook payload（排障用）</summary>
            <pre className="code-block">{JSON.stringify(run.eventPayload, null, 2)}</pre>
          </details>
        </section>
      ) : null}

      <section className="card">
        <h2>生成回复</h2>
        {run.status === 'blocked_sensitive' ? (
          <p className="error-text">内容命中安全过滤：疑似密钥字符串，已阻止发布且未保存原文。</p>
        ) : null}
        <label className="field">
          <span>可编辑内容（批准时以此为准）</span>
          <textarea
            rows={10}
            value={reply}
            disabled={!approvable || busy}
            onChange={(event) => setReply(event.target.value)}
          />
        </label>
        <div className="form-actions">
          <button
            type="button"
            className="btn btn-primary"
            disabled={!approvable || busy || dryRun || !reply.trim()}
            title={dryRun ? 'dry-run 模式下不能批准发布' : undefined}
            onClick={() => setDialog('approve')}
          >
            批准并发布
          </button>
          <button
            type="button"
            className="btn"
            disabled={!rejectable || busy}
            onClick={() => setDialog('reject')}
          >
            拒绝
          </button>
          <button
            type="button"
            className="btn"
            disabled={!retryable || busy}
            onClick={() => setDialog('retry')}
          >
            重试
          </button>
        </div>
        {dryRun && approvable ? (
          <p className="hint">dry-run 期间按钮被禁用：关闭 dry-run 后刷新本页即可批准。</p>
        ) : null}
      </section>

      <section className="card">
        <h2>任务与审计</h2>
        {jobs.length > 0 ? (
          <ul className="compact-list">
            {jobs.map((job) => (
              <li key={job.id}>
                #{job.id} · {job.type} · {job.status} · 尝试 {job.attempts} 次
                {job.lastError ? ` · ${job.lastError}` : ''}
              </li>
            ))}
          </ul>
        ) : (
          <p className="muted">没有队列任务。</p>
        )}
        {audit.length > 0 ? (
          <ul className="compact-list">
            {audit.map((entry) => (
              <li key={entry.id}>
                <span className="mono">{entry.action}</span> · {formatDateTime(entry.createdAt)} · {entry.actor}
                {entry.detail ? <span className="muted small"> {JSON.stringify(entry.detail).slice(0, 200)}</span> : null}
              </li>
            ))}
          </ul>
        ) : null}
      </section>

      <ConfirmDialog
        open={dialog === 'approve'}
        title="确认发布这条回复？"
        description={
          <>
            将以编辑后的内容在 #{run.prNumber ?? run.issueNumber} 上发表评论。发布后无法撤回，只能手动删除。
          </>
        }
        confirmLabel="确认发布"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void act('approve')}
      />
      <ConfirmDialog
        open={dialog === 'reject'}
        title="拒绝这条草稿？"
        description="拒绝后不会发布任何内容，可稍后重新批准。"
        confirmLabel="确认拒绝"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void act('reject')}
      />
      <ConfirmDialog
        open={dialog === 'retry'}
        title="重新处理这次运行？"
        description="将重新读取上下文并生成回复，若仍失败会记录新的错误。"
        confirmLabel="重试"
        busy={busy}
        onCancel={() => setDialog(null)}
        onConfirm={() => void act('retry')}
      />
    </div>
  );
}
