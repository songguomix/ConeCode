import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, resolve, sep, dirname, basename, join } from 'node:path';
import { realpathSync } from 'node:fs';
import { newId } from '../protocol/ids.js';
import { CuaError } from '../protocol/errors.js';
import type { Driver } from '../drivers/types.js';
import {
  nowIso,
  type Condition,
  type EvidenceRef,
  type Task,
  type Verdict,
  type VerificationResult,
} from '../protocol/schemas.js';

export interface VerifyOptions {
  task: Task;
  criteria: Condition[];
  scope: 'action' | 'task' | 'recovery';
  actionId?: string;
  driver?: Driver;
  /** Overall wait budget for conditions that have not passed yet. */
  waitMs?: number;
  /** Used to authorize file reads. Defaults to the task's authorization scope. */
  fileRoots?: string[];
}

interface CriterionOutcome {
  verdict: Verdict;
  detail: string;
  evidence: EvidenceRef[];
}

/**
 * Verifies both action-level postconditions and final acceptance. The model's
 * finish call is only a proposal: this class reads the actual page/file/API.
 *
 * UNKNOWN and INSUFFICIENT_EVIDENCE are deliberately distinct from FAIL. A
 * failed check is evidence the condition is false; an unknown check means we
 * could not observe it, and must not be treated as success.
 */
export class Verifier {
  async verify(options: VerifyOptions): Promise<VerificationResult> {
    const waitMs = options.waitMs ?? 0;
    const deadline = Date.now() + waitMs;
    let outcomes: CriterionOutcome[] = [];
    let attempts = 0;
    do {
      attempts += 1;
      outcomes = [];
      for (const criterion of options.criteria) {
        outcomes.push(await this.check(criterion, options));
      }
      const hasTransientFailure = outcomes.some((o) => o.verdict === 'fail' || o.verdict === 'unknown');
      if (!hasTransientFailure || Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, Math.min(250, Math.max(50, deadline - Date.now()))));
    } while (Date.now() < deadline);

