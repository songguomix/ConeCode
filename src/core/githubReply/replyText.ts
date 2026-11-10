import type { ReplyLanguage, ReplyThreadContext } from '../../types/githubReply.types';

export const REPLY_MAX_CHARS = 4000;

interface SensitivePattern {
  name: string;
  pattern: RegExp;
}

/** Hard-coded; replies that look like they contain credentials are never posted. */
const SENSITIVE_PATTERNS: SensitivePattern[] = [
  { name: 'private_key', pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----/ },
  { name: 'github_token', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'github_pat', pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'openai_key', pattern: /\bsk-[A-Za-z0-9_-]{20,}/ },
  { name: 'aws_key', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'slack_token', pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\b/ },
  {
    name: 'credential_assignment',
    pattern: /(?:password|passwd|secret|api[_-]?key|access[_-]?token)\s*[:=]\s*\S{8,}/i,
  },
];

export function findSensitive(text: string): string | null {
  for (const candidate of SENSITIVE_PATTERNS) {
    if (candidate.pattern.test(text)) return candidate.name;
  }
  return null;
}

export type SanitizeReplyResult =
  | { ok: true; body: string }
  | { ok: false; code: 'empty' | 'sensitive'; message: string };

const TRUNCATION_MARKER = '\n\n…（内容已截断 / truncated）';

/**
 * Cleans a reply before it is shown for confirmation or posted: blocks
 * secret-looking strings, drops channel-wide mentions, caps mentions and
 * enforces the length limit.
 */
export function sanitizeReply(raw: unknown, maxChars = REPLY_MAX_CHARS): SanitizeReplyResult {
  const normalized = String(raw ?? '')
    .replace(/\r\n/g, '\n')
    .trim();
  if (!normalized) {
    return { ok: false, code: 'empty', message: 'The reply is empty.' };
  }
  if (findSensitive(normalized)) {
    return {
      ok: false,
      code: 'sensitive',
      message: 'This reply looks like it contains a secret, so it was blocked. Remove the token or password and try again.',
    };
  }

  let body = normalized.replace(/@(everyone|channel|here)\b/gi, '');
  const seen = new Set<string>();
  body = body.replace(/@([A-Za-z0-9][A-Za-z0-9-]{0,38})/g, (full, handle: string) => {
    const key = handle.toLowerCase();
    if (seen.has(key) || seen.size >= 3) return handle;
    seen.add(key);
    return full;
  });
  body = body.replace(/\n{4,}/g, '\n\n\n').trim();

  const limit = Math.max(200, maxChars || REPLY_MAX_CHARS);
  if (body.length > limit) {
    const cutAt = Math.max(0, limit - TRUNCATION_MARKER.length);
    body = `${body.slice(0, cutAt).trimEnd()}${TRUNCATION_MARKER}`;
  }
  if (!body) {
    return { ok: false, code: 'empty', message: 'The reply is empty.' };
  }
  return { ok: true, body };
}

export function resolveReplyLanguage(
  title: string,
  body: string,
  requested: ReplyLanguage
): 'zh' | 'en' {
  if (requested === 'zh') return 'zh';
  if (requested === 'en') return 'en';
  const text = `${title}\n${body}`;
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk * 4 >= latin ? 'zh' : 'en';
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function needsMoreDetails(body: string): boolean {
  const text = body.trim();
  const hasHints =
    /(reproduc|steps to|expected|actual|version|environment|traceback|log|复现|重现|步骤|预期|实际|版本|环境|日志)/i.test(
      text
    );
  if (hasHints) return text.length < 40;
  return true;
}

function labelList(labels: string[], language: 'zh' | 'en'): string {
  if (labels.length === 0) return language === 'zh' ? '无' : 'none';
  return labels.join(language === 'zh' ? '、' : ', ');
}

/**
 * Deterministic, offline draft for the GitHub plugin's reply assistant. The
 * user edits the result before posting; nothing is sent automatically.
 */
export function buildReplyDraft(
  context: ReplyThreadContext,
  options: { language: ReplyLanguage }
): string {
  const language = resolveReplyLanguage(context.title, context.body, options.language);
  const author = context.author.replace(/^@/, '');
  const title = clamp(context.title || `#${context.number}`, 160);
  const labels = labelList(context.labels, language);
  const comments = context.recentComments.length;

  if (context.isPullRequest) {
    return language === 'zh'
      ? `感谢提交 PR，${author}。维护者会尽快审查 ${context.repo}#${context.number}。

审查前请确认：
- [ ] 描述说明了改动内容和动机
- [ ] 已包含测试或手动验证步骤
- [ ] 行为变化时已更新文档
- [ ] 已关联相关 Issue

标题：${title}
标签：${labels}
最近评论：${comments} 条`
      : `Thanks for the pull request, ${author}. A maintainer will review ${context.repo}#${context.number} soon.

Before review, please confirm:
- [ ] The description explains the change and the motivation
- [ ] Tests or manual verification steps are included
- [ ] Documentation is updated when behavior changes
- [ ] The related issue is linked

Title: ${title}
Labels: ${labels}
Recent comments: ${comments}`;
  }

  if (needsMoreDetails(context.body)) {
    return language === 'zh'
      ? `感谢反馈，${author}。为了复现 ${context.repo}#${context.number}，能否补充：

1. 复现步骤
2. 预期行为与实际行为
3. 版本 / 运行环境
4. 相关日志或截图

补充后维护者会继续跟进。`
      : `Thanks for the report, ${author}. To help us reproduce ${context.repo}#${context.number}, could you add:

1. Steps to reproduce
2. Expected behavior vs. actual behavior
3. Version / environment details
4. Any relevant logs or screenshots

Once we have those, a maintainer will follow up.`;
  }

  return language === 'zh'
    ? `感谢你提交 Issue，${author}。

仓库：${context.repo} · #${context.number}
标题：${title}
标签：${labels}

维护者会尽快查看。如果能补充复现步骤、预期与实际行为、以及运行环境，会帮助我们更快定位问题。`
    : `Thanks for opening this issue, ${author}.

Repository: ${context.repo} · #${context.number}
Title: ${title}
Labels: ${labels}

A maintainer will take a look. If you can add reproduction steps, expected vs. actual behavior, and your environment, that will speed up triage.`;
}
