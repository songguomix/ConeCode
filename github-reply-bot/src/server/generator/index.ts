import type { GeneratorProvider } from '../../shared/types';
import type { LlmConfig } from '../config';
import { HttpLlmGenerator } from './httpLlm';
import { TemplateGenerator } from './template';
import type { ReplyGenerator } from './types';

export class GeneratorConfigError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'GeneratorConfigError';
    this.code = code;
  }
}

export interface CreateGeneratorOptions {
  provider: GeneratorProvider;
  templateBody?: string;
  llm: LlmConfig;
  fetchImpl?: typeof fetch;
}

export function createGenerator(options: CreateGeneratorOptions): ReplyGenerator {
  const template = new TemplateGenerator(options.templateBody);
  if (options.provider === 'template') return template;
  if (options.provider === 'http_llm') {
    if (!options.llm.endpoint) {
      throw new GeneratorConfigError(
        'llm_endpoint_not_configured',
        '已选择 http_llm 生成器，但未配置 LLM_ENDPOINT。请在环境变量中配置端点与密钥，或改用 template 生成器。'
      );
    }
    return new HttpLlmGenerator(template, {
      endpoint: options.llm.endpoint,
      apiKey: options.llm.apiKey,
      model: options.llm.model,
      timeoutMs: options.llm.timeoutMs,
      fetchImpl: options.fetchImpl,
    });
  }
  throw new GeneratorConfigError('unknown_generator', `未知的生成器: ${String(options.provider)}`);
}

export { TemplateGenerator, resolveLanguage } from './template';
export { HttpLlmGenerator } from './httpLlm';
export type { GenerationInput, GenerationResult, ReplyGenerator } from './types';
