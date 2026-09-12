// Autopilot: pick an idea, get a working project.
//
// The user's only decision is WHICH project. Everything after the click is the
// agent's job — create the folder, choose the stack, write the code, install,
// run it, and keep fixing until a real verification command passes.
//
// Pure module: idea catalogue, prompts, parsing, folder naming and the
// verification contract. No IPC, no store.

export interface ProjectIdea {
  id: string;
  /** Short product name, used for the folder and the conversation title. */
  title: string;
  /** One line on what it does, for the card. */
  description: string;
  /** Concrete stack so the card is honest about what gets installed. */
  stack: string;
  tags: string[];
  /** Rough build size, shown so a click is an informed one. */
  scale: 'small' | 'medium';
}

/**
 * Shown when there is no model configured yet, offline, or while the live list
 * loads — the feature must never present an empty screen. Deliberately ordinary,
 * currently-popular starter projects that a coding agent can finish in one run.
 */
export const FALLBACK_IDEAS: Omit<ProjectIdea, 'id'>[] = [
  {
    title: 'MCP Server',
    description: 'A Model Context Protocol server exposing a few useful tools any AI client can call.',
    stack: 'TypeScript · Node',
    tags: ['AI', 'tooling'],
    scale: 'small',
  },
  {
    title: 'CLI Tool',
    description: 'A command-line utility with argument parsing, colored output and a real test suite.',
    stack: 'TypeScript · Node',
    tags: ['CLI'],
    scale: 'small',
  },
  {
    title: 'REST API',
    description: 'A small JSON API with routing, validation, an in-memory store and endpoint tests.',
    stack: 'TypeScript · Hono',
    tags: ['backend'],
    scale: 'small',
  },
  {
    title: 'Web Dashboard',
    description: 'A single-page dashboard with charts and filtering over sample data.',
    stack: 'React · Vite · Tailwind',
    tags: ['frontend'],
    scale: 'medium',
  },
  {
    title: 'Python Data Tool',
    description: 'A script that ingests a CSV, computes summary statistics and writes a report.',
    stack: 'Python',
    tags: ['data'],
    scale: 'small',
  },
  {
    title: 'Browser Extension',
    description: 'A Manifest V3 extension with a popup and a content script that changes the page.',
    stack: 'TypeScript · Vite',
    tags: ['frontend'],
    scale: 'medium',
  },
];

export const IDEAS_SYSTEM_PROMPT = `You suggest starter projects for a coding agent that will build them completely on its own, unattended, in one run.

Reply with JSON and nothing else:
{"ideas":[{"title":"...","description":"...","stack":"...","tags":["..."],"scale":"small|medium"}]}

Rules:
- Exactly 6 ideas, each a DIFFERENT kind of project (CLI, web app, API, AI/agent tooling, data, automation…).
- Popular and current — the kinds of things people are actually building now.
- Each must be finishable end-to-end by an agent in one unattended run, on a normal developer machine, with NO API keys, NO paid services, NO login, and NO network access beyond installing public packages. Nothing that needs a database server, Docker, or cloud credentials.
- title: 2-4 words, a product name, no punctuation.
- description: ONE sentence on what it does.
- stack: the concrete stack, e.g. "TypeScript · Node" or "React · Vite · Tailwind". Mainstream and installable from a public registry.
- scale: "small" if a focused single-purpose program, "medium" if it has a UI plus a couple of screens.`;

/** How the agent must report the command that proves the project works. */
export const VERIFY_MARKER = 'VERIFY_COMMAND:';

/**
 * Written the moment an empty project folder is created, so every from-scratch
 * task starts with a README the agent must keep accurate rather than one it
 * may forget to add.
 */
export function starterProjectReadme(title: string): string {
  return `# ${title}

Scaffolded by ConeCode. Keep this README accurate as the project grows.

## What it is

<!-- Who this is for, and what it does. -->

## Features

- <!-- core features -->

## Stack

<!-- Languages, frameworks, package manager. -->

## Install

\`\`\`bash
# real install command
\`\`\`

## Run

\`\`\`bash
# real run command
\`\`\`

## Test

\`\`\`bash
# real test / verify command
\`\`\`

## Notes

<!-- Status, limitations, next steps. -->
`;
}

