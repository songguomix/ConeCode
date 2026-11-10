import { useCallback, useEffect, useState, type FormEvent } from 'react';
import { Link, useParams } from 'react-router-dom';
import type { ReplyTemplateDto, RepositoryDto, RepoSettingsDto } from '../../shared/types';
import { ApiError, apiFetch } from '../api';
import { ConfirmDialog, ErrorBanner, PageHeader, Skeleton, SuccessBanner, Switch } from '../components/ui';

export function RepoSettingsPage() {
  const { id } = useParams<{ id: string }>();
  const [repo, setRepo] = useState<RepositoryDto | null>(null);
  const [draft, setDraft] = useState<RepoSettingsDto | null>(null);
  const [templates, setTemplates] = useState<ReplyTemplateDto[]>([]);
  const [labelsText, setLabelsText] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmEnable, setConfirmEnable] = useState(false);

  const load = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const [repoData, templateData] = await Promise.all([
        apiFetch<{ repo: RepositoryDto }>(`/api/repos/${id}`),
        apiFetch<{ items: ReplyTemplateDto[] }>('/api/templates'),
      ]);
      setRepo(repoData.repo);
      setDraft(repoData.repo.settings);
      setTemplates(templateData.items);
      setLabelsText(repoData.repo.settings.triggerLabels.join(', '));
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '加载仓库设置失败');
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    void load();
  }, [load]);

  function patch(next: Partial<RepoSettingsDto>) {
    setDraft((current) => (current ? { ...current, ...next } : current));
  }

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!draft || !id) return;
    setSaving(true);
    setError(null);
    setNotice(null);
    const { updatedAt: _updatedAt, ...payload } = draft;
    payload.triggerLabels = labelsText
      .split(',')
      .map((label) => label.trim())
      .filter(Boolean);
    try {
      const data = await apiFetch<{ settings: RepoSettingsDto }>(`/api/repos/${id}/settings`, {
        method: 'PUT',
        body: JSON.stringify(payload),
      });
      setDraft(data.settings);
      setLabelsText(data.settings.triggerLabels.join(', '));
      setNotice('仓库设置已保存');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    } finally {
      setSaving(false);
    }
  }

  async function setEnabled(next: boolean) {
    if (!repo) return;
    setError(null);
    try {
      const data = await apiFetch<{ repo: RepositoryDto }>(`/api/repos/${repo.id}`, {
        method: 'PATCH',
        body: JSON.stringify({ repoEnabled: next }),
      });
      setRepo(data.repo);
      setNotice(next ? '仓库已启用' : '仓库已停用');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : '保存失败');
    }
  }

  if (loading) {
    return (
      <div>
        <PageHeader title="仓库设置" />
        <Skeleton rows={5} />
      </div>
    );
  }

  if (!repo || !draft) {
    return (
      <div>
        <PageHeader title="仓库设置" />
        <ErrorBanner message={error ?? '仓库不存在'} onRetry={() => void load()} />
        <Link className="btn" to="/repos">
          返回仓库列表
        </Link>
      </div>
    );
  }

  return (
    <form onSubmit={save}>
      <PageHeader
        title={`${repo.owner}/${repo.name}`}
        subtitle="危险操作需要确认；所有开关默认关闭，先保持人工审核。"
        actions={
          <Link className="btn btn-ghost" to="/repos">
            返回
          </Link>
        }
      />
      {error ? <ErrorBanner message={error} onRetry={() => void load()} /> : null}
      {notice ? <SuccessBanner message={notice} /> : null}

      <section className="card">
        <div className="switch-row">
          <div>
            <div className="switch-title">启用此仓库</div>
            <p className="muted small">关闭时所有事件只记录 skipped，不读取额外内容、不生成回复。</p>
          </div>
          <Switch
            label="启用此仓库"
            checked={repo.repoEnabled}
            onChange={(next) => (next ? setConfirmEnable(true) : void setEnabled(false))}
          />
        </div>
        <ConfirmDialog
          open={confirmEnable}
          title="启用自动处理？"
          description="启用后，已打开的事件会进入处理队列；默认仍需人工批准才会发布。"
          confirmLabel="启用"
          onCancel={() => setConfirmEnable(false)}
          onConfirm={() => {
            setConfirmEnable(false);
            void setEnabled(true);
          }}
        />
      </section>

      <section className="card">
        <h2>事件触发</h2>
        <div className="switch-row">
          <Labeled label="新 Issue（opened）" hint="读取标题、正文与标签并生成确认回复" />
          <Switch label="新 Issue" checked={draft.onIssueOpened} onChange={(next) => patch({ onIssueOpened: next })} />
        </div>
        <div className="switch-row">
          <Labeled label="Issue 打标签（labeled）" hint="需要下方触发标签匹配" />
          <Switch label="Issue 打标签" checked={draft.onIssueLabeled} onChange={(next) => patch({ onIssueLabeled: next })} />
        </div>
        <div className="switch-row">
          <Labeled label="新 PR（opened）" hint="读取变更文件列表（限量）并生成预审清单" />
          <Switch label="新 PR" checked={draft.onPrOpened} onChange={(next) => patch({ onPrOpened: next })} />
        </div>
        <div className="switch-row">
          <Labeled label="PR 打标签（labeled）" hint="需要下方触发标签匹配" />
          <Switch label="PR 打标签" checked={draft.onPrLabeled} onChange={(next) => patch({ onPrLabeled: next })} />
        </div>
        <div className="switch-row">
          <Labeled label="@ 提及" hint="仅识别 @GITHUB_APP_SLUG；需要同时打开提及触发" />
          <Switch label="@ 提及" checked={draft.onMention} onChange={(next) => patch({ onMention: next })} />
        </div>
        <label className="field">
          <span>触发标签（英文逗号分隔，留空表示不按标签过滤）</span>
          <input
            value={labelsText}
            onChange={(event) => setLabelsText(event.target.value)}
            placeholder="bot-reply, needs-triage"
          />
          <span className="hint">非空时，只有带这些标签的 Issue/PR 才会触发。</span>
        </label>
        <div className="switch-row">
          <Labeled label="允许 @ 提及触发" hint="关闭时即使收到 @ 提及也不会处理" />
          <Switch
            label="允许 @ 提及触发"
            checked={draft.mentionTriggerEnabled}
            onChange={(next) => patch({ mentionTriggerEnabled: next })}
          />
        </div>
        <label className="field">
          <span>允许触发自动发布的角色</span>
          <select
            value={draft.allowedTriggerRoles}
            onChange={(event) => patch({ allowedTriggerRoles: event.target.value as RepoSettingsDto['allowedTriggerRoles'] })}
          >
            <option value="maintainer">maintainer / owner（默认）</option>
            <option value="anyone">anyone（只能生成草稿）</option>
          </select>
          <span className="hint">选择 anyone 时，任何人都能触发，但只会生成草稿，绝不自动发布。</span>
        </label>
      </section>

      <section className="card">
        <h2>发布策略</h2>
        <div className="switch-row">
          <Labeled label="自动发布" hint="开启后必须关闭人工审核；仅对拥有 maintain/admin 权限的触发者生效" />
          <Switch
            label="自动发布"
            checked={draft.autoPostEnabled}
            onChange={(next) =>
              patch(next ? { autoPostEnabled: true, requireApproval: false } : { autoPostEnabled: false })
            }
          />
        </div>
        <div className="switch-row">
          <Labeled label="需要人工审核" hint="开启后生成的回复进入草稿，须在运行详情批准" />
          <Switch
            label="需要人工审核"
            checked={draft.requireApproval}
            onChange={(next) =>
              patch(next ? { requireApproval: true, autoPostEnabled: false } : { requireApproval: false })
            }
          />
        </div>
        <p className="hint">「自动发布」与「需要人工审核」互斥；保存时服务端会再次校验。</p>
        <div className="field-row">
          <label className="field">
            <span>每小时上限（1–100）</span>
            <input
              type="number"
              min={1}
              max={100}
              value={draft.rateLimitPerHour}
              onChange={(event) => patch({ rateLimitPerHour: Number(event.target.value) || 1 })}
            />
          </label>
          <label className="field">
            <span>最大回复长度（200–8000）</span>
            <input
              type="number"
              min={200}
              max={8000}
              value={draft.maxReplyChars}
              onChange={(event) => patch({ maxReplyChars: Number(event.target.value) || 200 })}
            />
          </label>
        </div>
      </section>

      <section className="card">
        <h2>上下文与免打扰</h2>
        <div className="field-row">
          <label className="field">
            <span>读取最近评论数（0–50）</span>
            <input
              type="number"
              min={0}
              max={50}
              value={draft.maxContextComments}
              onChange={(event) => patch({ maxContextComments: Number(event.target.value) || 0 })}
            />
          </label>
          <label className="field">
            <span>读取 PR 文件数（0–100）</span>
            <input
              type="number"
              min={0}
              max={100}
              value={draft.maxChangedFiles}
              onChange={(event) => patch({ maxChangedFiles: Number(event.target.value) || 0 })}
            />
          </label>
        </div>
        <div className="switch-row">
          <Labeled label="免打扰时段" hint="该时段内到达的触发直接跳过，不生成草稿" />
          <Switch
            label="免打扰时段"
            checked={draft.quietHoursEnabled}
            onChange={(next) => patch({ quietHoursEnabled: next })}
          />
        </div>
        {draft.quietHoursEnabled ? (
          <div className="field-row">
            <label className="field">
              <span>开始（HH:mm）</span>
              <input
                value={draft.quietHoursStart}
                onChange={(event) => patch({ quietHoursStart: event.target.value })}
                placeholder="22:00"
              />
            </label>
            <label className="field">
              <span>结束（HH:mm）</span>
              <input
                value={draft.quietHoursEnd}
                onChange={(event) => patch({ quietHoursEnd: event.target.value })}
                placeholder="08:00"
              />
            </label>
            <label className="field">
              <span>时区（IANA）</span>
              <input
                value={draft.quietHoursTimezone}
                onChange={(event) => patch({ quietHoursTimezone: event.target.value })}
                placeholder="Asia/Shanghai"
              />
            </label>
          </div>
        ) : null}
      </section>

      <section className="card">
        <h2>模板与其他</h2>
        <label className="field">
          <span>回复模板</span>
          <select
            value={draft.templateId ?? ''}
            onChange={(event) =>
              patch({ templateId: event.target.value === '' ? null : Number(event.target.value) })
            }
          >
            <option value="">默认（按语言与类型自动选择）</option>
            {templates.map((template) => (
              <option value={template.id} key={template.id}>
                {template.name}
              </option>
            ))}
          </select>
        </label>
        <div className="switch-row">
          <Labeled label="保存 webhook 原始 payload" hint="默认关闭；开启会把完整事件内容写入数据库，建议仅在排障时短期开启" />
          <Switch
            label="保存 webhook 原始 payload"
            checked={draft.storeEventPayload}
            onChange={(next) => patch({ storeEventPayload: next })}
          />
        </div>
      </section>

      <div className="form-actions">
        <button type="submit" className="btn btn-primary" disabled={saving}>
          {saving ? '保存中…' : '保存设置'}
        </button>
      </div>
    </form>
  );
}

function Labeled({ label, hint }: { label: string; hint: string }) {
  return (
    <div>
      <div className="switch-title">{label}</div>
      <p className="muted small">{hint}</p>
    </div>
  );
}
