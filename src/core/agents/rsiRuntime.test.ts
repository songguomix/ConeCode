import { describe, expect, it } from 'vitest';
import { isVerificationCommand, RsiExecutionMonitor } from './rsiRuntime';

const capture = { action: 'auto_screenshot', succeeded: true };
function captureAndReview(monitor: RsiExecutionMonitor) {
  monitor.observe(capture);
  const ticket = monitor.screenshotReviewTicket();
  expect(ticket).not.toBeNull();
  monitor.confirmScreenshotReview(ticket!);
}

describe('RSI runtime evidence', () => {
  it('continues a premature summary only twice, then stops without claiming success', () => {
    const monitor = new RsiExecutionMonitor();
    expect([monitor.finish(), monitor.finish(), monitor.finish()]).toEqual(['recover', 'recover', 'stop']);
  });
  it('requires verification after the last edit, and ignores archive bookkeeping', () => {
    const monitor = new RsiExecutionMonitor();
    monitor.observe({ action: 'exec', command: 'npm test', succeeded: true });
    monitor.observe({ action: 'edit', path: '/p/src/a.ts', succeeded: true });
    expect(monitor.finish()).toBe('recover');
    monitor.observe({ action: 'exec', command: 'npm test', succeeded: true });
    monitor.observe({ action: 'create_file', path: '/p/.conecode/rsi/iterations/1.json', succeeded: true });
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });
  it('detects repeated failed commands and clears them only after changed code or success', () => {
    const monitor = new RsiExecutionMonitor();
    for (let i = 0; i < 3; i++) monitor.observe({ action: 'exec', command: 'npm test', succeeded: false, detail: 'assertion failed' });
    expect(monitor.repeatedFailure()).toBe(true);
    monitor.observe({ action: 'read_file', path: '/p/src/a.ts', succeeded: true });
    expect(monitor.repeatedFailure()).toBe(true);
    monitor.observe({ action: 'edit', path: '/p/src/a.ts', succeeded: true });
    expect(monitor.repeatedFailure()).toBe(false);
  });
  it('does not mistake an echo or a file read for verification', () => {
    expect(isVerificationCommand('echo npm test')).toBe(false);
    expect(isVerificationCommand('cat package.json')).toBe(false);
    expect(isVerificationCommand('cd web && npm run typecheck')).toBe(true);
    expect(isVerificationCommand('python -m pytest tests')).toBe(true);
  });

  it.each([
    'npm test || true',
    'npm test; echo done',
    'npm test | tee results.txt',
    'npm test\necho done',
    'npm test && sed -i s/old/new/ src/a.ts',
    "echo ' && npm test && echo '",
    'npx vitest --listTests',
    'python -m pytest --collect-only',
  ])('does not accept masked, quoted, or non-executing checks: %s', (command) => {
    expect(isVerificationCommand(command)).toBe(false);
    const monitor = new RsiExecutionMonitor();
    monitor.observe({ action: 'exec', command, succeeded: true });
    expect(monitor.finish()).toBe('recover');
  });

  it.each([true, false])('invalidates old verification after an unknown execution, even when success is %s', (succeeded) => {
    const monitor = new RsiExecutionMonitor();
    monitor.observe({ action: 'exec', command: 'npm test', succeeded: true });
    monitor.observe({ action: 'exec', command: 'node scripts/update.js', succeeded });
    expect(monitor.finish()).toBe('recover');
  });

  it('retains verification across read-only inspection and exit-preserving check chains', () => {
    const monitor = new RsiExecutionMonitor();
    monitor.observe({ action: 'exec', command: 'cd web && npm test && echo done', succeeded: true });
    monitor.observe({ action: 'exec', command: 'git diff && rg TODO src', succeeded: true });
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('does not treat ordinary inline paths as checks, and rejects masking even for declared commands', () => {
    for (const [goal, command] of [
      ['Inspect `src/check.ts` and `make quality`.', 'src/check.ts'],
      ['Inspect `src/check.ts` and `make quality`.', 'make quality'],
      ['Command: `src/check.ts`', 'src/check.ts'],
      ['Command: `make quality || true`', 'make quality || true'],
    ]) {
      const monitor = new RsiExecutionMonitor();
      monitor.setGoal(goal);
      monitor.observe({ action: 'exec', command, succeeded: true });
      expect(monitor.finish()).toBe('recover');
    }
    const monitor = new RsiExecutionMonitor();
    monitor.setGoal('Command: `cd web && make quality`');
    monitor.observe({ action: 'exec', command: 'cd web && make quality', succeeded: true });
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('requires each failed check to pass again, even after a repair and a different passing check', () => {
    const monitor = new RsiExecutionMonitor();
    monitor.observe({ action: 'exec', command: 'npm test', succeeded: false, detail: 'regression' });
    monitor.observe({ action: 'edit', path: '/p/src/a.ts', succeeded: true });
    monitor.observe({ action: 'exec', command: 'npm run typecheck', succeeded: true });
    expect(monitor.finish()).toBe('recover');
    expect(monitor.context()).toContain('["npm test","regression"]');
    monitor.observe({ action: 'exec', command: 'npm test', succeeded: true });
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('invalidates verification for partially failed edits and archive paths escaping to product files', () => {
    for (const evidence of [
      { action: 'edit', path: '/p/src/a.ts', succeeded: false },
      { action: 'edit', path: '/p/.conecode/rsi/../../src/a.ts', succeeded: true },
    ]) {
      const monitor = new RsiExecutionMonitor();
      monitor.observe({ action: 'exec', command: 'npm test', succeeded: true });
      monitor.observe(evidence);
      expect(monitor.finish()).toBe('recover');
    }
  });

  const frozen = 'Command: `npm test`\nCommand: `npm run typecheck`';
  const exec = (command: string, cwd = '/p', succeeded = true) => ({ action: 'exec', command, cwd, succeeded });

  it('requests the official plugin once after the checks pass and requires its image to finish', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal('Command: `npm test`\nCommand: `auto_screenshot`');
    monitor.observe(capture);
    expect(monitor.takeFinalScreenshotRequest()).toBe(false);
    monitor.observe(exec('npm test'));
    monitor.observe({ action: 'page_snapshot', succeeded: true });
    expect(monitor.finish()).toBe('recover');
    expect(monitor.nextVerificationHint()).toContain('auto_screenshot');
    expect(monitor.takeFinalScreenshotRequest()).toBe(true);
    expect(monitor.takeFinalScreenshotRequest()).toBe(false);
    monitor.observe(capture);
    expect(monitor.takeFinalScreenshotRequest()).toBe(false);
    expect(monitor.finish()).toBe('recover');
    monitor.confirmScreenshotReview(monitor.screenshotReviewTicket()!);
    expect(monitor.finish()).toBe('complete');
  });

  it('exposes plugin failure and only accepts a fresh successful capture', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.observe(exec('npm test'));
    monitor.observe({ action: 'auto_screenshot', succeeded: false, detail: 'Plugin disabled' });
    expect(monitor.takeFinalScreenshotRequest()).toBe(false);
    expect(monitor.nextVerificationHint()).toContain('Plugin disabled');
    expect([monitor.finish(), monitor.finish(), monitor.finish()]).toEqual(['recover', 'recover', 'stop']);
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('does not credit a review of an obsolete image that arrives after another edit and capture', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.observe(exec('npm test'));
    monitor.observe(capture);
    const old = monitor.screenshotReviewTicket()!;
    monitor.observe({ action: 'edit_file', path: '/p/src/main.ts', succeeded: true });
    expect(monitor.screenshotReviewTicket()).toBeNull();
    monitor.observe(exec('npm test'));
    monitor.observe(capture);
    const current = monitor.screenshotReviewTicket()!;
    expect(old).not.toBe(current);
    monitor.confirmScreenshotReview(old);
    expect(monitor.finish()).toBe('recover');
    monitor.confirmScreenshotReview(current);
    expect(monitor.finish()).toBe('complete');
  });

  it('requires a new screenshot after repairs or further verification and preserves it across archive writes', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.observe(exec('npm test'));
    captureAndReview(monitor);
    monitor.observe({ action: 'edit_file', path: '/p/.conecode/rsi/iterations/one.md', succeeded: true });
    expect(monitor.finish()).toBe('complete');
    monitor.observe({ action: 'edit_file', path: '/p/src/main.ts', succeeded: true });
    monitor.observe(capture);
    monitor.observe(exec('npm test'));
    expect(monitor.finish()).toBe('recover');
    monitor.observe(capture);
    monitor.observe(exec('npm run build'));
    expect(monitor.finish()).toBe('recover');
  });

  it('requires the complete frozen suite on the latest revision and keeps evidence across identical goal reads', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal(frozen);
    monitor.observe(exec('npm test && npm run typecheck'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
    monitor.observe({ action: 'edit', path: '/p/src/code.ts', succeeded: true });
    monitor.observe(exec('npm test'));
    monitor.setGoal(frozen);
    expect(monitor.finish()).toBe('recover');
    expect(monitor.nextVerificationHint()).toContain('npm run typecheck');
    expect(monitor.nextVerificationHint()).not.toContain('npm test');
    monitor.observe(exec('npm run typecheck'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('binds each required check to its arguments and working directory across compound calls', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal('Command: `cd web && make check`\nCommand: `npm test`');
    monitor.observe(exec('make check'));
    monitor.observe(exec('npm test', '/p/web'));
    monitor.observe(exec('npm test -- smoke'));
    expect(monitor.finish()).toBe('recover');
    monitor.observe(exec('make check', '/p/web'));
    expect(monitor.finish()).toBe('recover');
    monitor.observe(exec('npm test'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('keeps a declared chain together and gives a failed batch no partial credit', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal('Command: `npm test && npm run typecheck`');
    monitor.observe(exec('npm test && npm run typecheck', '/p', false));
    monitor.observe(exec('npm test'));
    expect(monitor.finish()).toBe('recover');
    monitor.observe(exec('npm test && npm run typecheck'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('cannot drop a frozen check by rewriting or losing the goal mid-run', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal(frozen);
    monitor.observe(exec('npm test'));
    monitor.setGoal('Command: `npm test`');
    expect(monitor.finish()).toBe('recover');
    monitor.setGoal(null);
    expect(monitor.finish()).toBe('recover');
    monitor.setGoal(frozen);
    monitor.observe(exec('npm test && npm run typecheck'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('accepts a frozen native check only through the tool verdict', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal('Command: `perf_snapshot`\nCommand: `npm test`');
    monitor.observe(exec('npm test'));
    monitor.observe(exec('perf_snapshot'));
    expect(monitor.finish()).toBe('recover');
    monitor.observe({ action: 'perf_snapshot', succeeded: false });
    expect(monitor.finish()).toBe('recover');
    monitor.observe({ action: 'perf_snapshot', succeeded: true });
    monitor.observe(exec('npm test'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('invalidates earlier checks when an archive file is restored into the product', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal(frozen);
    monitor.observe(exec('npm test && npm run typecheck'));
    monitor.observe({ action: 'copy', path: '/p/.conecode/rsi/pre-edit/code.ts', destPath: '/p/src/code.ts', succeeded: true });
    expect(monitor.finish()).toBe('recover');
  });

  it('reuses separately verified frozen checks after a failing ad hoc batch', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal(frozen);
    monitor.observe(exec('npm test && npm run typecheck', '/p', false));
    monitor.observe(exec('npm test'));
    expect(monitor.finish()).toBe('recover');
    monitor.observe(exec('npm run typecheck'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('clears a failed scoped check when it passes in the equivalent cwd', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal('Command: `cd web && npm test`');
    monitor.observe(exec('cd web && npm test', '/p', false));
    monitor.observe(exec('npm test', '/p/web', false));
    monitor.observe(exec('npm test', '/p/web'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('treats an optional host reading as advisory when the goal only freezes product checks', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal(frozen);
    monitor.observe({ action: 'perf_snapshot', succeeded: false, detail: 'load too high' });
    expect(monitor.finish()).toBe('recover');
    monitor.observe(exec('npm test && npm run typecheck'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('uses an unchanged diagnostic to switch hypotheses and gives new diagnostics a fresh attempt', () => {
    const monitor = new RsiExecutionMonitor('/p');
    const fail = (detail: string) => monitor.observe({ ...exec('npm test', '/p', false), detail });
    const repair = () => monitor.observe({ action: 'edit', path: '/p/service.ts', succeeded: true });
    fail('expected two items');
    for (let i = 0; i < 2; i++) { repair(); fail('expected two items'); }
    expect(monitor.nextVerificationHint()).toContain('different causal hypothesis');
    expect(monitor.failureStopReason()).toBeNull();
    repair();
    fail('expected three items');
    expect(monitor.failureStopReason()).toBeNull();
    expect(monitor.nextVerificationHint()).not.toContain('different causal hypothesis');
    monitor.observe(exec('npm test'));
    captureAndReview(monitor);
    expect(monitor.finish()).toBe('complete');
  });

  it('invalidates earlier passes after downloading a product file or running an auto-fix', () => {
    for (const mutation of [
      { action: 'download', path: '/p/fixture.json', succeeded: true },
      exec('npx eslint --fix src'),
    ]) {
      const monitor = new RsiExecutionMonitor('/p');
      monitor.setGoal(frozen);
      monitor.observe(exec('npm test && npm run typecheck'));
      monitor.observe(mutation);
      expect(monitor.finish()).toBe('recover');
    }
  });

  it('keeps incomplete declarations visible when a different check passes', () => {
    const monitor = new RsiExecutionMonitor('/p');
    monitor.setGoal('## Frozen metrics\n| id | Command | Direction |\n| latency | unspecified | lower |');
    monitor.observe(exec('npm test'));
    expect(monitor.finish()).toBe('recover');
    expect(monitor.nextVerificationHint()).toMatch(/blocked.*latency/);
  });
});
