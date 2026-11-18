import { describe, expect, it } from 'vitest';
import {
  buildMetricDeltas, defaultMetricBindings, parseGoalChecks, parseGoalVector, parseTscOutput,
  parseVitestSummary, runVerifyCascade, signedDelta,
  type CommandResult,
} from './rsiVerify';

const VITEST_FAIL = [
  ' RUN  v4.1.11 /ws',
  ' Test Files  1 failed | 74 passed (75)',
  '      Tests  1 failed | 922 passed | 20 skipped (943)',
  '   Start at  16:12:08',
].join('\n');

const VITEST_PASS = [
  ' RUN  v4.1.11 /ws',
  ' Test Files  75 passed (75)',
  '      Tests  943 passed (943)',
].join('\n');

const TSC_ERRORS = [
  'src/a.ts(1,5): error TS2322: Type X is not assignable.',
  'src/b.ts(9,2): error TS2304: Cannot find name.',
].join('\n');

function runnerFor(results: CommandResult[], seen: string[] = []): (cmd: string, cwd: string) => Promise<CommandResult> {
  let i = 0;
  return async (cmd: string, _cwd: string) => {
    seen.push(cmd);
    const r = results[Math.min(i++, results.length - 1)];
    return { ...r };
  };
}

const ok = (stdout = ''): CommandResult => ({ stdout, stderr: '', exitCode: 0 });
const fail = (stdout = ''): CommandResult => ({ stdout, stderr: 'boom', exitCode: 1 });

describe('runVerifyCascade', () => {
  it('runs cheapest-first and stops at the first failure', async () => {
    const seen: string[] = [];
    const out = await runVerifyCascade(
      runnerFor([ok('t'), fail('x'), ok('y')], seen), '/ws',
      [{ id: 'compile', command: 'npm run typecheck' }, { id: 'full', command: 'npm test' }, { id: 'build', command: 'npm run build' }],
    );
    expect(out.passedAll).toBe(false);
    expect(out.stoppedAt).toBe('full');
    expect(out.costSteps).toBe(2);
    expect(seen).toEqual(['npm run typecheck', 'npm test']); // build never ran
  });

  it('passes only when every stage ran green', async () => {
    const out = await runVerifyCascade(runnerFor([ok('a'), ok('b')]), '/ws', [
      { id: 'a', command: 'cmd-a' }, { id: 'b', command: 'cmd-b' },
    ]);
    expect(out.passedAll).toBe(true);
    expect(out.stoppedAt).toBeNull();
  });

  it('treats a throwing runner as failure, never a pass', async () => {
    const out = await runVerifyCascade(async () => { throw new Error('ipc gone'); }, '/ws', [
      { id: 'a', command: 'cmd-a' },
    ]);
    expect(out.passedAll).toBe(false);
    expect(out.stages[0].runnerError).toMatch(/ipc gone/);
  });

  it('empty stages verify nothing (passedAll false)', async () => {
    const out = await runVerifyCascade(runnerFor([ok()]), '/ws', []);
    expect(out.passedAll).toBe(false);
  });
});

describe('output parsers', () => {
  it('parses vitest summaries (failed/passed/skipped)', () => {
    expect(parseVitestSummary(VITEST_FAIL)).toEqual({ passed: 922, failed: 1, skipped: 20 });
    expect(parseVitestSummary(VITEST_PASS)).toEqual({ passed: 943, failed: 0, skipped: 0 });
    expect(parseVitestSummary('no tests here')).toBeNull();
  });

  it('counts tsc errors; clean output is zero', () => {
    expect(parseTscOutput(TSC_ERRORS)).toEqual({ errors: 2 });
    expect(parseTscOutput('')).toEqual({ errors: 0 });
  });
});

describe('metric deltas', () => {
  it('signs improvement by direction', () => {
    expect(signedDelta('lower', 1, 0)).toBe(1); // one fewer failure = better
    expect(signedDelta('lower', 0, 2)).toBe(-2);
    expect(signedDelta('higher', 0.5, 0.9)).toBeCloseTo(0.4, 10);
  });

  it('builds deltas only for parsed metrics, reports the rest missing', () => {
    const stages = [
      { id: 'full', command: 'npm test', exitCode: 0, stdout: VITEST_PASS, stderr: '', passed: true },
    ];
    const { deltas, missing } = buildMetricDeltas(
      defaultMetricBindings(), { 'test.failures': 1 }, stages,
    );
    expect(deltas).toEqual([{ id: 'test.failures', delta: 1, scale: 1, minDelta: 0 }]);
    expect(missing.join(';')).toMatch(/typecheck.errors/);
    expect(missing.join(';')).toMatch(/build.exit/);
  });

  it('requires a numeric baseline (no silent zeros)', () => {
    const stages = [
      { id: 'full', command: 'npm test', exitCode: 0, stdout: VITEST_PASS, stderr: '', passed: true },
    ];
    const { deltas, missing } = buildMetricDeltas(defaultMetricBindings(), {}, stages);
    expect(deltas).toEqual([]);
    expect(missing.join(';')).toMatch(/no numeric baseline/);
  });

  it('default bindings extract tsc errors and build exit codes', () => {
    const bindings = defaultMetricBindings();
    const tsc = bindings.find((b) => b.id === 'typecheck.errors')!;
    expect(tsc.extract({ id: 'c', command: 'npm run typecheck', exitCode: 1, stdout: TSC_ERRORS, stderr: '', passed: false })).toBe(2);
    const build = bindings.find((b) => b.id === 'build.exit')!;
    expect(build.extract({ id: 'b', command: 'npm run build', exitCode: 0, stdout: '', stderr: '', passed: true })).toBe(0);
  });
});

