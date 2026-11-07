import semver from 'semver';
import {
  type CatalogPage,
  type CatalogQuery,
  type CompatibilityResult,
  type InstalledPlugin,
  type MarketCatalog,
  type MarketCategory,
  type MarketCategoryId,
  type MarketPlugin,
  type MarketVersion,
} from '../../src/core/dsh-market/types';

export const MARKET_CATEGORIES: MarketCategory[] = [
  { id: 'tools', title: { en: 'Tools', zh: '工具' } },
  { id: 'skills', title: { en: 'Skills', zh: 'Skills' } },
  { id: 'memory', title: { en: 'Memory', zh: '记忆' } },
  { id: 'models', title: { en: 'Model access', zh: '模型接入' } },
  { id: 'workflows', title: { en: 'Workflows', zh: '工作流' } },
  { id: 'interface', title: { en: 'Interface', zh: '界面扩展' } },
  { id: 'themes', title: { en: 'Themes', zh: '主题' } },
  { id: 'integrations', title: { en: 'Integrations', zh: '集成' } },
  { id: 'native', title: { en: 'ConeCode native', zh: 'ConeCode 原生' } },
];

const CATEGORY_IDS = new Set(MARKET_CATEGORIES.map((category) => category.id));

function cleanText(value: unknown): string {
  if (typeof value !== 'string') return '';
  return value
    .replace(/!\[[^\]]*\]\([^)]*\)/g, ' ')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/<[^>]+>/g, ' ')
    .replace(/^\s*[>#*-]+\s*/gm, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function pluginTitle(value: unknown, name: string): string {
  const cleaned = cleanText(value);
  const fallback = name.includes('/') ? name.split('/').pop() || name : name;
  if (!cleaned || cleaned.length > 90) return fallback;
  return cleaned;
}

export function normalizeCategory(value: unknown): MarketCategoryId {
  if (typeof value === 'string') {
    const id = value.toLowerCase();
    if (CATEGORY_IDS.has(id as MarketCategoryId)) return id as MarketCategoryId;
    if (/theme|skin|appearance/.test(id)) return 'themes';
    if (/memory|recall|ltm/.test(id)) return 'memory';
    if (/model|provider|llm/.test(id)) return 'models';
    if (/skill|prompt/.test(id)) return 'skills';
    if (/workflow|automation/.test(id)) return 'workflows';
    if (/ui|interface|visual|panel|sidebar/.test(id)) return 'interface';
    if (/tool|command|diagnostic/.test(id)) return 'tools';
  }
  return 'integrations';
}

function text(localized: unknown, fallback = ''): string {
  if (typeof localized === 'string') return localized;
  if (localized && typeof localized === 'object') {
    const record = localized as Record<string, unknown>;
    if (typeof record.en === 'string' && record.en) return record.en;
    if (typeof record.zh === 'string' && record.zh) return record.zh;
    const first = Object.values(record).find((value) => typeof value === 'string' && value);
    if (typeof first === 'string') return first;
  }
  return fallback;
}

function isoDate(value: unknown): string {
  if (typeof value === 'number') {
    const ms = value > 10_000_000_000 ? value : value * 1000;
    return new Date(ms).toISOString();
  }
  if (typeof value === 'string') {
    const ms = Date.parse(value);
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return new Date(0).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringRecord(value: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, item] of Object.entries(record(value))) {
    if (typeof item === 'string') out[key] = item;
  }
  return out;
}

function validateVersion(value: unknown, pluginName: string): MarketVersion {
  const v = record(value);
  if (typeof v.version !== 'string' || !semver.valid(v.version)) {
    throw new Error(`${pluginName}: catalog version is not an exact semantic version`);
  }
  const source = record(v.source);
  const type = source.type;
  if (type !== 'npm' && type !== 'git' && type !== 'local' && type !== 'bundled-example') {
    throw new Error(`${pluginName}@${v.version}: unsupported source type`);
  }
  if (type === 'git' && (typeof source.url !== 'string' || typeof source.commit !== 'string')) {
    throw new Error(`${pluginName}@${v.version}: git sources need url and commit`);
  }
  const engines = record(v.engines);
  return {
    version: v.version,
    publishedAt: isoDate(v.publishedAt),
    source: {
      type,
      packageName: typeof source.packageName === 'string' ? source.packageName : undefined,
      url: typeof source.url === 'string' ? source.url : undefined,
      commit: typeof source.commit === 'string' ? source.commit : undefined,
      subdir: typeof source.subdir === 'string' ? source.subdir : undefined,
      path: typeof source.path === 'string' ? source.path : undefined,
      registry: typeof source.registry === 'string' ? source.registry : undefined,
    },
    engines: {
      ...(typeof engines.dsh === 'string' ? { dsh: engines.dsh } : {}),
      ...(typeof engines.node === 'string' ? { node: engines.node } : {}),
    },
    peerDependencies: stringRecord(v.peerDependencies),
    dependencies: stringRecord(v.dependencies),
    ...(typeof v.integrity === 'string' ? { integrity: v.integrity } : {}),
    ...(typeof v.tarball === 'string' ? { tarball: v.tarball } : {}),
    ...(typeof v.deprecated === 'string' ? { deprecated: v.deprecated } : {}),
    ...(typeof v.size === 'number' ? { size: v.size } : {}),
    ...(typeof v.license === 'string' ? { license: v.license } : {}),
  };
}

function validatePlugin(value: unknown, sourceId: string): MarketPlugin {
  const p = record(value);
  if (typeof p.name !== 'string' || !p.name) throw new Error('Catalog plugin is missing a name');
  const format = p.format === 'native' ? 'native' : 'dsh';
  const versions = Array.isArray(p.versions) ? p.versions.map((version) => validateVersion(version, p.name as string)) : [];
  if (versions.length === 0) throw new Error(`${p.name}: a market entry needs at least one pinned version`);
  versions.sort((a, b) => semver.rcompare(a.version, b.version));
  const latest = versions[0];
  const repositoryValue = record(p.repository);
  const declared = record(p.declared);
  const statsValue = p.stats ? record(p.stats) : null;
  return {
    id: typeof p.id === 'string' && p.id ? p.id : p.name,
    name: p.name,
    format,
    title: pluginTitle(p.title, p.name),
    description: cleanText(p.description).slice(0, 420),
    author: typeof p.author === 'string' ? p.author : undefined,
    homepage: typeof p.homepage === 'string' ? p.homepage : undefined,
    repository: typeof repositoryValue.url === 'string'
      ? { url: repositoryValue.url, ...(typeof repositoryValue.directory === 'string' ? { directory: repositoryValue.directory } : {}) }
      : undefined,
    license: typeof p.license === 'string' ? p.license : latest.license,
    icon: typeof p.icon === 'string' ? p.icon : undefined,
    category: normalizeCategory(p.category),
    labels: Array.isArray(p.labels) ? p.labels.filter((item): item is string => typeof item === 'string') : [],
    keywords: Array.isArray(p.keywords) ? p.keywords.filter((item): item is string => typeof item === 'string') : [],
    dsh: Object.keys(record(p.dsh)).length ? record(p.dsh) : undefined,
    declared: {
      engines: stringRecord(declared.engines),
      peerDependencies: stringRecord(declared.peerDependencies),
      dsh: Object.keys(record(declared.dsh)).length ? record(declared.dsh) : undefined,
    },
    versions,
    stats: statsValue && typeof statsValue.provenance === 'object'
      ? {
          ...(typeof statsValue.npmDownloadsLastWeek === 'number' ? { npmDownloadsLastWeek: statsValue.npmDownloadsLastWeek } : {}),
          ...(typeof statsValue.githubStars === 'number' ? { githubStars: statsValue.githubStars } : {}),
          provenance: {
            source: typeof record(statsValue.provenance).source === 'string' ? String(record(statsValue.provenance).source) : 'catalog',
            retrievedAt: isoDate(record(statsValue.provenance).retrievedAt),
            ...(typeof record(statsValue.provenance).note === 'string' ? { note: String(record(statsValue.provenance).note) } : {}),
          },
        }
      : undefined,
    demo: p.demo === true,
    sourceId: typeof p.sourceId === 'string' ? p.sourceId : sourceId,
    readme: typeof p.readme === 'string' ? p.readme : undefined,
    screenshots: Array.isArray(p.screenshots) ? p.screenshots.filter((item): item is string => typeof item === 'string') : undefined,
  };
}

export function parseConeCodeCatalog(value: unknown, sourceId: string): MarketCatalog {
  const data = record(value);
  if (data.format !== 'conecode-dsh-market') throw new Error('Not a conecode-dsh-market catalog');
  if (data.formatVersion !== 1) throw new Error(`Unsupported catalog formatVersion ${String(data.formatVersion)}`);
  if (!Array.isArray(data.plugins)) throw new Error('Catalog plugins must be an array');
  const plugins = data.plugins.map((plugin) => validatePlugin(plugin, sourceId));
  return {
    format: 'conecode-dsh-market',
    formatVersion: 1,
    title: typeof data.title === 'string' ? data.title : sourceId,
    description: typeof data.description === 'string' ? data.description : '',
    generatedAt: isoDate(data.generatedAt),
    baseline: (record(data.baseline) as unknown as MarketCatalog['baseline']) || ({} as MarketCatalog['baseline']),
    categories: MARKET_CATEGORIES,
    plugins,
  };
}

/** Read a DSH official format-1 market index without inventing missing fields. */
export function parseDshMarketIndex(value: unknown, sourceId: string): MarketCatalog {
  const data = record(value);
  if (data.format !== 1 || !Array.isArray(data.plugins)) throw new Error('Not a DSH format-1 market index');
  const metadata = record(data.metadata);
  const categoryDecl = record(metadata.categories);
  const plugins: MarketPlugin[] = [];
  for (const raw of data.plugins) {
    const p = record(raw);
    if (typeof p.name !== 'string') continue;
    const versions = (Array.isArray(p.versions) ? p.versions : []).flatMap((rawVersion): MarketVersion[] => {
      const v = record(rawVersion);
      if (typeof v.version !== 'string' || !semver.valid(v.version)) return [];
      const source = record(v.source);
      const engines = record(v.engines);
      if (source.type !== 'npm' && source.type !== 'git') return [];
      return [{
        version: v.version,
        publishedAt: isoDate(v.publishTimestamp),
        source: {
          type: source.type,
          ...(typeof source.registry === 'string' ? { registry: source.registry } : {}),
          ...(typeof source.url === 'string' ? { url: source.url } : {}),
          ...(typeof source.commit === 'string' ? { commit: source.commit } : {}),
        },
        engines: { ...(typeof engines.dsh === 'string' ? { dsh: engines.dsh } : {}) },
        peerDependencies: {},
        dependencies: {},
      }];
    });
    if (!versions.length) continue;
    versions.sort((a, b) => semver.rcompare(a.version, b.version));
    const pluginMetadata = record(p.metadata);
    const categoryId = typeof pluginMetadata.category === 'string' ? pluginMetadata.category : undefined;
    const categoryTitle = categoryId ? text(record(categoryDecl[categoryId]).title, categoryId) : '';
    const repository = record(p.repository);
    plugins.push({
      id: p.name,
      name: p.name,
      format: 'dsh',
      title: pluginTitle(text(p.title, p.name), p.name),
      description: cleanText(text(p.description, '')).slice(0, 420),
      author: typeof p.author === 'string' ? p.author : undefined,
      homepage: typeof p.homepage === 'string' ? p.homepage : undefined,
      repository: typeof repository.url === 'string' ? { url: repository.url } : undefined,
      license: undefined,
      category: normalizeCategory(categoryId || categoryTitle),
      labels: Array.isArray(pluginMetadata.labels) ? pluginMetadata.labels.filter((x): x is string => typeof x === 'string') : [],
      keywords: Array.isArray(pluginMetadata.keywords) ? pluginMetadata.keywords.filter((x): x is string => typeof x === 'string') : [],
      declared: { engines: {}, peerDependencies: {} },
      versions,
      sourceId,
    });
  }
  return {
    format: 'conecode-dsh-market',
    formatVersion: 1,
    title: text(data.title, sourceId),
    description: text(data.description, ''),
    generatedAt: new Date().toISOString(),
    baseline: {} as MarketCatalog['baseline'],
    categories: MARKET_CATEGORIES,
    plugins,
  };
}

export function parseCatalogDocument(value: unknown, sourceId: string): MarketCatalog {
  const data = record(value);
  if (data.format === 1) return parseDshMarketIndex(value, sourceId);
  return parseConeCodeCatalog(value, sourceId);
}

export function mergeCatalogs(catalogs: MarketCatalog[], activeSourceIds: Set<string>): MarketPlugin[] {
  const byName = new Map<string, MarketPlugin>();
  for (const catalog of catalogs) {
    for (const plugin of catalog.plugins) {
      if (!activeSourceIds.has(plugin.sourceId)) continue;
      const existing = byName.get(plugin.name);
      if (!existing) {
        byName.set(plugin.name, { ...plugin });
        continue;
      }
      // Same package from multiple sources: keep the newest declared version
      // and merge provenance; never silently replace a pinned source.
      const newestExisting = existing.versions[0];
      const newestIncoming = plugin.versions[0];
      if (newestIncoming && (!newestExisting || semver.gt(newestIncoming.version, newestExisting.version))) {
        byName.set(plugin.name, { ...plugin, versions: mergeVersions(existing.versions, plugin.versions) });
      } else {
        existing.versions = mergeVersions(existing.versions, plugin.versions);
        existing.labels = [...new Set([...existing.labels, ...plugin.labels])];
      }
      if (!existing.stats && plugin.stats) existing.stats = plugin.stats;
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function mergeVersions(a: MarketVersion[], b: MarketVersion[]): MarketVersion[] {
  const map = new Map<string, MarketVersion>();
  for (const version of [...a, ...b]) if (!map.has(version.version)) map.set(version.version, version);
  return [...map.values()].sort((x, y) => semver.rcompare(x.version, y.version));
}

function tokens(query: string): string[] {
  return query.toLowerCase().split(/[\s,，、/]+/u).map((token) => token.trim()).filter(Boolean);
}

function matches(plugin: MarketPlugin, query: string): number {
  if (!query) return 1;
  const title = plugin.title.toLowerCase();
  const name = plugin.name.toLowerCase();
  const author = (plugin.author || '').toLowerCase();
  const description = plugin.description.toLowerCase();
  const rest = [...plugin.keywords, ...plugin.labels].join(' ').toLowerCase();
  let score = 0;
  for (const token of tokens(query)) {
    if (name === token || title === token) score += 8;
    else if (name.includes(token) || title.includes(token)) score += 5;
    else if (author.includes(token)) score += 3;
    else if (rest.includes(token)) score += 2;
    else if (description.includes(token)) score += 1;
    else return 0;
  }
  return score;
}

export function categoryTitle(id: MarketCategoryId, locale: 'en' | 'zh'): string {
  return MARKET_CATEGORIES.find((category) => category.id === id)?.title[locale] || id;
}

export function queryCatalog(
  plugins: MarketPlugin[],
  options: CatalogQuery,
  compatibilityOf: (plugin: MarketPlugin) => CompatibilityResult,
  installedOf: (plugin: MarketPlugin) => InstalledPlugin | null,
): CatalogPage {
  const page = Math.max(1, Math.trunc(options.page || 1));
  const pageSize = Math.min(60, Math.max(1, Math.trunc(options.pageSize || 12)));
  const query = options.query?.trim() || '';
  const scored = plugins
    .map((plugin) => ({ plugin, score: matches(plugin, query), compatibility: compatibilityOf(plugin) }))
    .filter((item) => item.score > 0);
  const categoryFiltered = options.category && options.category !== 'all'
    ? scored.filter((item) => item.plugin.category === options.category)
    : scored;
  const labelFiltered = options.label
    ? categoryFiltered.filter((item) => item.plugin.labels.includes(options.label!))
    : categoryFiltered;
  const compatibleOnly = options.compatibleOnly
    ? labelFiltered.filter((item) => item.compatibility.state !== 'incompatible')
    : labelFiltered;

  const sort = options.sort || 'relevance';
  compatibleOnly.sort((a, b) => {
    if (sort === 'name') return a.plugin.title.localeCompare(b.plugin.title);
    if (sort === 'downloads') {
      return (b.plugin.stats?.npmDownloadsLastWeek || 0) - (a.plugin.stats?.npmDownloadsLastWeek || 0);
    }
    if (sort === 'stars') {
      return (b.plugin.stats?.githubStars || 0) - (a.plugin.stats?.githubStars || 0);
    }
    if (sort === 'updated') {
      return Date.parse(b.plugin.versions[0]?.publishedAt || '') - Date.parse(a.plugin.versions[0]?.publishedAt || '');
    }
    return b.score - a.score || a.plugin.title.localeCompare(b.plugin.title);
  });

  const total = compatibleOnly.length;
  const start = (page - 1) * pageSize;
  const items = compatibleOnly.slice(start, start + pageSize).map((item) => ({
    ...item.plugin,
    compatibility: item.compatibility,
    installed: installedOf(item.plugin),
  }));

  const categoryCounts = new Map<MarketCategoryId, number>();
  for (const item of scored) categoryCounts.set(item.plugin.category, (categoryCounts.get(item.plugin.category) || 0) + 1);
  const labelCounts = new Map<string, number>();
  for (const item of scored) for (const label of item.plugin.labels) labelCounts.set(label, (labelCounts.get(label) || 0) + 1);

  return {
    items,
    total,
    page,
    pageSize,
    categories: MARKET_CATEGORIES.map((category) => ({ ...category, count: categoryCounts.get(category.id) || 0 })),
    labels: [...labelCounts.entries()].map(([id, count]) => ({ id, count })).sort((a, b) => b.count - a.count),
    fetchedAt: new Date().toISOString(),
  };
}

export function latestVersion(plugin: MarketPlugin): MarketVersion {
  const version = plugin.versions[0];
  if (!version) throw new Error(`${plugin.name} has no versions`);
  return version;
}
