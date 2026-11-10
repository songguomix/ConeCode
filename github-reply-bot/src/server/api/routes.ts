import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';
import type { Store } from '../db/store';
import type { AppConfig } from '../config';
import { startOfLocalDay } from '../util/time';
import {
  APPROVABLE_STATUSES,
  REJECTABLE_STATUSES,
  RETRYABLE_STATUSES,
  approveRunSchema,
  globalSettingsUpdateSchema,
  isValidTimeZone,
  listRunsQuerySchema,
  loginSchema,
  rejectRunSchema,
  repoEnabledUpdateSchema,
  repoSettingsUpdateSchema,
  templateCreateSchema,
  templateUpdateSchema,
  validateMutualExclusion,
} from '../../shared/validation';
import { sanitizeReply } from '../safety/filter';
import { safeEqual } from '../util/crypto';
import { checkAdminToken } from './auth';
import type { OverviewDto } from '../../shared/types';

export interface ApiDeps {
  store: Store;
  config: AppConfig;
}

interface LoginAttempt {
  count: number;
  resetAt: number;
}

const LOGIN_WINDOW_MS = 60_000;
const LOGIN_MAX_ATTEMPTS = 10;

function sendValidationError(reply: FastifyReply, error: { issues: Array<{ path: (string | number)[]; message: string }> }) {
  return reply.code(400).send({
    error: 'validation_error',
    message: error.issues.map((issue) => `${issue.path.join('.') || 'body'}: ${issue.message}`).join('; '),
    details: error.issues,
  });
}

function idParam(request: FastifyRequest): number | null {
  const value = Number((request.params as { id?: string }).id);
  return Number.isInteger(value) && value > 0 ? value : null;
}

