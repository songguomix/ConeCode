import path from 'path';
import fs from 'fs';

// Shared logic for the live preview: how to run a project, how to read a dev
// server's output, and how to serve a static folder safely. Kept out of
// electron/preview/devserver.ts (which owns the processes and sockets) so the
// rules are testable on their own — same split as core/exec/sandbox.ts.

export type PreviewMode = 'script' | 'static' | 'command';
export type PreviewState = 'idle' | 'starting' | 'running' | 'error';
export type PackageManager = 'npm' | 'pnpm' | 'yarn' | 'bun';

export interface PreviewPlan {
  mode: PreviewMode;
  /** The shell command we'd run, already formatted for display ("npm run dev"). */
  command: string | null;
  cwd: string;
  /** Directory served in static mode (absolute). */
  staticDir?: string | null;
  /** Entry file we found in static mode, relative to staticDir. */
  staticEntry?: string | null;
  packageManager?: PackageManager;
  script?: string | null;
  /** Framework guess, purely for the UI label ("Vite", "Next.js"…). */
  framework?: string | null;
}

export interface PreviewStatus {
  state: PreviewState;
  url: string | null;
  plan: PreviewPlan | null;
  error: string | null;
  pid: number | null;
}

export interface PreviewLog {
  stream: 'stdout' | 'stderr' | 'system';
  data: string;
}

/** Scripts we'd run, best first. `dev` beats `start` beats a preview/serve script. */
export const SCRIPT_PRIORITY = ['dev', 'start', 'serve', 'preview', 'dev:web', 'storybook'];

/** Where a plain-HTML project usually keeps its entry point, best first. */
export const STATIC_DIRS = ['', 'public', 'dist', 'build', 'src', 'site', 'www', 'docs'];

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
  '.wasm': 'application/wasm',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/plain; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

export function contentTypeFor(file: string): string {
  return MIME[path.extname(file).toLowerCase()] || 'application/octet-stream';
}

// Dev servers colour their output; the escape codes would break URL matching.
const ANSI = /\x1b\[[0-9;?]*[a-zA-Z]/g;
export const stripAnsi = (s: string) => s.replace(ANSI, '');

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\])(?::\d{2,5})?(?:\/[^\s"'<>)\]]*)?/gi;
// Fallback for servers that only announce a bare port ("listening on port 3000").
const PORT_RE = /(?:listening|running|started|server|ready|port)\D{0,16}?(\d{4,5})\b/i;

/**
 * Pull the address a dev server just announced out of a chunk of its output.
 * Returns null when the chunk says nothing about where it's listening.
 */
export function extractUrl(chunk: string): string | null {
  const text = stripAnsi(chunk);
  const matches = text.match(URL_RE);

  if (matches && matches.length > 0) {
    // Prefer a "localhost" line over a network/0.0.0.0 one — it's the address
    // that always works from inside the app.
    const raw = matches.find((m) => /localhost/i.test(m)) || matches[0];
    return raw
      .replace('0.0.0.0', 'localhost')
      .replace('127.0.0.1', 'localhost')
      .replace('[::1]', 'localhost')
      .replace(/[.,;)\]]+$/, '');
  }

  const port = text.match(PORT_RE)?.[1];
  return port ? `http://localhost:${port}` : null;
}

/**
 * Map a request path onto a file inside `root`. A generated page must not be
 * able to walk the rest of the disk with "../": posix normalisation clamps a
 * climb above the root back into it, and the containment check below is the
 * backstop for separators normalisation leaves alone (a "..\" on Windows).
 * Returns null when the result would still land outside.
 */
export function resolveStaticPath(root: string, pathname: string): string | null {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, '.' + path.posix.normalize(pathname.startsWith('/') ? pathname : '/' + pathname));
  const rootWithSep = resolvedRoot.endsWith(path.sep) ? resolvedRoot : resolvedRoot + path.sep;
  if (resolved !== resolvedRoot && !resolved.startsWith(rootWithSep)) return null;
  return resolved;
}

export function detectPackageManager(cwd: string): PackageManager {
  if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return 'pnpm';
  if (fs.existsSync(path.join(cwd, 'bun.lockb')) || fs.existsSync(path.join(cwd, 'bun.lock'))) return 'bun';
  if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

export function runScriptCommand(pm: PackageManager, script: string): string {
  // yarn takes the script name directly; the others need the `run` verb.
  return pm === 'yarn' ? `yarn ${script}` : `${pm} run ${script}`;
}

export function detectFramework(pkg: any): string | null {
  const deps = { ...(pkg?.dependencies || {}), ...(pkg?.devDependencies || {}) };
  const has = (name: string) => Object.prototype.hasOwnProperty.call(deps, name);
  if (has('next')) return 'Next.js';
  if (has('nuxt')) return 'Nuxt';
  if (has('@remix-run/dev')) return 'Remix';
  if (has('astro')) return 'Astro';
  if (has('@sveltejs/kit')) return 'SvelteKit';
  if (has('vite')) return 'Vite';
  if (has('react-scripts')) return 'Create React App';
  if (has('@angular/cli')) return 'Angular';
  if (has('vue-cli-service')) return 'Vue CLI';
  if (has('express') || has('fastify') || has('koa')) return 'Node server';
  return null;
}

function readJson(file: string): any | null {
  try { return JSON.parse(fs.readFileSync(file, 'utf-8')); } catch { return null; }
}

/**
 * Work out how to preview the project at `cwd` without starting anything.
 * Returns null when there's nothing previewable (no dev script, no HTML).
 */
export function detectPreview(cwd: string): PreviewPlan | null {
  if (!cwd || !fs.existsSync(cwd)) return null;

  const pkg = readJson(path.join(cwd, 'package.json'));
  const scripts: Record<string, string> = pkg?.scripts || {};
  const script = SCRIPT_PRIORITY.find((name) => typeof scripts[name] === 'string');
  if (script) {
    const packageManager = detectPackageManager(cwd);
    return {
      mode: 'script',
      command: runScriptCommand(packageManager, script),
      cwd,
      packageManager,
      script,
      framework: detectFramework(pkg),
    };
  }

  for (const dir of STATIC_DIRS) {
    const abs = path.join(cwd, dir);
    if (fs.existsSync(path.join(abs, 'index.html'))) {
      return { mode: 'static', command: null, cwd, staticDir: abs, staticEntry: 'index.html', framework: 'HTML' };
    }
  }

  // No index.html anywhere obvious — fall back to any HTML file at the root.
  try {
    const html = fs.readdirSync(cwd).filter((f) => f.toLowerCase().endsWith('.html')).sort();
    if (html.length > 0) {
      return { mode: 'static', command: null, cwd, staticDir: cwd, staticEntry: html[0], framework: 'HTML' };
    }
  } catch {}

  return null;
}
