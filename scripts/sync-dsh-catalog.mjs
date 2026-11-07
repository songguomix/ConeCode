#!/usr/bin/env node
/**
 * Regenerate the bundled, pinned DSH market catalog from the public npm
 * registry and GitHub. Every number and version in the output is fetched and
 * stamped with provenance. No star counts or download numbers are invented.
 *
 * Usage: node scripts/sync-dsh-catalog.mjs
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const OUT = path.join(ROOT, 'resources', 'dsh-market', 'catalog.json');
const MAX_VERSIONS = 30;

/** Curated community entries. The categories reflect actual verified content. */
const PLUGINS = [
  { name: 'dsh-plugin-guide', category: 'skills', labels: ['documentation', 'quality'] },
  { name: 'dsh-plugin-health', category: 'tools', labels: ['diagnostics', 'plugin-manager'] },
  { name: 'dsh-plugin-error-radar', category: 'tools', labels: ['diagnostics', 'commands'] },
  { name: '@dhicoc/dsh-chinese-traditional-wisdom-skill', category: 'skills', labels: ['workflow', 'culture'] },
  { name: 'dsh-find-plugin', category: 'tools', labels: ['discovery'] },
  { name: 'dsh-plugin-debugging', category: 'tools', labels: ['development', 'diagnostics'] },
  { name: 'dsh-plugin-share', category: 'integrations', labels: ['sharing', 'interface'] },
  { name: 'dsh-plugin-appshot', category: 'interface', labels: ['screenshots', 'context'] },
  { name: 'dsh-plugin-upgrader', category: 'interface', labels: ['versions', 'rollback'] },
  { name: 'dsh-plugin-tool-management', category: 'workflows', labels: ['management', 'interface'] },
  { name: 'dsh-plugin-mgr', category: 'interface', labels: ['management'] },
  { name: 'dsh-plugin-memory', category: 'memory', labels: ['tools', 'memory'] },
  { name: 'dsh-our-free-model', category: 'models', labels: ['provider'] },
  { name: 'dsh-theme', category: 'themes', labels: ['appearance'] },
  { name: 'dshmarket', category: 'interface', labels: ['market'] },
];

const CATEGORIES = [
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

const BASELINE = {
  version: '0.2.2-rc.1',
  tag: 'dsh-v0.2.2-rc.1',
  commit: '66491b05e3f05ad35bcdd4f6cd7ed26041d9e3db',
  repository: 'https://github.com/deepseek-ai/deepseek-harness',
  references: [
    'docs/architecture.md',
    'docs/user/develop/basic/publish.md',
    'packages/boot/app-boot/README.md',
    'packages/boot/plugin-manager/README.md',
    'packages/boot/app-boot/src/plugin-compatibility.ts',
    'packages/boot/app-boot/src/profile.ts',
    'packages/util/plugin-market-index/README.md',
  ],
};

const USER_AGENT = 'conecode-dsh-catalog/1.0 (+https://github.com/songguomix/ConeCode)';

async function getJSON(url, timeout = 30000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(url, { headers: { accept: 'application/json', 'user-agent': USER_AGENT }, signal: controller.signal });
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return await response.json();
  } finally {
    clearTimeout(timer);
  }
}

function stringRecord(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  return Object.fromEntries(Object.entries(value).filter(([, item]) => typeof item === 'string'));
}

function githubRepoFromManifest(manifest) {
  const repository = manifest.repository;
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return null;
  const normalized = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/#]+)/i);
  return match ? `${match[1]}/${match[2]}` : null;
}

