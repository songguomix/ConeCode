const { execFileSync } = require('node:child_process');
const { open } = require('node:fs/promises');
const path = require('node:path');
const { appendBlockmap } = require('app-builder-lib/out/targets/differentialUpdateInfoBuilder');

async function readAt(file, offset, size) {
  const bytes = Buffer.alloc(size);
  const result = await file.read(bytes, 0, size, offset);
  if (result.bytesRead !== size) throw new Error('Truncated AppImage');
  return bytes;
}

// The type-2 runtime reserves .upd_info in the ELF header's section table.
// Read just that table and its names so a large SquashFS payload stays on disk.
async function findUpdateSection(file) {
  const header = await readAt(file, 0, 64);
  if (header.toString('ascii', 0, 4) !== '\x7fELF' || header[5] !== 1 ||
      header.toString('ascii', 8, 11) !== 'AI\x02' || ![1, 2].includes(header[4])) {
    throw new Error('Expected a little-endian type-2 AppImage');
  }
  const elf64 = header[4] === 2;
  const uint = (buffer, offset) => elf64 ? Number(buffer.readBigUInt64LE(offset)) : buffer.readUInt32LE(offset);
  const tableOffset = uint(header, elf64 ? 40 : 32);
  const sizesOffset = elf64 ? 58 : 46;
  const entrySize = header.readUInt16LE(sizesOffset);
  const count = header.readUInt16LE(sizesOffset + 2);
  const namesIndex = header.readUInt16LE(sizesOffset + 4);
  const sections = await readAt(file, tableOffset, entrySize * count);
  function section(index) {
    const base = index * entrySize;
    return {
      name: sections.readUInt32LE(base),
      offset: uint(sections, base + (elf64 ? 24 : 16)),
      size: uint(sections, base + (elf64 ? 32 : 20)),
    };
  }
  const namesSection = section(namesIndex);
  const names = await readAt(file, namesSection.offset, namesSection.size);
  for (let i = 0; i < count; i++) {
    const entry = section(i);
    if (names.toString('ascii', entry.name, names.indexOf(0, entry.name)) === '.upd_info') return entry;
  }
  throw new Error('AppImage runtime has no .upd_info section');
}

module.exports = async function artifactBuildCompleted(event) {
  if (event.target?.name !== 'appImage') return;
  const name = path.basename(event.file);
  const pattern = name.replace(event.packager.appInfo.version, '*');
  const update = Buffer.from(`gh-releases-zsync|songguomix|ConeCode|latest|${pattern}.zsync\0`);
  const file = await open(event.file, 'r+');
  try {
    const section = await findUpdateSection(file);
    if (update.length > section.size) throw new Error('AppImage update information exceeds its section');

    // electron-builder has already appended a compressed blockmap and its
    // four-byte length. Replace it after editing the runtime so its blocks,
    // final size and SHA-512 all describe the bytes that will be published.
    const { size } = await file.stat();
    const trailer = await readAt(file, size - 4, 4);
    const blockMapSize = trailer.readUInt32BE();
    if (!blockMapSize || blockMapSize !== event.updateInfo?.blockMapSize || size !== event.updateInfo.size) {
      throw new Error('Unexpected electron-builder AppImage blockmap');
    }
    const metadata = Buffer.alloc(section.size);
    update.copy(metadata);
    await file.write(metadata, 0, metadata.length, section.offset);
    await file.truncate(size - 4 - blockMapSize);
  } finally {
    await file.close();
  }
  event.updateInfo = await appendBlockmap(event.file);
  execFileSync('zsyncmake', ['-e', '-u', name, '-o', name + '.zsync', name], {
    cwd: path.dirname(event.file),
    stdio: 'inherit',
  });
};