    const verdict = aggregate(outcomes.map((o) => o.verdict));
    const missing = outcomes
      .filter((o) => o.verdict === 'insufficient_evidence' || o.verdict === 'unknown')
      .map((o) => o.detail);
    return {
      schemaVersion: 1,
      id: newId('ver'),
      taskId: options.task.id,
      actionId: options.actionId,
      scope: options.scope,
      criteria: options.criteria,
      verdict,
      evidence: uniqueEvidence(outcomes.flatMap((o) => o.evidence)),
      missing,
      details: options.criteria.map((criterion, i) => ({
        criterion,
        verdict: outcomes[i]!.verdict,
        detail: outcomes[i]!.detail,
      })),
      verifier: 'programmatic',
      at: nowIso(),
    };
  }

  private async check(criterion: Condition, options: VerifyOptions): Promise<CriterionOutcome> {
    switch (criterion.kind) {
      case 'custom':
        return {
          verdict: 'insufficient_evidence',
          detail: `No programmatic verifier is defined for custom criterion: ${criterion.description}`,
          evidence: [],
        };
      case 'record_field':
        return this.checkRecord(criterion, options);
      case 'file_content':
      case 'file_exists':
        return this.checkFile(criterion, options);
      case 'http_status':
        return this.checkHttpStatus(criterion, options);
      default: {
        if (!options.driver) {
          return {
            verdict: 'insufficient_evidence',
            detail: `Condition "${criterion.kind}" needs a live driver but none is available.`,
            evidence: [],
          };
        }
        try {
          const probe = await options.driver.probe(criterion, (criterion as { withinMs?: number }).withinMs ?? 0);
          return {
            verdict: probe.verdict,
            detail: probe.detail,
            evidence: probe.evidence ?? [],
          };
        } catch (error) {
          return {
            verdict: 'unknown',
            detail: `Probe failed: ${error instanceof Error ? error.message : String(error)}`,
            evidence: [],
          };
        }
      }
    }
  }

  private async checkRecord(
    criterion: Extract<Condition, { kind: 'record_field' }>,
    options: VerifyOptions,
  ): Promise<CriterionOutcome> {
    if ((criterion.method ?? 'GET') !== 'GET') {
      return { verdict: 'insufficient_evidence', detail: 'Verification only permits read-only GET/HEAD requests; POST must use the executor.', evidence: [] };
    }
    const allowed = isUrlAllowed(criterion.url, options.task);
    if (!allowed) {
      return {
        verdict: 'insufficient_evidence',
        detail: `Refusing to read ${criterion.url}: it is outside the task's allowed origins.`,
        evidence: [],
      };
    }
    const deadline = Date.now() + (criterion.withinMs ?? 0);
    let lastDetail = '';
    let sawValidJson = false;
    do {
      try {
        const response = await fetch(criterion.url, {
          method: criterion.method,
          headers: criterion.headers,
          signal: AbortSignal.timeout(10_000),
          redirect: 'error',
        });
        const text = await response.text();
        if (!response.ok) {
          lastDetail = `HTTP ${response.status} from ${criterion.url}.`;
        } else {
          let body: unknown;
          try {
            body = JSON.parse(text);
            sawValidJson = true;
          } catch {
            lastDetail = `${criterion.url} did not return JSON.`;
            if (Date.now() >= deadline) break;
            await new Promise((r) => setTimeout(r, 200));
            continue;
          }
          const found = getPath(body, criterion.path);
          const equal = JSON.stringify(found) === JSON.stringify(criterion.equals);
          lastDetail = equal
            ? `Field ${criterion.path.join('.')} equals ${JSON.stringify(criterion.equals)}.`
            : `Field ${criterion.path.join('.')} is ${JSON.stringify(found)}, expected ${JSON.stringify(criterion.equals)}.`;
          if (equal) {
            return {
              verdict: 'pass',
              detail: lastDetail,
              evidence: [{ kind: 'http', ref: criterion.url, note: JSON.stringify({ path: criterion.path, value: found }) }],
            };
          }
        }
      } catch (error) {
        lastDetail = `Reading ${criterion.url} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 200));
    } while (Date.now() < deadline);
    return {
      verdict: sawValidJson ? 'fail' : 'unknown',
      detail: lastDetail,
      evidence: [{ kind: 'http', ref: criterion.url }],
    };
  }

  private async checkFile(
    criterion: Extract<Condition, { kind: 'file_content' } | { kind: 'file_exists' }>,
    options: VerifyOptions,
  ): Promise<CriterionOutcome> {
    let path: string;
    try {
      path = assertPathWithin(criterion.path, options.fileRoots ?? options.task.authorization.allowedFileRoots);
      if (options.task.authorization.expiresAt && Date.parse(options.task.authorization.expiresAt) <= Date.now()) {
        throw new CuaError('AUTHORIZATION_DENIED', 'Task authorization has expired.');
      }
    } catch (error) {
      return { verdict: 'insufficient_evidence', detail: String(error), evidence: [] };
    }
    const deadline = Date.now() + ((criterion as { withinMs?: number }).withinMs ?? 0);
    let lastDetail = '';
    do {
      try {
        const info = await stat(path);
        if (!info.isFile()) {
          lastDetail = `${path} is not a regular file.`;
        } else if (criterion.kind === 'file_exists') {
          return { verdict: 'pass', detail: `${path} exists.`, evidence: [{ kind: 'file', ref: path }] };
        } else {
          const content = await readFile(path, 'utf8');
          const pass =
            criterion.equals !== undefined
              ? content === criterion.equals
              : criterion.contains !== undefined
                ? content.includes(criterion.contains)
                : true;
          if (pass) {
            return {
              verdict: 'pass',
              detail: `File ${path} matched ${criterion.equals !== undefined ? 'exact content' : 'substring'}.`,
              evidence: [{ kind: 'file', ref: path }],
            };
          }
          lastDetail = `File ${path} did not match the expected content.`;
        }
      } catch (error) {
        lastDetail = `Reading ${path} failed: ${error instanceof Error ? error.message : String(error)}`;
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, 150));
    } while (Date.now() < deadline);
    return { verdict: 'fail', detail: lastDetail, evidence: [{ kind: 'file', ref: path }] };
  }

  private async checkHttpStatus(
    criterion: Extract<Condition, { kind: 'http_status' }>,
    options: VerifyOptions,
  ): Promise<CriterionOutcome> {
    if (!isUrlAllowed(criterion.url, options.task)) {
      return { verdict: 'insufficient_evidence', detail: `Refusing to read ${criterion.url}: outside the task's current allowed origins.`, evidence: [] };
    }
    if (!['GET', 'HEAD'].includes(criterion.method ?? 'GET') || criterion.body !== undefined) {
      return { verdict: 'insufficient_evidence', detail: 'Verification only permits read-only GET/HEAD requests without a body; writes must use the executor.', evidence: [] };
    }
    try {
      const response = await fetch(criterion.url, {
        method: criterion.method,
        headers: criterion.headers,
        body: criterion.body === undefined ? undefined : JSON.stringify(criterion.body),
        signal: AbortSignal.timeout(10_000),
        redirect: 'error',
      });
      const pass = response.status === criterion.status;
      return {
        verdict: pass ? 'pass' : 'fail',
        detail: `HTTP ${response.status} from ${criterion.url}; expected ${criterion.status}.`,
        evidence: [{ kind: 'http', ref: criterion.url, note: `status=${response.status}` }],
      };
    } catch (error) {
      return {
        verdict: 'unknown',
        detail: `HTTP check failed: ${error instanceof Error ? error.message : String(error)}`,
        evidence: [],
      };
    }
  }
}

