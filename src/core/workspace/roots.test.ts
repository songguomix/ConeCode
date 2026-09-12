import { describe, it, expect } from 'vitest';
import {
  normalizeRoot, isInside, canAddRoot, rootLabel, rootOf, displayPath, resolveDisplayPath,
} from './roots';

describe('normalizeRoot', () => {
  it('strips trailing slashes so one folder has one spelling', () => {
    expect(normalizeRoot('/a/b/')).toBe('/a/b');
    expect(normalizeRoot('/a/b///')).toBe('/a/b');
    expect(normalizeRoot('  /a/b  ')).toBe('/a/b');
  });

  it('survives nonsense without throwing', () => {
    expect(normalizeRoot('')).toBe('');
    expect(normalizeRoot(undefined as any)).toBe('');
  });
});

describe('isInside', () => {
  it('counts a folder as inside itself', () => {
    expect(isInside('/a/b', '/a/b')).toBe(true);
    expect(isInside('/a/b/', '/a/b')).toBe(true);
  });

  it('sees a real descendant', () => {
    expect(isInside('/a/b/c', '/a/b')).toBe(true);
  });

  it('is not fooled by a shared name prefix', () => {
    // "/a/bc" is not inside "/a/b" — the boundary has to be a path separator.
    expect(isInside('/a/bc', '/a/b')).toBe(false);
    expect(isInside('/a/b-other', '/a/b')).toBe(false);
  });

  it('says no for unrelated paths', () => {
    expect(isInside('/x/y', '/a/b')).toBe(false);
    expect(isInside('', '/a')).toBe(false);
  });
});

describe('canAddRoot', () => {
  it('accepts an unrelated folder', () => {
    expect(canAddRoot('/work/api', ['/work/web'])).toEqual({ ok: true, path: '/work/api' });
  });

  it('normalises on the way in', () => {
    expect(canAddRoot('/work/api/', [])).toMatchObject({ ok: true, path: '/work/api' });
  });

  it('refuses a folder that is already open, however it is spelled', () => {
    expect(canAddRoot('/work/web', ['/work/web']).reason).toBe('duplicate');
    expect(canAddRoot('/work/web/', ['/work/web']).reason).toBe('duplicate');
  });

  it('refuses a folder inside one that is already open', () => {
    // It would appear twice in the tree and twice in every search result.
    const result = canAddRoot('/work/web/src', ['/work/web']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('inside-existing');
    expect(result.covered).toEqual(['/work/web']);
  });

  it('refuses a folder that would swallow ones already open, and names them', () => {
    const result = canAddRoot('/work', ['/work/web', '/work/api', '/other']);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe('contains-existing');
    expect(result.covered).toEqual(['/work/web', '/work/api']);
  });

  it('refuses an empty path', () => {
    expect(canAddRoot('   ', ['/a']).reason).toBe('empty');
  });

  it('is not confused by a sibling with a shared prefix', () => {
    expect(canAddRoot('/work/website', ['/work/web'])).toMatchObject({ ok: true });
  });
});

describe('rootLabel', () => {
  it('uses the folder name when that is unambiguous', () => {
    expect(rootLabel('/work/api', ['/work/api', '/work/web'])).toBe('api');
  });

  it('adds the parent when two folders share a name', () => {
    const roots = ['/work/web', '/personal/web'];
    expect(rootLabel('/work/web', roots)).toBe('work/web');
    expect(rootLabel('/personal/web', roots)).toBe('personal/web');
  });

  it('handles a root with no parent to show', () => {
    expect(rootLabel('/web', ['/web'])).toBe('web');
  });
});

describe('rootOf', () => {
  const roots = ['/work/web', '/work/api'];

  it('finds the folder a file belongs to', () => {
    expect(rootOf('/work/api/src/main.ts', roots)).toBe('/work/api');
  });

  it('returns null for a file outside every folder', () => {
    expect(rootOf('/tmp/x.ts', roots)).toBeNull();
  });

  it('prefers the most specific root if they ever nest', () => {
    expect(rootOf('/a/b/c/file.ts', ['/a', '/a/b'])).toBe('/a/b');
  });
});

describe('displayPath', () => {
  const roots = ['/work/web', '/work/api'];

  it('leaves the primary folder unprefixed — that is the common case', () => {
    expect(displayPath('/work/web/src/App.tsx', roots)).toBe('src/App.tsx');
  });

  it('prefixes files from the other folders, because a bare path is ambiguous', () => {
    expect(displayPath('/work/api/src/main.ts', roots)).toBe('api/src/main.ts');
  });

  it('disambiguates two folders with the same name', () => {
    const clashing = ['/work/web', '/personal/web'];
    expect(displayPath('/personal/web/index.ts', clashing)).toBe('personal/web/index.ts');
  });

  it('leaves a path outside every folder exactly as it is', () => {
    expect(displayPath('/tmp/scratch.ts', roots)).toBe('/tmp/scratch.ts');
  });
});

describe('resolveDisplayPath', () => {
  const roots = ['/work/web', '/work/api'];

  it('resolves a bare path against the primary folder', () => {
    expect(resolveDisplayPath('src/App.tsx', roots)).toBe('/work/web/src/App.tsx');
  });

  it('resolves a labelled path to the folder it names', () => {
    expect(resolveDisplayPath('api/src/main.ts', roots)).toBe('/work/api/src/main.ts');
  });

  it('round-trips whatever displayPath produced', () => {
    for (const abs of ['/work/web/src/App.tsx', '/work/api/src/main.ts']) {
      expect(resolveDisplayPath(displayPath(abs, roots), roots)).toBe(abs);
    }
  });

  it('does not let a folder inside the primary root shadow a workspace folder', () => {
    // "/work/web/api" also exists, but "api/…" must mean the api *workspace
    // folder* — that is what @-completion showed the user.
    expect(resolveDisplayPath('api/src/main.ts', roots)).toBe('/work/api/src/main.ts');
  });

  it('resolves the label on its own to the folder itself', () => {
    expect(resolveDisplayPath('api', roots)).toBe('/work/api');
  });

  it('passes an absolute path straight through', () => {
    expect(resolveDisplayPath('/tmp/x.ts', roots)).toBe('/tmp/x.ts');
  });

  it('handles clashing folder names via the disambiguated label', () => {
    const clashing = ['/work/web', '/personal/web'];
    expect(resolveDisplayPath('personal/web/index.ts', clashing)).toBe('/personal/web/index.ts');
  });

  it('gives up rather than guessing when nothing is open', () => {
    expect(resolveDisplayPath('src/App.tsx', [])).toBeNull();
    expect(resolveDisplayPath('', roots)).toBeNull();
  });
});
