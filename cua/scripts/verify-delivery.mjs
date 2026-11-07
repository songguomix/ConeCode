import { spawn } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { sourceManifest, packageRoot } from './source-manifest.mjs';

// No provider call is part of this command. Desktop effects are opt-in.
const desktop = process.argv.includes('--desktop');
const outputDir = join(packageRoot, 'artifacts', 'delivery');
await mkdir(outputDir, { recursive: true });
const before = await sourceManifest();
const report = {
  startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch },
  source: before, checks: [], realModel: { status: 'not_run', reason: 'Explicit opt-in evaluation is separate.' },
  desktop: { status: desktop ? 'requested' : 'not_run', reason: desktop ? undefined : 'Use --desktop in an authorized macOS session.' },
};
const checks = [
  ['typecheck', 'npm', ['run', 'typecheck']],
  ...(desktop && process.platform === 'darwin' ? [['native', 'npm', ['run', 'build:native']]] : []),
  // API tests exercise the built React console, including its injected token.
  // Build first so a clean checkout never silently serves the fallback page.
  ['build', 'npm', ['run', 'build']],
  ['tests', 'npm', ['test', '--', '--reporter=default', '--reporter=json', `--outputFile=${join(outputDir, 'tests.json')}`]],
  ['evaluation', process.execPath, ['dist/cli.js', 'eval', '--json']],
  ['browser-demo', process.execPath, ['dist/cli.js', 'demo', 'browser']],
  ['console', 'npx', ['--no-install', 'tsx', 'scripts/verify-console.ts']],
  ['context', 'npx', ['--no-install', 'tsx', 'scripts/measure-context.ts']],
  ['context-comparison', 'npx', ['--no-install', 'tsx', 'scripts/compare-context.ts', '--repeats', '3', '--out', 'docs/evidence/2026-11-07-context-comparison.json']],
  ['controller-comparison', 'npx', ['--no-install', 'tsx', 'scripts/compare-controller.ts', '--out', 'docs/evidence/2026-11-07-controller-comparison.json']],
  ...(desktop ? [['desktop-tests', 'npx', ['--no-install', 'vitest', 'run', 'test/desktop.test.ts', '--reporter=default', '--reporter=json', `--outputFile=${join(outputDir, 'desktop-tests.json')}`]]] : []),
  ...(desktop ? [['desktop-demo', process.execPath, ['dist/cli.js', 'demo', 'desktop', '--yes']]] : []),
];
for (const [name, command, args] of checks) {
  const start = Date.now();
  console.log(`START ${name}`);
  let output = '';
  const code = await new Promise((done) => {
    const child = spawn(command, args, {
      // Native focus is shared OS state. Never run desktop effects concurrently
      // with browser/console tests; give the dedicated final check sole ownership.
      cwd: packageRoot, env: { ...process.env, CUA_RUN_REAL_MODEL: '0', CUA_RUN_DESKTOP: name === 'desktop-tests' ? '1' : '0' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
    child.on('error', (error) => { output += String(error); done(1); });
    child.on('close', (exitCode) => done(exitCode ?? 1));
  });
  await writeFile(join(outputDir, `${name}.log`), output, { mode: 0o600 });
  report.checks.push({ name, command: [command, ...args], exitCode: code, durationMs: Date.now() - start, log: `${name}.log` });
  await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2));
  if (code !== 0) { process.exitCode = 1; break; }
}
const after = await sourceManifest();
report.finishedAt = new Date().toISOString();
report.sourceUnchanged = before.sourceHash === after.sourceHash;
report.passed = report.sourceUnchanged && report.checks.length === checks.length && report.checks.every((c) => c.exitCode === 0);
if (desktop) report.desktop = { status: report.passed ? 'verified' : 'incomplete', reason: 'See individual native tests and desktop-demo logs; primary-display fixture scope only.' };
if (!report.passed) process.exitCode = 1;
await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
console.log(`DELIVERY ${report.passed ? 'PASS' : 'FAIL'} source=${before.sourceHash} unchanged=${report.sourceUnchanged}`);
console.log(`Report: ${join(outputDir, 'report.json')}`);
