export interface DisplayDiffLine {
  type: 'added' | 'removed' | 'unchanged';
  content: string;
  oldLine?: number;
  newLine?: number;
}

const MAX_DIFF_CELLS = 4_000_000;

function splitLines(text: string): string[] {
  // Keep line endings for matching. An empty file has no lines, and the
  // newline terminating a line does not create a second, phantom blank line.
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

/** Walk matching lines in order. Trim shared edges before computing the LCS. */
function walkDiff(
  original: string,
  updated: string,
  emit: (type: DisplayDiffLine['type'], line: string, oldLine?: number, newLine?: number) => void,
): boolean {
  const before = splitLines(original);
  const after = splitLines(updated);
  let i = 0;
  let j = 0;
  let oldEnd = before.length;
  let newEnd = after.length;

  while (i < oldEnd && j < newEnd && before[i] === after[j]) {
    emit('unchanged', before[i], ++i, ++j);
  }
  while (oldEnd > i && newEnd > j && before[oldEnd - 1] === after[newEnd - 1]) {
    oldEnd--;
    newEnd--;
  }

  const oldSize = oldEnd - i;
  const newSize = newEnd - j;
  const start = i;
  const stride = newSize + 1;
  const approximate = oldSize * newSize > MAX_DIFF_CELLS;
  if (oldSize > 0 && newSize > 0 && !approximate) {
    const common = new Uint32Array((oldSize + 1) * stride);
    for (let x = oldSize - 1; x >= 0; x--) {
      for (let y = newSize - 1; y >= 0; y--) {
        const offset = x * stride + y;
        common[offset] = before[start + x] === after[start + y]
          ? common[offset + stride + 1] + 1
          : Math.max(common[offset + stride], common[offset + 1]);
      }
    }
    while (i < oldEnd && j < newEnd) {
      const offset = (i - start) * stride + j - start;
      if (before[i] === after[j]) emit('unchanged', before[i], ++i, ++j);
      else if (common[offset + stride] >= common[offset + 1]) emit('removed', before[i], ++i);
      else emit('added', after[j], undefined, ++j);
    }
  }

  // Large rewrites still preserve the shared prefix and suffix, without an
  // unbounded allocation in the renderer.
  while (i < oldEnd) emit('removed', before[i], ++i);
  while (j < newEnd) emit('added', after[j], undefined, ++j);
  while (i < before.length) emit('unchanged', before[i], ++i, ++j);
  return approximate;
}

export function buildDisplayDiff(original: string, updated: string): { lines: DisplayDiffLine[]; approximate: boolean } {
  const lines: DisplayDiffLine[] = [];
  const approximate = walkDiff(original, updated, (type, line, oldLine, newLine) => {
    lines.push({ type, content: line.replace(/\r?\n$/, ''), oldLine, newLine });
  });
  return { lines, approximate };
}

export function countDisplayDiff(original: string, updated: string): { added: number; removed: number; approximate: boolean } {
  if (original === updated) return { added: 0, removed: 0, approximate: false };
  let added = 0;
  let removed = 0;
  const approximate = walkDiff(original, updated, (type) => {
    if (type === 'added') added++;
    if (type === 'removed') removed++;
  });
  return { added, removed, approximate };
}
