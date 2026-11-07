import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

const pairs = [
  ['src/drivers/browser/snapshot-injected.js', 'dist/drivers/browser/snapshot-injected.js'],
  ['src/runtime/code-child.mjs', 'dist/runtime/code-child.mjs'],
];
for (const [from, to] of pairs) {
  await mkdir(dirname(to), { recursive: true });
  await copyFile(from, to);
}
console.log('Copied runtime assets to dist/');
