import type { FastifyRequest } from 'fastify';
import type { AppConfig } from '../config';
import { safeEqual } from '../util/crypto';

export type AuthResult =
  | { ok: true }
  | { ok: false; status: 401 | 503; error: string; message: string };

export function checkAdminToken(request: FastifyRequest, config: AppConfig): AuthResult {
  const expected = config.adminToken;
  if (!expected) {
    return {
      ok: false,
      status: 503,
      error: 'admin_token_not_configured',
      message: '服务器未配置 ADMIN_TOKEN，管理 API 已禁用。请设置 ADMIN_TOKEN 后重启。',
    };
  }
  const header = request.headers.authorization;
  const match = typeof header === 'string' ? /^Bearer\s+(.+)$/i.exec(header) : null;
  if (!match || !safeEqual(match[1].trim(), expected)) {
    return { ok: false, status: 401, error: 'unauthorized', message: '未认证：请提供有效的管理员令牌' };
  }
  return { ok: true };
}
