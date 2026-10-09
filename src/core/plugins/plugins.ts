// Plugins are NOT skills and must never fight them.
//
// - A SKILL is instructions for the agent (SKILL.md, `use_skill`, the + menu).
//   It lives in the skills system and knows nothing about plugins.
// - A PLUGIN is an app extension unit: metadata, an optional linked skill that
//   does its legwork, and an optional dedicated view in the plugin library.
//   It lives in the plugin registry below and knows nothing about prompting.
//
// The two meet at exactly one joint: `skillId`. A plugin may name the skill
// that executes its work; enabling/disabling either side never touches the
// other.

export type PluginKind = 'builtin' | 'market' | 'custom';

/** Which dedicated view a plugin opens. `skill` = generic run/recent-runs. */
export type PluginView = 'sync' | 'perf' | 'security' | 'skill';

export interface PluginDef {
  id: string;
  /** Fixed display name (like skill names — not translated). */
  name: string;
  description: string;
  kind: PluginKind;
  /** Icon key rendered by the library (react-icons live in the view layer). */
  icon: 'github' | 'activity' | 'shield' | 'list' | 'commit' | 'map' | 'box';
  skillId?: string;
  view?: PluginView;
}

/** What ships with the app — our own plugins only, never anyone else's. */
export const BUILTIN_PLUGINS: PluginDef[] = [
  {
    id: 'github-sync',
    name: 'GitHub 同步',
    description: '从 GitHub 仓库同步插件，改完一键推回去，一个 Token 全搞定。',
    kind: 'builtin',
    icon: 'github',
    view: 'sync',
  },
  {
    id: 'perf-monitor',
    name: '性能巡检',
    description: '查本软件有没有性能缺陷，只出报告不动手。',
    kind: 'builtin',
    icon: 'activity',
    skillId: 'perf-monitor',
    view: 'perf',
  },
  {
    id: 'security-review',
    name: '安全审查',
    description: '按规则审代码漏洞，支持整仓或只审变更文件。',
    kind: 'builtin',
    icon: 'shield',
    skillId: 'security-review',
    view: 'security',
  },
  {
    id: 'todo-scan',
    name: 'TODO 扫描',
    description: '全仓扫 TODO/FIXME，按会烂程度排好序。',
    kind: 'builtin',
    icon: 'list',
    skillId: 'todo-scan',
    view: 'skill',
  },
  {
    id: 'commit-msg',
    name: '提交信息',
    description: '读 diff 写规范提交信息，只写不提交。',
    kind: 'builtin',
    icon: 'commit',
    skillId: 'commit-msg',
    view: 'skill',
  },
  {
    id: 'repo-map',
    name: '仓库导览',
    description: '新人地图：启动链、模块表、先读哪三个文件。',
    kind: 'builtin',
    icon: 'map',
    skillId: 'repo-map',
    view: 'skill',
  },
];

export function findBuiltinPlugin(id: string): PluginDef | undefined {
  return BUILTIN_PLUGINS.find((p) => p.id === id);
}

/**
 * The prompt sent to the AI chat when the user picks "创建插件": the agent
 * interviews for name/purpose, drafts the SKILL.md when skill work is needed,
 * and explains the two manual steps (paste into 设置→技能, then link it here).
 */
export function buildCreatePluginPrompt(): string {
  return `帮我创建一个 ConeCode 插件。先问清三件事再动手：插件叫什么、解决什么具体问题、需不需要 AI 执行能力（需要的话才写技能）。

规则：
1. 插件是插件，技能是技能：插件 = 元信息（名字、描述）+ 可选的界面；技能 = 给 AI 的指令（SKILL.md）。不要混在一起。
2. 如果需要 AI 执行：按 SKILL.md 格式写出 name、description（必须含一句英文 Use when…）、body（先讲触发条件，再讲只读步骤，最后讲报告格式；只检查不修，除非我明确说修），把全文贴出来让我复制。
3. 然后告诉我两步手动操作：在「设置 → 技能」里新建粘贴保存，再回「设置 → 插件」用添加表单把技能链上。
4. 不需要 AI 执行的插件（如纯展示、纯跳转）：直接给我名字和一句话描述，我自己在插件库添加表单里建。`;
}
