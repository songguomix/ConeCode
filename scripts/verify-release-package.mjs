import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { copyFile, mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractFile, statFile } from '@electron/asar';
import { parse } from 'yaml';

const [platform, version, resources] = process.argv.slice(2);
const targets = {
  mac: ['latest-mac.yml', 'ConeCode-' + version + '-arm64.dmg', 'cloudflared-darwin-arm64'],
  win: ['latest.yml', 'ConeCode.Setup.' + version + '.exe', 'cloudflared-win-x64.exe'],
  linux: ['latest-linux.yml', 'ConeCode-' + version + '.AppImage', 'cloudflared-linux-x64'],
};
if (!Object.hasOwn(targets, platform) || !/^\d+\.\d+\.\d+$/.test(version || '') || !resources) {
  throw new Error('Usage: node scripts/verify-release-package.mjs <mac|win|linux> <version> <app resources>');
}
const [metadata, publicName, tunnel] = targets[platform];
const update = parse(await readFile(path.join('release', metadata), 'utf8'));
if (update.version !== version || typeof update.path !== 'string' || path.basename(update.path) !== update.path) {
  throw new Error('Installer metadata has the wrong version or filename.');
}
const entry = update.files.find((file) => file.url === update.path);
const installer = path.join('release', update.path);
const { size } = await stat(installer);
const sha512 = createHash('sha512');
const sha256 = createHash('sha256');
for await (const bytes of createReadStream(installer)) {
  sha512.update(bytes);
  sha256.update(bytes);
}
const digest = sha512.digest('base64');
if (!entry || size !== entry.size || digest !== entry.sha512 || digest !== update.sha512) {
  throw new Error('Installer does not match the size and SHA-512 recorded by electron-builder.');
}

const archive = path.join(resources, 'app.asar');
const app = JSON.parse(extractFile(archive, 'package.json').toString());
if (app.name !== 'conecode' || app.version !== version) throw new Error('Packaged app version mismatch.');
let runtimeFiles = 0;
for (const directory of ['dist', 'dist-electron']) {
  const entries = await readdir(directory, { recursive: true, withFileTypes: true });
  const files = entries.filter((item) => !item.isDirectory());
  if (!files.length) throw new Error('Empty build output: ' + directory);
  for (const file of files) {
    const relative = path.relative(process.cwd(), path.join(file.parentPath, file.name));
    if (!file.isFile()) throw new Error('Unexpected build output type: ' + relative);
    const info = statFile(archive, relative, false);
    const packaged = info.unpacked
      ? await readFile(path.join(archive + '.unpacked', relative))
      : extractFile(archive, relative, false);
    if (!packaged.equals(await readFile(relative))) {
      throw new Error('Packaged runtime differs from build output: ' + relative);
    }
  }
  runtimeFiles += files.length;
}
for (const relative of [
  'app.asar.unpacked/dist-electron/dsh-worker.js',
  'dsh-market/catalog.json',
  'examples/native-plugins/hello-conecode/conecode.plugin.json',
  'bin/' + tunnel,
]) {
  if (!(await stat(path.join(resources, relative))).size) throw new Error('Missing packaged resource: ' + relative);
}
const target = path.join('release-assets', publicName);
await mkdir('release-assets', { recursive: true });
await copyFile(installer, target);
await writeFile(target + '.sha256', sha256.digest('hex') + '  ' + publicName + '\n');
if (platform === 'linux') {
  const control = await readFile(installer + '.zsync');
  await writeFile(target + '.zsync', control);
  const controlHash = createHash('sha256').update(control).digest('hex');
  await writeFile(target + '.zsync.sha256', controlHash + '  ' + publicName + '.zsync\n');
}
console.log('Verified ' + publicName + ' (' + size + ' bytes), ' + runtimeFiles + ' runtime files, metadata and packaged resources.');
