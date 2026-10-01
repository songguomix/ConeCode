/**
 * Line-based diff for the editor's AI highlight.
 * Returns 1-based line numbers in `updated` that were added or changed.
 * Pure function — tested in diff.test.ts.
 */

/** Split text into lines without dropping a trailing empty line's meaning. */
function splitLines(text: string): string[] {
  if (text === '') return [];
  return text.split('\n');
}

/**
 * Myers O(ND) diff on lines, returning added line numbers in `b` (1-based).
 * Falls back to a prefix/suffix heuristic for very large files so the editor
 * never hangs on a generated bundle.
 */
export function addedLineNumbers(original: string, updated: string): number[] {
  const a = splitLines(original);
  const b = splitLines(updated);
  if (b.length === 0) return [];
  if (a.length === 0) return b.map((_, i) => i + 1);

  // Guard: Myers is O(ND); cap the product so a 10k-line generated file can't
  // freeze the renderer. The heuristic still marks the changed region.
  if (a.length * b.length > 4_000_000) return addedLinesHeuristic(a, b);

  const trace = myersTrace(a, b);
  if (!trace) return addedLinesHeuristic(a, b);
  return addedFromTrace(trace, b.length);
}

interface MyersTrace {
  trace: Map<number, Map<number, number>>;
  a: string[];
  b: string[];
}

function myersTrace(a: string[], b: string[]): MyersTrace | null {
  const n = a.length;
  const m = b.length;
  const max = n + m;
  const v = new Map<number, number>();
  v.set(1, 0);
  const trace = new Map<number, Map<number, number>>();
  try {
    for (let d = 0; d <= max; d++) {
      const snapshot = new Map<number, number>();
      for (let k = -d; k <= d; k += 2) {
        let x: number;
        const xDown = (v.get(k - 1) ?? -Infinity) + 1;
        const xRight = v.get(k + 1) ?? -Infinity;
        if (k === -d || (k !== d && xDown < xRight)) {
          x = xRight;
        } else {
          x = xDown;
        }
        let y = x - k;
        while (x < n && y < m && a[x] === b[y]) {
          x++;
          y++;
        }
        v.set(k, x);
        snapshot.set(k, x);
        if (x >= n && y >= m) {
          trace.set(d, snapshot);
          return { trace, a, b };
        }
      }
      trace.set(d, snapshot);
      // Safety valve — should have been caught by the size guard above.
      if (d > 20000) return null;
    }
  } catch {
    return null;
  }
  return null;
}

/** Walk the trace back and collect lines of `b` consumed by insertions. */
function addedFromTrace(t: MyersTrace, m: number): number[] {
  const { trace, a, b } = t;
  const ds = Array.from(trace.keys()).sort((x, y) => x - y);
  let x = a.length;
  let y = m;
  const added: number[] = [];
  for (let idx = ds.length - 1; idx > 0; idx--) {
    const d = ds[idx];
    const v = trace.get(d)!;
    const vPrev = trace.get(ds[idx - 1])!;
    const k = x - y;
    const xDown = (vPrev.get(k - 1) ?? -Infinity) + 1;
    const xRight = vPrev.get(k + 1) ?? -Infinity;
    const down = k === -d || (k !== d && xDown < xRight);
    const kPrev = down ? k + 1 : k - 1;
    const xPrev = vPrev.get(kPrev) ?? 0;
    const yPrev = xPrev - kPrev;
    // Diagonal (equal) moves first — they add nothing.
    while (x > xPrev && y > yPrev) {
      x--;
      y--;
    }
    if (down) {
      // Insertion: b[yPrev] is new. yPrev is 0-based → line yPrev+1.
      if (yPrev >= 0 && yPrev < m) added.push(yPrev + 1);
      y = yPrev;
    } else {
      x = xPrev;
    }
    void v;
  }
  return added.sort((p, q) => p - q);
}

/** Prefix/suffix fallback: marks the middle region as added. */
function addedLinesHeuristic(a: string[], b: string[]): number[] {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const out: number[] = [];
  for (let i = prefix + 1; i <= b.length - suffix; i++) out.push(i);
  return out;
}
