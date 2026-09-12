// Slash-command registry. Mirrors the Codex / Claude Code command palette: the
// user types "/" in the chat input to get an autocomplete list, and each command
// is either run locally in the renderer ('client') or expanded into a prompt and
// sent to the agent ('prompt'). Custom project commands are loaded from
// <workspace>/.conecode/commands/*.md (filename = command, body = prompt
// template, with $ARGUMENTS substituted) — see workspace.store.ts.

export type SlashCommandKind = 'client' | 'prompt';

export interface SlashCommand {
  name: string;
  // i18n key (built-ins) or a literal one-line description (custom commands).
  description: string;
  kind: SlashCommandKind;
  // For 'prompt' commands: the message template sent to the agent. Supports the
  // $ARGUMENTS placeholder, replaced with whatever the user typed after the name.
  template?: string;
  custom?: boolean;
}

const INIT_TEMPLATE = `Analyze this project and create an AGENTS.md file at the workspace root.

First explore the structure: list the root directory, then read key files such as package.json, README, and the main entry points / config. Then create_file an AGENTS.md containing, concisely:
- A one-paragraph project overview (what it is, tech stack).
- How to install, build, run, and test it (exact commands).
- Key directories and what lives in them.
- Code conventions an AI coding agent should follow.
- Anything non-obvious worth knowing before editing.

Keep it accurate and skimmable. After writing the file, confirm in one sentence.`;

const DIFF_TEMPLATE = `Run \`git -C "<workspace root>" diff\` (and \`git status\`) and give me a concise summary of the current uncommitted changes, grouped by file. If this is not a git repository, say so.`;

const COMMIT_TEMPLATE = `Review the current git changes: run \`git status\` and \`git diff\` (and \`git diff --staged\`). Then stage all changes (\`git add -A\`) and create a commit whose message follows the Conventional Commits style and accurately describes the changes. Show me the proposed commit message in your reply before running the commit. $ARGUMENTS`;

export const BUILTIN_COMMANDS: SlashCommand[] = [
  { name: 'help', description: 'cmdHelp', kind: 'client' },
  { name: 'clear', description: 'cmdClear', kind: 'client' },
  { name: 'compact', description: 'cmdCompact', kind: 'client' },
  { name: 'plan', description: 'cmdPlan', kind: 'client' },
  { name: 'goal', description: 'cmdGoal', kind: 'client' },
  { name: 'review', description: 'cmdReview', kind: 'client' },
  { name: 'worktree', description: 'cmdWorktree', kind: 'client' },
  { name: 'init', description: 'cmdInit', kind: 'prompt', template: INIT_TEMPLATE },
  { name: 'agents', description: 'cmdAgents', kind: 'client' },
  { name: 'add-dir', description: 'cmdAddDir', kind: 'client' },
  { name: 'model', description: 'cmdModel', kind: 'client' },
  { name: 'memory', description: 'cmdMemory', kind: 'client' },
  { name: 'diff', description: 'cmdDiff', kind: 'prompt', template: DIFF_TEMPLATE },
  { name: 'commit', description: 'cmdCommit', kind: 'prompt', template: COMMIT_TEMPLATE },
];

// Parse a raw input string into { name, args } if it is a slash command line.
// Returns null when the text isn't a "/command …" form.
export function parseSlashInput(input: string): { name: string; args: string } | null {
  const m = input.match(/^\/([A-Za-z0-9_-]+)\s*([\s\S]*)$/);
  if (!m) return null;
  return { name: m[1].toLowerCase(), args: m[2] };
}

// Find a command by exact name across built-ins + custom.
export function findCommand(name: string, customs: SlashCommand[]): SlashCommand | undefined {
  const n = name.toLowerCase();
  return [...BUILTIN_COMMANDS, ...customs].find((c) => c.name.toLowerCase() === n);
}

// All commands whose name starts with `prefix` (for the autocomplete dropdown).
// An empty prefix returns everything.
export function matchCommands(prefix: string, customs: SlashCommand[]): SlashCommand[] {
  const p = prefix.toLowerCase();
  return [...BUILTIN_COMMANDS, ...customs].filter((c) => c.name.toLowerCase().startsWith(p));
}

// Expand a 'prompt' command's template with the user's arguments.
export function expandTemplate(template: string, args: string): string {
  if (template.includes('$ARGUMENTS')) return template.replace(/\$ARGUMENTS/g, args).trim();
  return args ? `${template}\n\n${args}` : template;
}
