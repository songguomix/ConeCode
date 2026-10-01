// Curated skill marketplace catalog (MiMo-style tiles). Pure data + a tiny
// draft helper so the UI can show a rich shelf without a remote registry.

export interface MarketSkill {
  id: string;
  name: string;
  tagline: string;
  tags: string[];
  /** Gradient pair for the tile art. */
  from: string;
  to: string;
  /** SKILL.md body seeded on install. */
  body: string;
}

export const MARKET_SKILLS: MarketSkill[] = [
  {
    id: 'ui-polish',
    name: '界面打磨',
    tagline: '动效、间距、可访问性一次到位',
    tags: ['ui', 'design', 'a11y'],
    from: '#C96442',
    to: '#E8A87C',
    body: `---
name: 界面打磨
description: When polishing UI motion, spacing, and accessibility.
tags: [ui, design, a11y]
---

1. Prefer transform/opacity animations; honor prefers-reduced-motion.
2. Keep contrast AA+ for body text.
3. Reuse existing design tokens — do not invent new hex colors casually.`,
  },
  {
    id: 'test-hardening',
    name: '测试加固',
    tagline: '先失败再修复，拒绝绿灯造假',
    tags: ['test', 'quality'],
    from: '#2D8A56',
    to: '#7BC96F',
    body: `---
name: 测试加固
description: When adding or repairing tests.
tags: [test, quality]
---

1. Write a failing test that proves the bug first.
2. Never weaken assertions to make CI green.
3. Prefer behavior tests over mock-only checks.`,
  },
  {
    id: 'perf-triage',
    name: '性能分诊',
    tagline: '卡顿、重渲染、大文件',
    tags: ['perf', 'react'],
    from: '#3D6BA8',
    to: '#8BB8E8',
    body: `---
name: 性能分诊
description: When the UI stutters or lists re-render too often.
tags: [perf, react]
---

1. Profile the hot path before editing.
2. Fix subscription identity and memo boundaries first.
3. Measure before/after with a concrete scenario.`,
  },
  {
    id: 'docs-sync',
    name: '文档同步',
    tagline: 'README 与真实行为对齐',
    tags: ['docs'],
    from: '#B8762B',
    to: '#E8C48A',
    body: `---
name: 文档同步
description: When code and docs drift apart.
tags: [docs]
---

1. Read the public API and the README claims.
2. Fix the lie in docs or code — not both with hand-waving.
3. Keep examples runnable.`,
  },
  {
    id: 'secure-edit',
    name: '安全改动',
    tagline: '鉴权、密钥、命令注入',
    tags: ['security'],
    from: '#C43E2E',
    to: '#E88A6A',
    body: `---
name: 安全改动
description: When touching auth, secrets, or shell/file boundaries.
tags: [security]
---

1. Never log secrets. Validate all external input.
2. Prefer least privilege. No disabled TLS or checks.
3. Call out residual risk in the summary.`,
  },
  {
    id: 'api-design',
    name: 'API 设计',
    tagline: '清晰、可演进的接口',
    tags: ['api', 'architecture'],
    from: '#9D4EDD',
    to: '#C9A0DC',
    body: `---
name: API 设计
description: When designing public functions or IPC surfaces.
tags: [api, architecture]
---

1. Name by caller intent, not implementation.
2. Make illegal states unrepresentable where cheap.
3. Version or document breaking changes explicitly.`,
  },
  {
    id: 'release-check',
    name: '发布检查',
    tagline: '构建、类型、冒烟',
    tags: ['release'],
    from: '#267F99',
    to: '#6DC9B0',
    body: `---
name: 发布检查
description: Before calling work done or shipping a build.
tags: [release]
---

1. Run typecheck, tests, and build.
2. Smoke the golden path once.
3. List what you did NOT verify.`,
  },
  {
    id: 'i18n-ready',
    name: '多语言就绪',
    tagline: 'en / zh / ja 文案齐全',
    tags: ['i18n'],
    from: '#8B6340',
    to: '#D4B896',
    body: `---
name: 多语言就绪
description: When adding user-visible strings.
tags: [i18n]
---

1. Add keys for en, zh, ja together.
2. Never hardcode UI copy in components.
3. Keep labels short; hints can be longer.`,
  },
];

export function marketSkillDraft(m: MarketSkill) {
  return {
    id: m.id,
    name: m.name,
    description: m.tagline,
    tags: m.tags,
    body: m.body,
    scope: 'project' as const,
    source: 'builtin' as const,
  };
}
