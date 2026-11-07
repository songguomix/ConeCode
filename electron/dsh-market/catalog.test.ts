import { describe, expect, it } from 'vitest';
import {
  parseCatalogDocument,
  parseDshMarketIndex,
  queryCatalog,
} from './catalog';
import type { CompatibilityResult, MarketPlugin } from '../../src/core/dsh-market/types';

const compatible: CompatibilityResult = {
  state: 'verified',
  authoredRange: '>=0.2.2-0 <0.3.0',
  authoredKeys: ['engines.dsh'],
  requirements: {},
  reasons: [],
  missing: [],
  exempted: false,
};

function plugin(name: string, overrides: Partial<MarketPlugin> = {}): MarketPlugin {
  return {
    id: name,
    name,
    format: 'dsh',
    title: name,
    description: 'A tool for testing',
    author: 'Ada',
    category: 'tools',
    labels: ['diagnostics'],
    keywords: ['terminal'],
    declared: {},
    versions: [{
      version: '1.0.0',
      publishedAt: '2026-11-01T00:00:00.000Z',
      source: { type: 'npm' },
      engines: {},
      peerDependencies: {},
      dependencies: {},
    }],
    recipe: undefined,
    sourceId: 'test',
    ...overrides,
  } as MarketPlugin;
}

describe('catalog parsing', () => {
  it('validates a ConeCode catalog and sorts versions descending', () => {
    const catalog = parseCatalogDocument({
      format: 'conecode-dsh-market',
      formatVersion: 1,
      title: 'Test',
      plugins: [{
        name: 'demo',
        versions: [
          { version: '1.0.0', publishedAt: '2026-01-01', source: { type: 'npm' } },
          { version: '2.0.0', publishedAt: '2026-02-01', source: { type: 'npm' } },
        ],
      }],
    }, 'test');
    expect(catalog.plugins[0].versions.map((version) => version.version)).toEqual(['2.0.0', '1.0.0']);
  });

  it('adapts a DSH official format-1 index without inventing missing data', () => {
    const catalog = parseDshMarketIndex({
      format: 1,
      title: { en: 'Community', zh: '社区' },
      metadata: { categories: { tool: { title: { en: 'Tools' } } } },
      plugins: [{
        name: 'dsh-demo',
        title: { en: 'Demo' },
        metadata: { category: 'tool', keywords: ['x'], labels: ['l'] },
        versions: [{
          version: '1.2.3',
          publishTimestamp: 1_760_000_000,
          source: { type: 'npm' },
          engines: { dsh: '>=0.2.2-0 <0.3.0' },
        }],
      }],
    }, 'remote');
    expect(catalog.plugins).toHaveLength(1);
    expect(catalog.plugins[0].name).toBe('dsh-demo');
    expect(catalog.plugins[0].category).toBe('tools');
    expect(catalog.plugins[0].versions[0].engines.dsh).toBe('>=0.2.2-0 <0.3.0');
    expect(catalog.plugins[0].license).toBeUndefined();
    expect(catalog.plugins[0].declared.peerDependencies).toEqual({});
  });

  it('rejects unsupported source types and non-semver versions', () => {
    expect(() => parseCatalogDocument({
      format: 'conecode-dsh-market',
      formatVersion: 1,
      plugins: [{ name: 'bad', versions: [{ version: 'latest', publishedAt: '', source: { type: 'npm' } }] }],
    }, 'test')).toThrow('exact semantic version');
  });
});

describe('catalog query', () => {
  const plugins = [
    plugin('zeta-tool', { category: 'tools', labels: ['diagnostics'], stats: { npmDownloadsLastWeek: 20, githubStars: 2, provenance: { source: 'test', retrievedAt: '2026-11-01' } } }),
    plugin('alpha-skill', { category: 'skills', labels: ['docs'], description: 'A skill', title: 'Alpha Skill' }),
    plugin('beta-tool', { category: 'tools', labels: ['diagnostics'], stats: { npmDownloadsLastWeek: 100, githubStars: 5, provenance: { source: 'test', retrievedAt: '2026-11-01' } } }),
  ];
  const compatibility = () => compatible;

  it('searches name, title, author, description, labels and keywords', () => {
    const page = queryCatalog(plugins, { query: 'diagnostics' }, compatibility, () => null);
    expect(page.items.map((item) => item.name).sort()).toEqual(['beta-tool', 'zeta-tool']);
    const bySkill = queryCatalog(plugins, { query: 'alpha skill' }, compatibility, () => null);
    expect(bySkill.items[0].name).toBe('alpha-skill');
    const byAuthor = queryCatalog(plugins, { query: 'ada' }, compatibility, () => null);
    expect(byAuthor.total).toBe(3);
  });

  it('filters by category, label, compatibility and sorts by downloads', () => {
    const filtered = queryCatalog(plugins, { category: 'tools', label: 'diagnostics', sort: 'downloads' }, compatibility, () => null);
    expect(filtered.items.map((item) => item.name)).toEqual(['beta-tool', 'zeta-tool']);
    const incompatible = queryCatalog(plugins, { compatibleOnly: true }, () => ({
      ...compatible,
      state: 'incompatible',
    }), () => null);
    expect(incompatible.total).toBe(0);
  });

  it('paginates and reports category and label counts', () => {
    const page = queryCatalog(plugins, { page: 2, pageSize: 1, sort: 'name' }, compatibility, () => null);
    expect(page.total).toBe(3);
    expect(page.page).toBe(2);
    expect(page.items).toHaveLength(1);
    expect(page.categories.find((item) => item.id === 'tools')?.count).toBe(2);
    expect(page.labels.find((item) => item.id === 'diagnostics')?.count).toBe(2);
  });
});