function aggregate(verdicts: Verdict[]): Verdict {
  if (verdicts.length === 0) return 'insufficient_evidence';
  if (verdicts.some((v) => v === 'fail')) return 'fail';
  if (verdicts.some((v) => v === 'unknown')) return 'unknown';
  if (verdicts.some((v) => v === 'insufficient_evidence')) return 'insufficient_evidence';
  return 'pass';
}

function getPath(value: unknown, path: Array<string | number>): unknown {
  let cursor: any = value;
  for (const key of path) {
    if (cursor === null || cursor === undefined) return undefined;
    cursor = cursor[key as any];
  }
  return cursor;
}

function isUrlAllowed(url: string, task: Task): boolean {
  if (task.authorization.expiresAt && Date.parse(task.authorization.expiresAt) <= Date.now()) return false;
  const allowed = task.authorization.allowedOrigins;
  if (allowed.length === 0) return false;
  try {
    const target = new URL(url);
    return allowed.some((entry) => {
      if (entry === '*') return true;
      try {
        return new URL(entry).origin === target.origin;
      } catch {
        return entry === target.origin;
      }
    });
  } catch {
    return false;
  }
}

function uniqueEvidence(items: EvidenceRef[]): EvidenceRef[] {
  const seen = new Set<string>();
  return items.filter((e) => {
    const key = `${e.kind}:${e.ref}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Resolve symlinks (including existing parents of a new file) before checking scope.
 * This prevents lexical ../ and symlink escapes. GUI writes still cannot provide
 * a race-free openat boundary if another local process changes the filesystem.
 */
export function assertPathWithin(path: string, roots: string[]): string {
  if (!isAbsolute(path)) throw new CuaError('PROTOCOL_INVALID', 'File paths must be absolute.');
  if (roots.length === 0) throw new CuaError('AUTHORIZATION_DENIED', 'File access requires explicit allowedFileRoots.');
  const resolved = canonicalPath(path);
  if (!roots.some((root) => {
    if (!isAbsolute(root)) return false;
    const canonicalRoot = canonicalPath(root);
    return resolved === canonicalRoot || resolved.startsWith(canonicalRoot.endsWith(sep) ? canonicalRoot : canonicalRoot + sep);
  })) {
    throw new CuaError('AUTHORIZATION_DENIED', `Path ${resolved} is outside the authorized roots.`);
  }
  return resolved;
}

function canonicalPath(path: string): string {
  const suffix: string[] = [];
  let current = resolve(path);
  while (true) {
    try { return join(realpathSync(current), ...suffix); }
    catch (error) {
      if (!['ENOENT', 'ENOTDIR'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      const parent = dirname(current);
      if (parent === current) throw error;
      suffix.unshift(basename(current));
      current = parent;
    }
  }
}
