import type { LlmConfig } from '../config';
import type { GenerationInput, GenerationResult, ReplyGenerator } from './types';
import { resolveLanguage } from './template';

export interface HttpLlmOptions extends Pick<LlmConfig, 'endpoint' | 'apiKey' | 'model' | 'timeoutMs'> {
  fetchImpl?: typeof fetch;
}

function buildMessages(input: GenerationInput, language: 'en' | 'zh-CN') {
  const system =
    language === 'zh-CN'
      ? [
          '你是一个开源仓库的维护助手，负责在 Issue/PR 下回复用户。',
          '要求：礼貌、简洁、基于给定上下文；不要承诺合并、关闭或修改代码；',
          '不要输出 @everyone/@channel，最多提及作者一次且不要加 @；不要包含密钥或令牌；',
          `回复长度不超过 ${input.maxReplyChars} 个字符，使用中文。`,
        ].join('\n')
      : [
          'You are a maintainer assistant replying to GitHub issues and pull requests.',
          'Be polite, concise and grounded in the provided context. Never promise code changes, merges or closures.',
          'Do not output @everyone or @channel, mention at most one person and do not use @. Never include secrets.',
          `Keep the reply under ${input.maxReplyChars} characters. Answer in English.`,
        ].join('\n');

  const comments = input.comments.slice(-10).map((comment) => `- ${comment.author}: ${comment.body.slice(0, 500)}`);
  const files = input.files.slice(0, 20).map((file) => `- ${file.filename} (${file.status}, +${file.additions}/-${file.deletions})`);
  const user = [
    `Repository: ${input.repo.owner}/${input.repo.name}`,
    `Type: ${input.kind}`,
    `Number: #${input.number}`,
    `Title: ${input.title}`,
    `Author: ${input.author}`,
    `Labels: ${input.labels.join(', ') || 'none'}`,
    `Trigger: ${input.trigger} (${input.action})`,
    '',
    'Body:',
    input.body.slice(0, 4000) || '(empty)',
    '',
    'Recent comments:',
    comments.length > 0 ? comments.join('\n') : '(none)',
    '',
    'Changed files:',
    files.length > 0 ? files.join('\n') : '(none)',
  ].join('\n');

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/**
 * Optional adapter for any OpenAI-compatible endpoint. If the call fails or
 * returns nothing usable, the deterministic template reply is used and the run
 * is marked with `fallback_used`.
 */
export class HttpLlmGenerator implements ReplyGenerator {
  constructor(
    private readonly fallback: ReplyGenerator,
    private readonly options: HttpLlmOptions
  ) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    try {
      const body = await this.complete(input);
      return { body, templateName: 'http_llm', fallbackUsed: false, provider: 'http_llm' };
    } catch {
      const fallback = await this.fallback.generate(input);
      return {
        body: fallback.body,
        templateName: `http_llm_fallback:${fallback.templateName}`,
        fallbackUsed: true,
        provider: 'http_llm',
      };
    }
  }

  private async complete(input: GenerationInput): Promise<string> {
    const language = resolveLanguage(`${input.title}\n${input.body}`, input.language);
    const fetchImpl = this.options.fetchImpl ?? fetch;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.options.timeoutMs);
    try {
      const response = await fetchImpl(this.options.endpoint ?? '', {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.options.apiKey ? { authorization: `Bearer ${this.options.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.options.model,
          messages: buildMessages(input, language),
          temperature: 0.2,
        }),
        signal: controller.signal,
      });
      if (!response.ok) throw new Error(`LLM endpoint responded with ${response.status}`);
      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (typeof content !== 'string' || content.trim() === '') {
        throw new Error('LLM response did not contain choices[0].message.content');
      }
      return content.trim();
    } finally {
      clearTimeout(timeout);
    }
  }
}
