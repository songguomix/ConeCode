import type { ReplyLanguage } from '../../shared/types';
import { builtinTemplate, type TemplateKey } from './builtinTemplates';
import type { GenerationInput, GenerationResult, ReplyGenerator } from './types';

export function resolveLanguage(text: string, requested: ReplyLanguage): 'en' | 'zh-CN' {
  if (requested === 'zh-CN') return 'zh-CN';
  if (requested === 'en') return 'en';
  const cjk = (text.match(/[\u3400-\u9fff]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return cjk > 0 && cjk * 4 >= latin ? 'zh-CN' : 'en';
}

function clamp(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

function needsReproductionDetails(body: string): boolean {
  const text = body.trim();
  const hasDetails =
    /(reproduc|steps to|expected|actual|version|environment|traceback|log|复现|重现|步骤|预期|实际|版本|环境|日志)/i.test(
      text
    );
  // Reports that already describe how to reproduce only need more detail when
  // they are extremely short; everything else gets the "please add details" reply.
  if (hasDetails) return text.length < 40;
  return true;
}

function pickTemplateKey(input: GenerationInput): TemplateKey {
  if (input.mention) return 'mention';
  if (input.kind === 'pull_request') return 'pr_checklist';
  return needsReproductionDetails(input.body) ? 'needs_repro' : 'issue_ack';
}

function renderTemplate(template: string, input: GenerationInput, language: 'en' | 'zh-CN'): string {
  const files =
    input.files.length > 0
      ? input.files
          .slice(0, 10)
          .map((file) => `- \`${file.filename}\` (${file.status}, +${file.additions}/-${file.deletions})`)
          .join('\n')
      : language === 'zh-CN'
        ? '未读取到文件列表'
        : 'No changed files were read';

  const replacements: Record<string, string> = {
    author: input.author.replace(/^@/, ''),
    repo: `${input.repo.owner}/${input.repo.name}`,
    number: String(input.number),
    title: clamp(input.title || `#${input.number}`, 200),
    labels:
      input.labels.length > 0 ? input.labels.join(language === 'zh-CN' ? '、' : ', ') : language === 'zh-CN' ? '无' : 'none',
    files,
    filesCount: String(input.totalChangedFiles),
    commentsCount: String(input.comments.length),
  };

  return template.replace(/\{\{\s*([a-zA-Z]+)\s*\}\}/g, (full, key: string) =>
    Object.prototype.hasOwnProperty.call(replacements, key) ? replacements[key] : full
  );
}

/** Default generator: deterministic, offline, editable templates. */
export class TemplateGenerator implements ReplyGenerator {
  constructor(private readonly customTemplateBody?: string) {}

  async generate(input: GenerationInput): Promise<GenerationResult> {
    const language = resolveLanguage(`${input.title}\n${input.body}\n${input.comments.map((c) => c.body).join('\n')}`, input.language);
    const key = pickTemplateKey(input);
    const template = this.customTemplateBody ?? builtinTemplate(key, language);
    const body = renderTemplate(template, input, language);
    return {
      body,
      templateName: this.customTemplateBody ? 'custom_template' : key,
      fallbackUsed: false,
      provider: 'template',
    };
  }
}
