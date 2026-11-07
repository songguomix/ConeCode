import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { promisify } from 'node:util';
import { join } from 'node:path';

const exec = promisify(execFile);
if (process.platform !== 'darwin') {
  console.log('Native desktop helper is macOS-only; skipping swiftc on', process.platform);
  process.exit(0);
}
const outDir = join(process.cwd(), 'native', 'bin');
await mkdir(outDir, { recursive: true });
const out = join(outDir, 'desktop-agent');
console.log('Compiling native/desktop-agent.swift ->', out);
await exec('swiftc', ['-O', join(process.cwd(), 'native', 'desktop-agent.swift'), '-o', out], {
  timeout: 180_000,
  maxBuffer: 4 * 1024 * 1024,
});
console.log('Built', out);