export function registerApi(app: FastifyInstance, deps: ApiDeps): void {
  const { store, config } = deps;
  const loginAttempts = new Map<string, LoginAttempt>();

  app.post('/api/auth/login', async (request, reply) => {
    if (!config.adminToken) {
      return reply.code(503).send({
        error: 'admin_token_not_configured',
        message: '服务器未配置 ADMIN_TOKEN，无法登录。请设置后重启服务。',
      });
    }
    const ip = request.ip || 'unknown';
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.resetAt > now && attempt.count >= LOGIN_MAX_ATTEMPTS) {
      return reply.code(429).send({ error: 'too_many_attempts', message: '登录尝试过于频繁，请稍后再试' });
    }
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) return sendValidationError(reply, parsed.error);
    if (!safeEqual(parsed.data.token, config.adminToken)) {
      const current = attempt && attempt.resetAt > now ? attempt : { count: 0, resetAt: now + LOGIN_WINDOW_MS };
      current.count += 1;
      loginAttempts.set(ip, current);
      return reply.code(401).send({ error: 'invalid_token', message: '令牌无效' });
    }
    loginAttempts.delete(ip);
    return reply.code(200).send({ ok: true });
  });

  app.register(
    async (scope) => {
      scope.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
        const result = checkAdminToken(request, config);
        if (!result.ok) {
          await reply.code(result.status).send({ error: result.error, message: result.message });
        }
      });

      scope.get('/overview', async () => {
        const global = store.getGlobalSettings();
        const today = startOfLocalDay(new Date()).toISOString();
        const payload: OverviewDto = {
          status: {
            automationEnabled: global.automationEnabled,
            dryRun: global.dryRun,
            generatorProvider: global.generatorProvider,
            githubConfigured: Boolean(config.github.appId && config.github.privateKey),
            webhookConfigured: Boolean(config.github.webhookSecret),
            adminConfigured: Boolean(config.adminToken),
            missingConfig: config.missingConfig,
          },
          counts: {
            runsToday: store.countRunsSince(today),
            postedToday: store.countRunsSince(today, ['posted']),
            failedToday: store.countRunsSince(today, ['failed']),
            draftsPending: store.countRunsByStatus('drafted'),
            repositories: store.countRepositories(),
          },
          webhook: store.getWebhookHealth(),
        };
        return { overview: payload };
      });

      scope.get('/settings', async () => ({ settings: store.getGlobalSettings() }));

      scope.put('/settings', async (request, reply) => {
        const parsed = globalSettingsUpdateSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        if (parsed.data.generatorProvider === 'http_llm' && !config.llm.endpoint) {
          return reply.code(400).send({
            error: 'llm_not_configured',
            message: '已选择 http_llm，但服务端未配置 LLM_ENDPOINT（以及可选的 LLM_API_KEY）。请先配置环境变量。',
          });
        }
        const settings = store.updateGlobalSettings(parsed.data);
        store.addAudit({ actor: 'admin', action: 'settings.updated', detail: parsed.data });
        return { settings };
      });

      scope.get('/repos', async () => store.listRepositories());

      scope.get('/repos/:id', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的仓库 ID' });
        const repo = store.getRepositoryById(id);
        if (!repo) return reply.code(404).send({ error: 'not_found', message: '仓库不存在' });
        return { repo };
      });

      scope.patch('/repos/:id', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的仓库 ID' });
        const parsed = repoEnabledUpdateSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        const repo = store.setRepoEnabled(id, parsed.data.repoEnabled);
        if (!repo) return reply.code(404).send({ error: 'not_found', message: '仓库不存在' });
        store.addAudit({
          repoId: id,
          actor: 'admin',
          action: parsed.data.repoEnabled ? 'repo.enabled' : 'repo.disabled',
        });
        return { repo };
      });

      scope.put('/repos/:id/settings', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的仓库 ID' });
        const repo = store.getRepositoryById(id);
        if (!repo) return reply.code(404).send({ error: 'not_found', message: '仓库不存在' });
        const parsed = repoSettingsUpdateSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        const merged = { ...repo.settings, ...parsed.data };
        const conflict = validateMutualExclusion(merged);
        if (conflict) return reply.code(400).send({ error: 'invalid_settings', message: conflict });
        if (merged.quietHoursEnabled && !isValidTimeZone(merged.quietHoursTimezone)) {
          return reply.code(400).send({
            error: 'invalid_settings',
            message: `无效的时区：${merged.quietHoursTimezone}`,
          });
        }
        if (merged.templateId !== null && !store.getTemplate(merged.templateId)) {
          return reply.code(400).send({ error: 'invalid_settings', message: '指定的回复模板不存在' });
        }
        const settings = store.updateRepoSettings(id, parsed.data);
        store.addAudit({ repoId: id, actor: 'admin', action: 'repo.settings_updated', detail: parsed.data });
        return { settings };
      });

      scope.get('/runs', async (request, reply) => {
        const parsed = listRunsQuerySchema.safeParse(request.query);
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        return store.listRuns(parsed.data);
      });

      scope.get('/runs/:id', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的运行 ID' });
        const run = store.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not_found', message: '运行记录不存在' });
        return { run, jobs: store.listJobsForRun(id), audit: store.listAuditForRun(id) };
      });

      scope.post('/runs/:id/approve', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的运行 ID' });
        const run = store.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not_found', message: '运行记录不存在' });
        if (!(APPROVABLE_STATUSES as readonly string[]).includes(run.status)) {
          return reply.code(409).send({
            error: 'invalid_transition',
            message: `状态 ${run.status} 不能批准发布`,
          });
        }
        if (store.getGlobalSettings().dryRun) {
          return reply.code(409).send({
            error: 'dry_run_enabled',
            message: '当前为 dry-run 模式，不会调用发布 API。请先在全局设置中关闭 dry-run。',
          });
        }
        const parsed = approveRunSchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        const settings = store.getRepoSettings(run.repoId);
        const candidate = parsed.data.reply ?? run.editedReply ?? run.generatedReply;
        if (!candidate || !candidate.trim()) {
          return reply.code(400).send({ error: 'no_reply_content', message: '没有可发布的回复内容' });
        }
        const safety = sanitizeReply(candidate, { maxChars: settings.maxReplyChars });
        if (!safety.ok) {
          store.updateRun(id, {
            status: safety.code === 'blocked_sensitive' ? 'blocked_sensitive' : 'failed',
            reason: safety.code,
            errorCode: safety.code,
            errorMessage: safety.reason,
          });
          return reply.code(422).send({ error: safety.code, message: safety.reason });
        }
        store.updateRun(id, {
          status: 'approved',
          editedReply: safety.body,
          reason: 'approved_by_admin',
          errorCode: null,
          errorMessage: null,
        });
        store.enqueueJob(id, 'publish');
        store.addAudit({ runId: id, repoId: run.repoId, actor: 'admin', action: 'run.approved' });
        return { run: store.getRunById(id) };
      });

      scope.post('/runs/:id/reject', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的运行 ID' });
        const run = store.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not_found', message: '运行记录不存在' });
        if (!(REJECTABLE_STATUSES as readonly string[]).includes(run.status)) {
          return reply.code(409).send({
            error: 'invalid_transition',
            message: `状态 ${run.status} 不能拒绝`,
          });
        }
        const parsed = rejectRunSchema.safeParse(request.body ?? {});
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        const updated = store.updateRun(id, {
          status: 'rejected',
          reason: parsed.data.reason ?? 'rejected_by_admin',
        });
        store.addAudit({
          runId: id,
          repoId: run.repoId,
          actor: 'admin',
          action: 'run.rejected',
          detail: { reason: parsed.data.reason ?? null },
        });
        return { run: updated };
      });

      scope.post('/runs/:id/retry', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的运行 ID' });
        const run = store.getRunById(id);
        if (!run) return reply.code(404).send({ error: 'not_found', message: '运行记录不存在' });
        if (!(RETRYABLE_STATUSES as readonly string[]).includes(run.status)) {
          return reply.code(409).send({
            error: 'invalid_transition',
            message: `状态 ${run.status} 不能重试`,
          });
        }
        store.updateRun(id, {
          status: 'received',
          reason: 'retry_requested',
          errorCode: null,
          errorMessage: null,
          attempts: 0,
        });
        store.enqueueJob(id, 'process');
        store.addAudit({ runId: id, repoId: run.repoId, actor: 'admin', action: 'run.retry_requested' });
        return { run: store.getRunById(id) };
      });

      scope.get('/templates', async () => ({ items: store.listTemplates() }));

      scope.post('/templates', async (request, reply) => {
        const parsed = templateCreateSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        const template = store.createTemplate(parsed.data);
        store.addAudit({ actor: 'admin', action: 'template.created', detail: { id: template.id } });
        return reply.code(201).send({ template });
      });

      scope.put('/templates/:id', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的模板 ID' });
        const parsed = templateUpdateSchema.safeParse(request.body);
        if (!parsed.success) return sendValidationError(reply, parsed.error);
        const template = store.updateTemplate(id, parsed.data);
        if (!template) return reply.code(404).send({ error: 'not_found', message: '模板不存在' });
        store.addAudit({ actor: 'admin', action: 'template.updated', detail: { id } });
        return { template };
      });

      scope.delete('/templates/:id', async (request, reply) => {
        const id = idParam(request);
        if (!id) return reply.code(400).send({ error: 'invalid_id', message: '无效的模板 ID' });
        const result = store.deleteTemplate(id);
        if (result === 'missing') return reply.code(404).send({ error: 'not_found', message: '模板不存在' });
        if (result === 'builtin') {
          return reply.code(409).send({ error: 'builtin_template', message: '内置模板不可删除' });
        }
        store.addAudit({ actor: 'admin', action: 'template.deleted', detail: { id } });
        return reply.code(204).send();
      });

      scope.get('/audit', async (request) => {
        const limit = Number((request.query as { limit?: string }).limit ?? '50');
        return { items: store.listAudit(Number.isFinite(limit) ? limit : 50) };
      });
    },
    { prefix: '/api' }
  );
}