export function buildAutopilotPrompt(idea: { title: string; description: string; stack: string }, dir: string): string {
  return `Build this project completely on your own. I will not be watching, and I will not answer questions — every decision is yours.

PROJECT: ${idea.title}
WHAT IT DOES: ${idea.description}
SUGGESTED STACK: ${idea.stack} (change it if something else genuinely fits better)
DIRECTORY: ${dir} (already created; a starter README.md is present — put everything there, never write outside it)

Do all of this, in order, without stopping to ask:
1. Scaffold the project: real directory structure, package/config files, and a .gitignore.
2. Write the ACTUAL working code — every feature in the description, no placeholders, no "TODO: implement", no stub functions that return fake data.
3. Install dependencies with the real package manager, and use only packages that exist on the public registry.
4. Write at least one meaningful test that exercises the main behaviour — not a trivial assert(true).
5. RUN the install, the build (if any) and the tests yourself. Read the output. If anything fails, fix it and run it again. Keep going until it genuinely passes; a project that does not run is not finished.
6. Complete README.md (seeded when the folder was created): what it is, features, stack, and the exact commands to install, run and test. Do not leave placeholder sections.
7. REVIEW FROM THE TOP. Go back to the start and read the finished project as if someone had just handed it to you: re-read the description above and tick off every feature against the code that actually exists, then open every file you wrote, end to end. Look for what a passing test does not catch — a feature from the description you never built, a stub left behind, a README command that does not match the real scripts, an import whose package was never installed. Fix anything you find, run the tests again, and repeat until a full pass turns up nothing.

Hard requirements:
- Do NOT ask me anything. Do NOT stop half-way to report progress and wait. Work until it is done.
- Nothing may require an API key, a paid service, a login, or a running database. If your design needs one, change the design.
- Prefer a smaller project that actually runs over an ambitious one that does not.

When — and only when — the tests genuinely pass AND that review turns up nothing, finish your final message with this line on its own, giving the single command that proves the project works from ${dir}:

${VERIFY_MARKER} <command>

For example: "${VERIFY_MARKER} npm test". The command must exit non-zero if the project is broken.`;
}

/** The follow-up when the app's own verification run fails. */
export function buildRepairPrompt(command: string, output: string, attempt: number, maxAttempts: number): string {
  return `I ran your verification command in the project directory and it FAILED (attempt ${attempt} of ${maxAttempts}).

$ ${command}

${output.slice(0, 6000)}

Fix the real cause and make it pass. Read the failing files before changing them, run the command yourself to confirm it now passes, and do not ask me anything. Then review from the top once more — re-read the project description and the files you just changed, end to end — because a repair that quietly breaks something else is still a broken project. If the command itself was wrong, fix the project and reply with a corrected "${VERIFY_MARKER} <command>" line.`;
}

/**
 * Pull the verification command out of the agent's final message. Falls back to
 * scanning for the marker anywhere, since models like to add trailing prose.
 */
export function extractVerifyCommand(text: string): string | null {
  if (!text) return null;
  const idx = text.lastIndexOf(VERIFY_MARKER);
  if (idx === -1) return null;
  const line = text.slice(idx + VERIFY_MARKER.length).split('\n')[0].trim();
  // Models often wrap it in backticks or quotes.
  const cleaned = line.replace(/^[`'"]+|[`'"]+$/g, '').trim();
  return cleaned || null;
}

/** Guess a verification command from what the project turned out to be. */
export function guessVerifyCommand(files: string[]): string | null {
  const has = (name: string) => files.some((f) => f === name || f.endsWith('/' + name));
  if (has('package.json')) return 'npm test';
  if (has('pyproject.toml') || has('requirements.txt')) return 'python -m pytest -q';
  if (has('Cargo.toml')) return 'cargo test';
  if (has('go.mod')) return 'go test ./...';
  return null;
}

/** Folder name for an idea: filesystem-safe, readable, never empty. */
export function slugify(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9一-龥]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 40);
  return slug || 'project';
}

/** First free name in `taken`: foo, foo-2, foo-3… */
export function uniqueFolderName(base: string, taken: (name: string) => boolean): string {
  if (!taken(base)) return base;
  for (let i = 2; i < 1000; i++) {
    const candidate = `${base}-${i}`;
    if (!taken(candidate)) return candidate;
  }
  return `${base}-${Date.now()}`;
}

export function parseIdeas(raw: string, makeId: () => string): ProjectIdea[] {
  if (!raw) return [];
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (fence) text = fence[1].trim();

  const start = text.indexOf('{');
  if (start === -1) return [];

  let parsed: any = null;
  for (let end = text.lastIndexOf('}'); end > start; end = text.lastIndexOf('}', end - 1)) {
    try {
      parsed = JSON.parse(text.slice(start, end + 1));
      break;
    } catch {}
  }
  const list = Array.isArray(parsed?.ideas) ? parsed.ideas : null;
  if (!list) return [];

  const out: ProjectIdea[] = [];
  for (const raw of list) {
    const title = typeof raw?.title === 'string' ? raw.title.trim() : '';
    const description = typeof raw?.description === 'string' ? raw.description.trim() : '';
    if (!title || !description) continue;
    if (out.some((i) => i.title.toLowerCase() === title.toLowerCase())) continue;
    out.push({
      id: makeId(),
      title: title.slice(0, 60),
      description: description.slice(0, 200),
      stack: typeof raw.stack === 'string' ? raw.stack.trim().slice(0, 60) : '',
      tags: Array.isArray(raw.tags)
        ? raw.tags.filter((t: any) => typeof t === 'string' && t.trim()).slice(0, 3)
        : [],
      scale: raw.scale === 'medium' ? 'medium' : 'small',
    });
    if (out.length >= 6) break;
  }
  return out;
}