describe('parseGoalVector', () => {
  const MD = [
    '# RSI goal vector', '',
    'Frozen 2026-10-16 before product episodes.', '',
    '## Charter', 'Improve reliability with small changes.', '',
    '## Frozen metrics',
    '| id | Exact measurement | Direction | Initial baseline |',
    '| --- | --- | --- | --- |',
    '| typecheck.errors | `npm run typecheck` | lower | 0, exit 0 |',
    '| test.failures | `npm test` | lower | 1 failed |',
    '| mystery | no command here | lower | ? |',
    '| vague | `npm run x` | sideways | ? |',
    '',
    '## Non-goals', 'No new scope.', '',
  ].join('\n');

  it('reads the frozen table, skips bad rows with warnings', () => {
    const g = parseGoalVector(MD);
    expect(g.frozenAt).toBe('2026-10-16');
    expect(g.charter).toMatch(/small changes/);
    expect(g.metrics.map((m) => m.id)).toEqual(['typecheck.errors', 'test.failures']);
    expect(g.metrics[0]).toMatchObject({ command: 'npm run typecheck', direction: 'lower' });
    expect(g.nonGoals).toMatch(/No new scope/);
    expect(g.warnings).toHaveLength(2);
  });
});

describe('parseGoalChecks', () => {
  it('keeps all commands from a numbered project goal, including non-numeric guards', () => {
    const goal = [
      '# GOAL VECTOR (frozen 2026-11-08)',
      '## 1. Charter goal', 'Fix plugin installation.',
      '## 2. Frozen metrics',
      '| id | command / fixture | direction | baseline | scale |',
      '|:---|---|---|---|---:|',
      '| M1 primary | `npx vitest run installer.test.ts` (passed-test count) | higher | 0 passed | tests |',
      '| M2 guard | `npm run typecheck` (exit code) | == 0 | 0 | binary |',
      '| M3 guard | `npm test` | lower | 3 failed | tests |',
      '| M4 guard | `perf_snapshot` (heap, RSS, verdict) | lower/none | no defect | MB |',
      '## 3. Non-goals / scope', 'Preserve the original dirty diff.',
      '| Other | `irrelevant command` | lower | 0 | n/a |',
    ].join('\r\n');
    expect(parseGoalChecks(goal)).toEqual({
      commands: ['npx vitest run installer.test.ts', 'npm run typecheck', 'npm test', 'perf_snapshot'],
      issues: [],
    });
    const numeric = parseGoalVector(goal);
    expect(numeric.metrics.map((m) => m.id)).toEqual(['M1 primary', 'M3 guard']);
    expect(numeric.warnings).toHaveLength(2);
    expect(numeric.charter).toBe('Fix plugin installation.');
    expect(numeric.nonGoals).toContain('Preserve the original dirty diff.');
    expect(numeric.frozenAt).toBe('2026-11-08');
  });

  it('keeps exact compound commands and deduplicates explicit multilingual labels', () => {
    const goal = [
      '## Frozen metrics',
      'id | Exact measurement | Direction | Initial baseline',
      '--- | --- | --- | ---',
      'quality | `cd web && npm test | tee checks` | lower | 1',
      '## Notes',
      'Verification command: `cd web && npm test | tee checks`',
      '- 验证命令：`./check "release build"`',
      '1. 驗證命令：`./check "release build"`',
      'Inspect `incidental.txt` as background.',
    ].join('\n');
    expect(parseGoalChecks(goal)).toEqual({
      commands: ['cd web && npm test | tee checks', './check "release build"'], issues: [],
    });
  });

  it('surfaces unreadable or ambiguous declarations alongside the usable commands', () => {
    const goal = [
      '## 冻结指标（2–5）',
      '| id | 命令 | 方向 | 基线 |',
      '|---|---|---|---|',
      '| compile | `npm run build` | lower | 0 |',
      '| tests | no runnable command | lower | 0 |',
      '| lint | `npm run lint` and `npm run lint:css` | lower | 0 |',
      '| check | `npm test` && run-other-check | lower | 0 |',
      '命令：',
    ].join('\n');
    const checks = parseGoalChecks(goal);
    expect(checks.commands).toEqual(['npm run build']);
    expect(checks.issues).toHaveLength(4);
    expect(parseGoalChecks('## Frozen metrics\nTo be written.').issues).toHaveLength(1);
    expect(parseGoalChecks('Inspect `npm test` and the docs.')).toEqual({ commands: [], issues: [] });
  });

  it('retains historical numeric readings from a command embedded in explanatory prose', () => {
    const goal = '## Frozen metrics\n| tests | Measure with `npm test`, see `out.log` | lower | 3 failures |';
    expect(parseGoalVector(goal).metrics).toEqual([
      { id: 'tests', command: 'npm test', direction: 'lower', baselineNote: '3 failures' },
    ]);
    expect(parseGoalChecks(goal).issues).toHaveLength(1);
  });
});
