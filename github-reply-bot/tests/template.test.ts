import { describe, expect, it } from 'vitest';
import { TemplateGenerator, resolveLanguage } from '../src/server/generator/template';
import type { GenerationInput } from '../src/server/generator/types';

function input(overrides: Partial<GenerationInput> = {}): GenerationInput {
  return {
    kind: 'issue',
    trigger: 'issue_opened',
    action: 'opened',
    repo: { owner: 'acme', name: 'widgets' },
    number: 7,
    title: 'Crash when starting the app',
    body: 'Steps to reproduce: run it. Expected: starts. Actual: crash. Version 1.2.3.',
    author: 'alice',
    labels: ['bug'],
    comments: [],
    files: [],
    totalChangedFiles: 0,
    language: 'auto',
    maxReplyChars: 2000,
    mention: false,
    ...overrides,
  };
}

describe('template generator', () => {
  it('detects Chinese and English content', () => {
    expect(resolveLanguage('应用启动后崩溃，请帮忙看看', 'auto')).toBe('zh-CN');
    expect(resolveLanguage('The app crashes on start, please help', 'auto')).toBe('en');
    expect(resolveLanguage('中文内容', 'en')).toBe('en');
    expect(resolveLanguage('English content', 'zh-CN')).toBe('zh-CN');
  });

  it('acknowledges an issue with reproduction details', async () => {
    const result = await new TemplateGenerator().generate(input());
    expect(result.templateName).toBe('issue_ack');
    expect(result.body).toContain('alice');
    expect(result.body).toContain('acme/widgets');
    expect(result.body).toContain('Crash when starting the app');
  });

  it('asks for reproduction steps when the report is thin', async () => {
    const result = await new TemplateGenerator().generate(input({ body: 'broken' }));
    expect(result.templateName).toBe('needs_repro');
    expect(result.body).toMatch(/reproduce|Steps/i);
  });

  it('generates a PR checklist including changed files', async () => {
    const result = await new TemplateGenerator().generate(
      input({
        kind: 'pull_request',
        trigger: 'pr_opened',
        title: 'Add caching',
        files: [{ filename: 'src/cache.ts', status: 'added', additions: 40, deletions: 1 }],
        totalChangedFiles: 1,
      })
    );
    expect(result.templateName).toBe('pr_checklist');
    expect(result.body).toContain('src/cache.ts');
    expect(result.body).toContain('+40/-1');
  });

  it('sends the Chinese template when the language is zh-CN', async () => {
    const result = await new TemplateGenerator().generate(input({ title: '启动崩溃', body: '复现步骤…', language: 'zh-CN' }));
    expect(result.body).toContain('感谢');
    expect(result.body).toContain('acme/widgets');
  });

  it('replies to mentions with the mention template', async () => {
    const result = await new TemplateGenerator().generate(input({ trigger: 'mention', mention: true }));
    expect(result.templateName).toBe('mention');
    expect(result.body).toContain('#7');
  });

  it('renders a custom template body', async () => {
    const generator = new TemplateGenerator('Hi {{author}} — custom reply for {{repo}}#{{number}} ({{labels}})');
    const result = await generator.generate(input({ labels: ['bug', 'urgent'] }));
    expect(result.templateName).toBe('custom_template');
    expect(result.body).toBe('Hi alice — custom reply for acme/widgets#7 (bug, urgent)');
  });
});
