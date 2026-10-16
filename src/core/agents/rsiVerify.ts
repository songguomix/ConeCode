// RSI external verification — program-run cascade, not prompt prose.
//
// Pass/fail comes from REAL command exit codes, run in order with early exit
// (cheapest first). Numeric metric values come from best-effort output parsers;
// anything unparseable is reported missing — never fabricated as zero.
// The command runner is injected: production passes the Electron exec bridge
// (same IPC + sandbox as the agent's own exec tool), tests pass fakes.

export interface CommandResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export type CommandRunner = (command: string, cwd: string) => Promise<CommandResult>;

export interface CascadeStage {
  id: string;
  command: string;
}

export interface StageResult extends CascadeStage {
  exitCode: number;
  stdout: string;
  stderr: string;
  passed: boolean;
  /** True when the runner itself threw (infra failure, not product signal). */
  runnerError?: string;
}

export interface CascadeOutcome {
  stages: StageResult[];
  passedAll: boolean;
  stoppedAt: string | null;
  /** Stages actually executed (early exit visible as savings). */
  costSteps: number;
}

/**
 * Run stages in order, stopping at the first failure. A throwing runner is
 * recorded as a failed stage (unverified), never as a pass.
 */
export async function runVerifyCascade(
  runner: CommandRunner,
  cwd: string,
  stages: CascadeStage[],
): Promise<CascadeOutcome> {
  const results: StageResult[] = [];
  for (const s of stages) {
    let r: CommandResult;
    try {
      r = await runner(s.command, cwd);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      results.push({ ...s, exitCode: 127, stdout: '', stderr: msg, passed: false, runnerError: msg });
      break;
    }
    const passed = r.exitCode === 0;
    results.push({ ...s, exitCode: r.exitCode, stdout: r.stdout ?? '', stderr: r.stderr ?? '', passed });
    if (!passed) break;
  }
  const passedAll = results.length > 0 && results.every((s) => s.passed) && results.length === stages.length;
  return {
    stages: results,
    passedAll,
    stoppedAt: results.length < stages.length ? (results[results.length - 1]?.id ?? null) : passedAll ? null : (results[results.length - 1]?.id ?? null),
    costSteps: results.length,
  };
}

// ---------------------------------------------------------------------------
// Output parsers — best-effort numbers from tool output.
// ---------------------------------------------------------------------------

export interface VitestSummary {
  passed: number;
  failed: number;
  skipped: number;
}

/** Parse the trailing "Tests  X failed | Y passed | Z skipped (N)" line. Null when absent. */
export function parseVitestSummary(output: string): VitestSummary | null {
  const lines = output.split('\n').filter((l) => /^\s*Tests\s+/.test(l));
  if (!lines.length) return null;
  const last = lines[lines.length - 1];
  const num = (re: RegExp): number => {
    const m = re.exec(last);
    return m ? parseInt(m[1], 10) : 0;
  };
  return { failed: num(/(\d+)\s+failed/), passed: num(/(\d+)\s+passed/), skipped: num(/(\d+)\s+skipped/) };
}

/** Count "error TSNNNN" lines. Empty output (clean tsc run) → 0 errors. */
export function parseTscOutput(output: string): { errors: number } {
  const m = output.match(/error TS\d+/g);
  return { errors: m ? m.length : 0 };
}

// ---------------------------------------------------------------------------
// Metric deltas — signed improvement in higher-is-better convention.
// ---------------------------------------------------------------------------

export type MetricDirection = 'higher' | 'lower';

/** Positive = better. Lower-direction metrics invert (baseline − current). */
export function signedDelta(direction: MetricDirection, baseline: number, current: number): number {
  return direction === 'higher' ? current - baseline : baseline - current;
}

export interface MetricBinding {
  id: string;
  direction: MetricDirection;
  scale?: number;
  minDelta?: number;
  /** Substring matched against the stage command to find its output. */
  commandIncludes: string;
  /** Current ABSOLUTE value from the matched stage; null when unparseable. */
  extract(stage: StageResult): number | null;
}

export interface MetricDeltaOut {
  id: string;
  delta: number;
  scale?: number;
  minDelta?: number;
}

/**
 * Build signed deltas for bindings with BOTH a numeric baseline and a
 * parseable current value. Anything else lands in `missing` — the caller must
 * surface it in diagnostics, never silently zero it.
 */
