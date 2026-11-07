import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { resolve, relative, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const packageRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));

/** Fingerprint implementation + tests + dependency lock, excluding outputs/secrets. */
export async function sourceManifest() {
  const files = [];
  async function visit(path) {
    for (const entry of await readdir(path, { withFileTypes: true })) {
      const item = join(path, entry.name);
      if (entry.isDirectory()) await visit(item);
      else if (entry.isFile()) files.push(item);
    }
  }
  for (const dir of ['src', 'test', 'scripts', 'native', 'deploy', 'console/src']) {
    await visit(join(packageRoot, dir));
  }
  // Native helper binaries are build outputs; source is the delivery input.
  const selected = files.filter((p) => !relative(packageRoot, p).startsWith('native/bin/'));
  for (const name of ['package.json', 'package-lock.json', 'tsconfig.json', 'vitest.config.ts', 'console/index.html', 'console/vite.config.ts']) {
    selected.push(join(packageRoot, name));
  }
  const entries = [];
  for (const path of selected.sort()) {
    entries.push({ path: relative(packageRoot, path), sha256: createHash('sha256').update(await readFile(path)).digest('hex') });
  }
  return { algorithm: 'sha256', sourceHash: createHash('sha256').update(JSON.stringify(entries)).digest('hex'), files: entries };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  console.log(JSON.stringify(await sourceManifest(), null, 2));
}
