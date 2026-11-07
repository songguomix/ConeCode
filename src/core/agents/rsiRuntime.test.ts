import { describe, expect, it } from 'vitest';
import { isVerificationCommand, RsiExecutionMonitor } from './rsiRuntime';

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
});
