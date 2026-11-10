export type TemplateKey = 'issue_ack' | 'needs_repro' | 'pr_checklist' | 'mention';

export interface BuiltinTemplateDefinition {
  key: TemplateKey;
  name: string;
  body: Record<'en' | 'zh-CN', string>;
}

export const BUILTIN_TEMPLATES: BuiltinTemplateDefinition[] = [
  {
    key: 'issue_ack',
    name: '内置 · 新 Issue 确认 / Issue acknowledgement',
    body: {
      en: `Thanks for opening this issue, {{author}}.

Repository: {{repo}}
Title: {{title}}
Labels: {{labels}}

A maintainer will take a look. If you can add reproduction steps, expected vs. actual behavior, and your environment, that will speed up triage.`,
      'zh-CN': `感谢你提交 Issue，{{author}}。

仓库：{{repo}}
标题：{{title}}
标签：{{labels}}

维护者会尽快查看。如果能补充复现步骤、预期与实际行为，以及运行环境，会帮助我们更快定位问题。`,
    },
  },
  {
    key: 'needs_repro',
    name: '内置 · 请求补充复现信息 / Needs reproduction',
    body: {
      en: `Thanks for the report, {{author}}. To help us reproduce this on {{repo}}#{{number}}, could you add:

1. Steps to reproduce
2. Expected behavior vs. actual behavior
3. Version / environment details
4. Any relevant logs or screenshots

Once we have those, a maintainer will follow up.`,
      'zh-CN': `感谢反馈，{{author}}。为了在 {{repo}}#{{number}} 上复现问题，能否补充：

1. 复现步骤
2. 预期行为与实际行为
3. 版本 / 运行环境
4. 相关日志或截图

补充后维护者会继续跟进。`,
    },
  },
  {
    key: 'pr_checklist',
    name: '内置 · PR 预审清单 / Pull request checklist',
    body: {
      en: `Thanks for the pull request, {{author}}. A maintainer will review {{repo}}#{{number}} soon.

Before review, please confirm:
- [ ] The description explains the change and the motivation
- [ ] Tests or manual verification steps are included
- [ ] Documentation is updated when behavior changes
- [ ] The related issue is linked

Files touched in this PR:
{{files}}`,
      'zh-CN': `感谢提交 PR，{{author}}。维护者会尽快审查 {{repo}}#{{number}}。

审查前请确认：
- [ ] 描述说明了改动内容和动机
- [ ] 已包含测试或手动验证步骤
- [ ] 行为变化时已更新文档
- [ ] 已关联相关 Issue

本次改动的文件：
{{files}}`,
    },
  },
  {
    key: 'mention',
    name: '内置 · 被 @ 提及时的回复 / Mention reply',
    body: {
      en: `Thanks for the mention, {{author}}. A maintainer will follow up on {{repo}}#{{number}}.

Context: {{title}}`,
      'zh-CN': `感谢 @ 我，{{author}}。维护者会跟进 {{repo}}#{{number}}。

上下文：{{title}}`,
    },
  },
];

export function builtinTemplate(key: TemplateKey, language: 'en' | 'zh-CN'): string {
  const found = BUILTIN_TEMPLATES.find((t) => t.key === key);
  if (!found) throw new Error(`Unknown builtin template: ${key}`);
  return found.body[language];
}