function normalizeRepository(manifest) {
  const repository = manifest.repository;
  const raw = typeof repository === 'string' ? repository : repository?.url;
  if (typeof raw !== 'string') return undefined;
  const normalized = raw.replace(/^git\+/, '').replace(/\.git$/, '').replace(/^git:\/\//, 'https://');
  const match = normalized.match(/github\.com[/:]([^/]+)\/([^/#]+)/i);
  if (!match) return undefined;
  return { url: `https://github.com/${match[1]}/${match[2]}` };
}

function screenshotsFrom(readme) {
  if (typeof readme !== 'string') return [];
  const out = [];
  const pattern = /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/g;
  for (const match of readme.matchAll(pattern)) {
    const url = match[1].replace(/[?#].*$/, '');
    if (/shields\.io|awesome-dsh-plugin\.com\/badge|badge/i.test(url)) continue;
    if (!/\.(png|jpe?g|gif|webp|avif|svg)(?:$|\/)/i.test(url) && !url.includes('raw.githubusercontent.com')) continue;
    if (!out.includes(url)) out.push(url);
    if (out.length >= 6) break;
  }
  return out;
}

async function fetchDownloads(name) {
  try {
    const data = await getJSON(`https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`);
    return typeof data.downloads === 'number' ? data.downloads : undefined;
  } catch {
    return undefined;
  }
}

async function fetchStars(repo) {
  if (!repo) return undefined;
  try {
    const data = await getJSON(`https://api.github.com/repos/${repo}`, 20000);
    return typeof data.stargazers_count === 'number' ? data.stargazers_count : undefined;
  } catch {
    return undefined;
  }
}

async function buildEntry(entry) {
  const packument = await getJSON(`https://registry.npmjs.org/${encodeURIComponent(entry.name)}`);
  const latest = packument['dist-tags']?.latest;
  const latestManifest = packument.versions?.[latest] || {};
  const allVersions = Object.keys(packument.versions || {})
    .filter((version) => /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(version))
    .sort((a, b) => {
      const ta = Date.parse(packument.time?.[a] || 0);
      const tb = Date.parse(packument.time?.[b] || 0);
      return tb - ta;
    })
    .slice(0, MAX_VERSIONS);

  const versions = allVersions.map((version) => {
    const manifest = packument.versions[version];
    return {
      version,
      publishedAt: packument.time?.[version] || new Date(0).toISOString(),
      source: { type: 'npm' },
      engines: {
        ...(typeof manifest.engines?.dsh === 'string' ? { dsh: manifest.engines.dsh } : {}),
        ...(typeof manifest.engines?.node === 'string' ? { node: manifest.engines.node } : {}),
      },
      peerDependencies: stringRecord(manifest.peerDependencies),
      dependencies: stringRecord(manifest.dependencies),
      ...(manifest.dist?.integrity ? { integrity: manifest.dist.integrity } : {}),
      ...(manifest.dist?.tarball ? { tarball: manifest.dist.tarball } : {}),
      ...(typeof manifest.deprecated === 'string' ? { deprecated: manifest.deprecated } : {}),
      ...(typeof manifest.dist?.unpackedSize === 'number' ? { size: manifest.dist.unpackedSize } : {}),
      ...(typeof manifest.license === 'string' ? { license: manifest.license } : {}),
    };
  });

  if (!versions.length) throw new Error(`${entry.name} has no installable semver versions`);

  const repository = normalizeRepository(latestManifest);
  const repoSlug = githubRepoFromManifest(latestManifest);
  const [npmDownloadsLastWeek, githubStars] = await Promise.all([fetchDownloads(entry.name), fetchStars(repoSlug)]);
  const readme = typeof latestManifest.readme === 'string'
    ? latestManifest.readme
    : typeof packument.readme === 'string'
      ? packument.readme
      : undefined;
  const pinnedReadme = allVersions
    .map((version) => packument.versions?.[version]?.readme)
    .find((value) => typeof value === 'string' && value.trim());

  const retrievedAt = new Date().toISOString();
  return {
    id: entry.name,
    name: entry.name,
    format: 'dsh',
    title: typeof latestManifest.description === 'string' && latestManifest.description.length < 90
      ? latestManifest.description
      : entry.name,
    description: typeof latestManifest.description === 'string' ? latestManifest.description : '',
    ...(typeof latestManifest.author === 'string'
      ? { author: latestManifest.author }
      : typeof latestManifest.author?.name === 'string'
        ? { author: latestManifest.author.name }
        : {}),
    ...(typeof latestManifest.homepage === 'string' ? { homepage: latestManifest.homepage } : {}),
    ...(repository ? { repository } : {}),
    ...(typeof latestManifest.license === 'string' ? { license: latestManifest.license } : {}),
    ...(typeof latestManifest.icon === 'string' ? { icon: latestManifest.icon } : {}),
    category: entry.category,
    labels: entry.labels,
    keywords: Array.isArray(latestManifest.keywords) ? latestManifest.keywords.filter((x) => typeof x === 'string') : [],
    ...(latestManifest.dsh && typeof latestManifest.dsh === 'object' ? { dsh: latestManifest.dsh } : {}),
    declared: {
      engines: stringRecord(latestManifest.engines),
      peerDependencies: stringRecord(latestManifest.peerDependencies),
      ...(latestManifest.dsh && typeof latestManifest.dsh === 'object' ? { dsh: latestManifest.dsh } : {}),
    },
    versions,
    ...(npmDownloadsLastWeek !== undefined || githubStars !== undefined
      ? {
          stats: {
            ...(npmDownloadsLastWeek !== undefined ? { npmDownloadsLastWeek } : {}),
            ...(githubStars !== undefined ? { githubStars } : {}),
            provenance: {
              source: 'npm registry + GitHub API',
              retrievedAt,
              note: 'Counts are point-in-time observations and are never used as a compatibility signal.',
            },
          },
        }
      : {}),
    ...(pinnedReadme ? { readme: String(pinnedReadme).slice(0, 500_000) } : readme ? { readme: readme.slice(0, 500_000) } : {}),
    ...(screenshotsFrom(readme).length ? { screenshots: screenshotsFrom(readme) } : {}),
  };
}

async function main() {
  const plugins = [];
  for (const entry of PLUGINS) {
    process.stdout.write(`· ${entry.name}\n`);
    try {
      plugins.push(await buildEntry(entry));
    } catch (error) {
      process.stderr.write(`  ! skipped: ${error instanceof Error ? error.message : String(error)}\n`);
    }
  }
  const catalog = {
    format: 'conecode-dsh-market',
    formatVersion: 1,
    title: 'DSH 社区插件（固定版本精选）',
    description: 'A pinned, provenance-stamped selection of real community DSH plugins. Compatibility is shown separately and only from recorded runs.',
    generatedAt: new Date().toISOString(),
    baseline: BASELINE,
    categories: CATEGORIES,
    plugins,
  };
  await fs.mkdir(path.dirname(OUT), { recursive: true });
  await fs.writeFile(OUT, JSON.stringify(catalog, null, 2) + '\n', 'utf8');
  process.stdout.write(`Wrote ${plugins.length} plugins → ${path.relative(ROOT, OUT)}\n`);
}

await main();
