import { cp, mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { packageRoot, sourceManifest } from './source-manifest.mjs';

const source = await sourceManifest();
const dir = await mkdtemp(join(tmpdir(), 'cua-clean-install-'));
const outputDir = join(packageRoot, 'artifacts', 'clean-install');
await mkdir(outputDir, { recursive: true });
const report = { sourceHash: source.sourceHash, startedAt: new Date().toISOString(), environment: { node: process.version, platform: process.platform, arch: process.arch }, checks: [] };
try {
  for (const name of ['src', 'test', 'scripts', 'native', 'deploy', 'console', 'package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts']) {
    await cp(join(packageRoot, name), join(dir, name), { recursive: true, filter: (path) => !/\/(?:node_modules|dist|bin)(?:\/|$)/.test(path) });
  }
  // A new installation directory; cached public npm tarballs and the installed
  // Chromium cache are reused. This is not a new-machine/OS installation.
  for (const [name, command, args] of [
    ['install', 'npm', ['ci', '--offline', '--no-audit']],
    ['build', 'npm', ['run', 'build']],
    ['browser-demo', process.execPath, ['dist/cli.js', 'demo', 'browser']],
  ]) {
    console.log(`CLEAN ${name}`);
    let output = '';
    const exitCode = await new Promise((resolve) => {
      const child = spawn(command, args, { cwd: dir, env: { ...process.env, CUA_DATA_DIR: join(dir, '.cua') }, stdio: ['ignore', 'pipe', 'pipe'] });
      for (const stream of [child.stdout, child.stderr]) stream.on('data', (chunk) => { output += chunk; process.stdout.write(chunk); });
      child.once('error', (error) => { output += String(error); resolve(1); });
      child.once('close', (code) => resolve(code ?? 1));
    });
    await writeFile(join(outputDir, `${name}.log`), output, { mode: 0o600 });
    report.checks.push({ name, exitCode });
    if (exitCode !== 0) throw new Error(`Clean installation check failed: ${name}`);
  }
  report.passed = true;
} catch (error) {
  report.passed = false;
  report.error = String(error);
  process.exitCode = 1;
} finally {
  await rm(dir, { recursive: true, force: true });
  report.finishedAt = new Date().toISOString();
  report.sourceUnchanged = source.sourceHash === (await sourceManifest()).sourceHash;
  if (!report.sourceUnchanged) { report.passed = false; process.exitCode = 1; }
  await writeFile(join(outputDir, 'report.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}