export function buildMetricDeltas(
  bindings: MetricBinding[],
  baseline: Record<string, number>,
  stages: StageResult[],
): { deltas: MetricDeltaOut[]; missing: string[] } {
  const deltas: MetricDeltaOut[] = [];
  const missing: string[] = [];
  for (const b of bindings) {
    const stage = stages.find((s) => s.command.includes(b.commandIncludes));
    const base = baseline[b.id];
    if (typeof base !== 'number' || !Number.isFinite(base)) {
      missing.push(`${b.id}: no numeric baseline`);
      continue;
    }
    if (!stage) {
      missing.push(`${b.id}: no stage ran for "${b.commandIncludes}"`);
      continue;
    }
    const current = b.extract(stage);
    if (current == null || !Number.isFinite(current)) {
      missing.push(`${b.id}: unparseable output in stage ${stage.id}`);
      continue;
    }
    const d: MetricDeltaOut = { id: b.id, delta: signedDelta(b.direction, base, current) };
    if (b.scale != null) d.scale = b.scale;
    if (b.minDelta != null) d.minDelta = b.minDelta;
    deltas.push(d);
  }
  return { deltas, missing };
}

/** Stock bindings for the ConeCode frozen metrics (commands matched by substring). */
export function defaultMetricBindings(): MetricBinding[] {
  return [
    {
      id: 'typecheck.errors', direction: 'lower', scale: 1, minDelta: 0,
      commandIncludes: 'typecheck',
      extract: (s) => parseTscOutput(`${s.stdout}\n${s.stderr}`).errors,
    },
    {
      id: 'test.failures', direction: 'lower', scale: 1, minDelta: 0,
      commandIncludes: 'npm test',
      extract: (s) => parseVitestSummary(`${s.stdout}\n${s.stderr}`)?.failed ?? null,
    },
    {
      id: 'build.exit', direction: 'lower', scale: 1,
      commandIncludes: 'npm run build',
      extract: (s) => s.exitCode,
    },
  ];
}

// ---------------------------------------------------------------------------
// Goal-vector table parser — reads the frozen .conecode/rsi/GOAL_VECTOR.md.
// ---------------------------------------------------------------------------

export interface ParsedGoalMetric {
  id: string;
  command: string;
  direction: MetricDirection;
  baselineNote: string;
}

export interface ParsedGoalVector {
  charter: string;
  frozenAt: string;
  metrics: ParsedGoalMetric[];
  nonGoals: string;
  warnings: string[];
}

function section(md: string, heading: string): string {
  const re = new RegExp(`^##\\s+${heading}\\s*$`, 'm');
  const m = re.exec(md);
  if (!m) return '';
  const rest = md.slice(m.index + m[0].length);
  const next = /^##\s+\S/m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest).trim();
}

/** Parse the frozen-metrics markdown table. Unknown rows → warnings, never guesses. */
export function parseGoalVector(md: string): ParsedGoalVector {
  const warnings: string[] = [];
  const frozenAt = /Frozen\s+(\S+)/.exec(md)?.[1] ?? '';
  const charter = section(md, 'Charter');
  const nonGoals = section(md, 'Non-goals');
  const tableSection = section(md, 'Frozen metrics');
  const metrics: ParsedGoalMetric[] = [];
  for (const line of tableSection.split('\n')) {
    const cells = line.split('|').map((c) => c.trim());
    // Leading/trailing pipes produce empty edge cells: | id | cmd | dir | base |
    if (cells.length < 6 || cells[1] === '' || /^id$/i.test(cells[1]) || /^-+$/.test(cells[1])) continue;
    const [, id, cmdCell, dirCell, baseCell] = cells;
    const command = /`([^`]+)`/.exec(cmdCell)?.[1]?.trim() ?? '';
    const dir = dirCell.toLowerCase();
    const direction: MetricDirection | null = dir === 'lower' ? 'lower' : dir === 'higher' ? 'higher' : null;
    if (!command) {
      warnings.push(`metric "${id}": no backticked command, skipped`);
      continue;
    }
    if (!direction) {
      warnings.push(`metric "${id}": unknown direction "${dirCell}", skipped`);
      continue;
    }
    metrics.push({ id, command, direction, baselineNote: baseCell ?? '' });
  }
  return { charter, frozenAt, metrics, nonGoals, warnings };
}
