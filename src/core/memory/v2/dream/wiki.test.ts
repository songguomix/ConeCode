import { describe, expect, it } from 'vitest';
import {
  buildIndexEntries,
  extractJsonObject,
  formatWikiFile,
  isRetired,
  parseWikiFile,
  pickRelevantEntries,
  redactSecrets,
  renderIndexMarkdown,
  safeScope,
  sanitizeSlug,
  wikiKey,
} from './wiki';
import type { WikiFile } from './types';

function file(overrides: Partial<WikiFile> = {}): WikiFile {
  return {
    slug: 'build-pipeline',
    name: 'Build pipeline',
    description: 'How the app is built',
    domain: 'workflows',
    updated: 1_700_000_000_000,
    sources: ['session-1'],
    body: 'Run `npm run build`. See [[release-process]].',
    ...overrides,
  };
}

describe('dream wiki storage format', () => {
  it('round-trips frontmatter and body', () => {
    const parsed = parseWikiFile(formatWikiFile(file()));
    expect(parsed).toMatchObject({
      slug: 'build-pipeline',
      name: 'Build pipeline',
      description: 'How the app is built',
      domain: 'workflows',
      sources: ['session-1'],
    });
    expect(parsed?.body).toContain('npm run build');
  });

  it('rejects malformed or unsafe files', () => {
    expect(parseWikiFile('no frontmatter')).toBeNull();
    expect(parseWikiFile('---\nname: x\n---\nbody')).toBeNull();
    expect(formatWikiFile(file({ body: 'MOVED TO [[x]]' }))).toContain('MOVED TO');
  });

  it('sanitises slugs into safe file names', () => {
    expect(sanitizeSlug('  Build Pipeline  ')).toBe('build-pipeline');
    expect(sanitizeSlug('../../etc/passwd')).toBe('etc-passwd');
    expect(sanitizeSlug('_index')).toBeNull();
    expect(sanitizeSlug('a')).toBeNull();
    expect(sanitizeSlug('x'.repeat(70))).toBeNull();
    expect(wikiKey('acme', 'build-pipeline')).toBe('dream/acme/wiki/build-pipeline.md');
    expect(safeScope('ConeCode/Core:1')).toBe('conecode_core_1');
  });

  it('redacts credentials before storing', () => {
    const out = redactSecrets('token ghp_abcdefghijklmnopqrstuvwxyz0123456789 and password=hunter2hunter2');
    expect(out).not.toContain('ghp_');
    expect(out).not.toContain('hunter2hunter2');
    expect(out).toContain('[redacted]');
  });

  it('builds a grouped index and hides retired topics', () => {
    const entries = buildIndexEntries([
      file(),
      file({ slug: 'release-process', domain: 'workflows', description: 'How releases work' }),
      file({ slug: 'old-topic', body: 'MOVED TO [[build-pipeline]]' }),
    ]);
    expect(entries.map((entry) => entry.slug)).toEqual(['build-pipeline', 'release-process']);
    const markdown = renderIndexMarkdown(entries, 'acme', 1_700_000_000_000);
    expect(markdown).toContain('## workflows');
    expect(markdown).toContain('[[build-pipeline]]');
    expect(markdown).not.toContain('[[old-topic]]');
  });

  it('marks moved files as retired', () => {
    expect(isRetired(file({ body: 'MOVED TO [[beta]]' }))).toBe(true);
    expect(isRetired(file({ body: 'normal notes' }))).toBe(false);
  });

  it('ranks index entries for the current task', () => {
    const entries = buildIndexEntries([
      file(),
      file({ slug: 'image-provider', name: 'Image provider', description: 'DALL-E configuration' }),
    ]);
    const picked = pickRelevantEntries(entries, 'How do I configure DALL-E image generation?', 1);
    expect(picked[0].slug).toBe('image-provider');
    expect(pickRelevantEntries(entries, 'zzz unrelated', 1)).toEqual([]);
  });

  it('extracts JSON from fences and surrounding prose', () => {
    expect(extractJsonObject('```json\n{"files":[]}\n```')).toEqual({ files: [] });
    expect(extractJsonObject('Here you go: {"merges":[]} thanks')).toEqual({ merges: [] });
    expect(extractJsonObject('not json')).toBeNull();
  });
});
