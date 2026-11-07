import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The injected snapshot is plain JavaScript (see snapshot-injected.js) so the
 * source evaluated in the page never depends on bundler helpers. This wrapper
 * finds it in both source and compiled layouts, and lets tests assert that the
 * file exists and is parseable.
 */
export interface SnapshotArgs {
  refPrefix: string;
  maxTargets: number;
  maxText: number;
}

export interface FrameSnapshot {
  text: string;
  textTruncated: boolean;
  targets: Array<Record<string, unknown>>;
  targetsTruncated: boolean;
  hiddenTargets: number;
  offscreenTargets: number;
  shadowRoots: number;
  openDialogs: number;
  totalNodes: number;
}

let cached: string | undefined;

export function snapshotSource(): string {
  if (cached) return cached;
  const here = dirname(fileURLToPath(import.meta.url));
  const candidates = [
    join(here, 'snapshot-injected.js'),
    join(here, '..', '..', '..', '..', 'src', 'drivers', 'browser', 'snapshot-injected.js'),
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      cached = readFileSync(candidate, 'utf8');
      return cached;
    } catch (error) {
      lastError = error;
    }
  }
  throw new Error(`Could not load snapshot-injected.js: ${lastError instanceof Error ? lastError.message : String(lastError)}`);
}

/** Build the expression evaluated by Playwright in each frame. */
export function snapshotExpression(args: SnapshotArgs): string {
  return `(${snapshotSource()})(${JSON.stringify(args)})`;
}
