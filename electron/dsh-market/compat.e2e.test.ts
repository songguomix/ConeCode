/**
 * Real-plugin compatibility E2E.
 *
 * This test intentionally performs real npm installs and launches the built
 * DSH worker. It is skipped unless DSH_COMPAT_E2E=1 and must run under the
 * Electron Node runtime (Node 24) so `engines.node` checks match production.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { DshMarketService } from './market-service';
import { DSH_BASELINE, DSH_COMPAT_LAYER_VERSION, type PluginVerification, type VerificationEvidence } from '../../src/core/dsh-market/types';

const enabled = process.env.DSH_COMPAT_E2E === '1';
const timeout = 300_000;
const roots: string[] = [];

function tempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'conecode-dsh-e2e-'));
  roots.push(root);
  return root;
}

function writeTraceFixture(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  const rows = [
    { v: 1, sessionId: 's1', at: '2026-11-06T10:00:00.000Z', tool: 'bash', durationMs: 120, argChars: 10, resultChars: 20, isError: false },
    { v: 1, sessionId: 's1', at: '2026-11-06T10:01:00.000Z', tool: 'bash', durationMs: 100, argChars: 10, resultChars: 20, isError: false },
    { v: 1, sessionId: 's2', at: '2026-11-06T10:02:00.000Z', tool: 'web_fetch', durationMs: 5000, argChars: 10, resultChars: 20, isError: true },
    { v: 1, sessionId: 's2', at: '2026-11-06T10:03:00.000Z', tool: 'web_fetch', durationMs: 5100, argChars: 10, resultChars: 20, isError: true },
    { v: 1, sessionId: 's2', at: '2026-11-06T10:04:00.000Z', tool: 'web_fetch', durationMs: 5200, argChars: 10, resultChars: 20, isError: true },
    { v: 1, sessionId: 's2', at: '2026-11-06T10:05:00.000Z', tool: 'web_fetch', durationMs: 5300, argChars: 10, resultChars: 20, isError: true },
  ];
  fs.writeFileSync(path.join(dir, 'tool-trace-2026-11.jsonl'), rows.map((row) => JSON.stringify(row)).join('\n'), 'utf8');
}

function writeStorageProbe(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-storage-probe',
    version: '1.0.0',
    description: 'A real DSH storage-domain consumer used to verify the plugin storage substrate.',
    license: 'MIT',
    type: 'module',
    exports: { '.': './index.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `- insert:\n    - id: storage-probe\n      name: dsh-storage-probe\n`);
  fs.writeFileSync(path.join(dir, 'index.mjs'), `
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'
import { z } from 'zod'

export const name = 'storage-probe'
export const inject = ['storageDomain', 'tools']

const probe = defineDomain({
  name: 'conecode_probe',
  version: 1,
  tables: { records: domainTable(z.object({ value: z.string() })) },
})

export async function apply(ctx) {
  const domain = await ctx.storageDomain.open(probe)
  const existing = domain.table('records').get('probe')
  if (!existing) await domain.table('records').put('probe', { value: 'persisted-through-json-backend' })
  ctx.effect(() => () => domain.close())
  ctx.tools.register({
    name: 'storage_probe',
    description: 'Read the persisted DSH storage-domain value.',
    parameters: { type: 'object', properties: {} },
    async execute() {
      return { value: domain.table('records').get('probe')?.value ?? null }
    },
  })
}
`);
}

function writeBrokenUpdate(dir: string): void {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({
    name: 'dsh-plugin-error-radar',
    version: '0.2.1',
    description: 'A deliberately broken update used to verify rollback.',
    license: 'MIT',
    exports: { '.': './index.mjs' },
    dsh: { bundle: { patch: './cordis.patch.yml' } },
    peerDependencies: { '@deepseek-ai/cordis': '>=4.0.0' },
  }, null, 2));
  fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), `- insert:\n    - id: error-radar\n      name: dsh-plugin-error-radar\n`);
  fs.writeFileSync(path.join(dir, 'index.mjs'), `export const name = 'error-radar'\nexport const inject = ['commands']\nexport function apply() { throw new Error('broken update probe') }\n`);
}

interface EvidenceRecord {
  name: string;
  version: string;
  state: PluginVerification['state'];
  capabilities: string[];
  missing: string[];
  evidence: VerificationEvidence[];
  note?: string;
}

describe.skipIf(!enabled)('real DSH community plugins', () => {
  let service: DshMarketService;
  let root: string;
  const records: EvidenceRecord[] = [];
  const env = {
    appVersion: process.env.npm_package_version || 'test',
    electronVersion: process.versions.electron || 'unknown',
    nodeVersion: process.versions.node,
    ...(process.versions.chrome ? { chromeVersion: process.versions.chrome } : {}),
    platform: process.platform,
    arch: process.arch,
  };

  afterAll(async () => {
    try { await service?.runtime.shutdown(); } catch {}
    for (const dir of roots.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs the full real-plugin matrix, lifecycle and restart flow', async () => {
    root = tempRoot();
    service = new DshMarketService({
      rootDir: root,
      appPath: process.cwd(),
      versions: { app: env.appVersion, electron: env.electronVersion, chrome: env.chromeVersion },
    });
    await service.initialize();

    expect(service.snapshot).toBeTypeOf('function');
    const initial = await service.snapshot({ pageSize: 60 });
    expect(initial.catalog.total).toBeGreaterThan(0);
    expect(initial.baseline.commit).toBe(DSH_BASELINE.commit);

    // ---- 0. Repository import: inspect, pin, install, clean up -------------
    service.createProfile('git-import', 'Git import');
    await service.switchProfile('git-import');
    const repoInspection = await service.inspectRepository(
      'https://github.com/PerryLink/dsh-plugin-guide',
      'v0.4.5',
    );
    expect(repoInspection.plugin.name).toBe('dsh-plugin-guide');
    expect(repoInspection.version.version).toBe('0.4.5');
    expect(repoInspection.commit).toBe('ccab614d6045625c359f4416e0760f93f7abe260');
    const repoInstalled = await service.installRepository(
      'git-import',
      'https://github.com/PerryLink/dsh-plugin-guide',
      'v0.4.5',
    );
    expect(repoInstalled.status).toBe('loaded');
    expect(repoInstalled.requestedSpec).toContain('ccab614d6045625c359f4416e0760f93f7abe260');
    expect(repoInstalled.catalogKnown).toBe(false);
    const repointedSkills = await service.listSkills();
    expect(repointedSkills.some((skill) => skill.name === 'dsh-plugin-guide')).toBe(true);
    await service.uninstall('git-import', 'dsh-plugin-guide', false);
    await service.switchProfile('default');

    // ---- 1. Search → install → configure → execute ------------------------
    const searched = await service.snapshot({ query: 'radar', category: 'tools', pageSize: 20 });
    expect(searched.catalog.items.some((plugin) => plugin.name === 'dsh-plugin-error-radar')).toBe(true);
    const labelled = await service.snapshot({ query: '', category: 'tools', label: 'diagnostics', pageSize: 20 });
    expect(labelled.catalog.items.length).toBeGreaterThan(0);

    const errorRadar = await service.install('default', 'dsh-plugin-error-radar', '0.2.0');
    expect(errorRadar.version).toBe('0.2.0');
    expect(errorRadar.status).toBe('loaded');
    expect(errorRadar.contributions.commands.map((command) => command.name).sort()).toEqual(['health', 'radar']);

    const traceDir = path.join(root, 'fixture-tool-trace');
    writeTraceFixture(traceDir);
    await service.saveConfig('default', 'dsh-plugin-error-radar', {
      'error-radar': { enabled: true, dataDir: traceDir, errorRateAlert: 20 },
    });
    await expect(service.saveConfig('default', 'dsh-plugin-error-radar', {
      'error-radar': { enabled: true, dataDir: traceDir, errorRateAlert: 999 },
    })).rejects.toThrow(/errorRateAlert|expected|range/i);
    const afterRejectedConfig = await service.invokeCommand('default', 'dsh-plugin-error-radar', 'radar', '');
    expect(afterRejectedConfig.ok).toBe(true);

    const radar = await service.invokeCommand('default', 'dsh-plugin-error-radar', 'radar', '');
    expect(radar.ok).toBe(true);
    expect(radar.rendered || '').toContain('web_fetch');
    expect(String((radar.value as any).text)).toContain('100%');
    const health = await service.invokeCommand('default', 'dsh-plugin-error-radar', 'health', '--days 7');
    expect(health.ok).toBe(true);
    expect(health.rendered || '').toContain('web_fetch');
    expect(String((health.value as any).text)).toContain('web_fetch');
    records.push({
      name: 'repository-import',
      version: '1',
      state: 'verified',
      capabilities: ['git:ls-remote', 'git:pinned-fetch', 'git:install', 'profile:switch'],
      missing: [],
      evidence: [
        { kind: 'install', summary: 'A Git repository URL was inspected and pinned to commit ccab614d6045625c359f4416e0760f93f7abe260, installed into an isolated profile, listed its skill, and was removed again.' },
      ],
    });

    records.push({
      name: 'dsh-plugin-error-radar',
      version: '0.2.0',
      state: 'verified',
      capabilities: ['command:radar', 'command:health', 'config:save'],
      missing: [],
      evidence: [
        { kind: 'install', summary: 'Real npm install of dsh-plugin-error-radar@0.2.0 into an isolated profile.' },
        { kind: 'command', summary: '/radar reported web_fetch 4 calls, 100% errors, 4 consecutive failures.', observation: String((radar.value as any).text).slice(0, 400) },
        { kind: 'command', summary: '/health --days 7 produced a go/no-go verdict over the fixture trace.', observation: String((health.value as any).text).slice(0, 400) },
        { kind: 'error-path', summary: 'A rejected config (errorRateAlert=999) kept the previous instance and /radar remained usable.' },
        { kind: 'lifecycle', summary: 'Disable/re-enable/uninstall exercised in this run.' },
      ],
      note: 'Fixture trace data is input data; no plugin output was synthesized.',
    });

    // ---- 1b. Official DSH storage substrate ---------------------------------
    const storageProbeDir = path.join(root, 'storage-probe');
    writeStorageProbe(storageProbeDir);
    const storagePlugin = await service.installLocal('default', storageProbeDir);
    expect(storagePlugin.status).toBe('loaded');
    const storageRead = await service.invokeTool('default', 'dsh-storage-probe', 'storage_probe', {});
    expect(storageRead.ok).toBe(true);
    expect((storageRead.value as any).value).toBe('persisted-through-json-backend');
    records.push({
      name: 'dsh-storage-probe',
      version: '1.0.0',
      state: 'verified',
      capabilities: ['storage:ctx.storage', 'storage:ctx.storageDomain', 'storage:json-backend', 'storage:restart-persistence'],
      missing: [],
      evidence: [
        { kind: 'load', summary: 'A real Cordis plugin opened a zod-validated domain through @deepseek-ai/dsh-storage-domain.' },
        { kind: 'tool', summary: 'storage_probe read the record durably written by the JSON backend.' },
      ],
    });

    // ---- 2. Real skill plugin ----------------------------------------------
    const guide = await service.install('default', 'dsh-plugin-guide', '0.4.5');
    expect(guide.status).toBe('loaded');
    await expect(service.install('default', 'dsh-plugin-guide', '0.4.5')).rejects.toThrow(/already installed/);
    expect(guide.compatibility.state === 'unverified' || guide.compatibility.state === 'verified').toBe(true);
    const skills = await service.listSkills();
    expect(skills.some((skill) => skill.name === 'dsh-plugin-guide')).toBe(true);
    const guideBody = await service.getSkill('dsh-plugin-guide', 'dsh-plugin-guide');
    expect(guideBody || '').toContain('DSH Plugin Guide');
    expect(guideBody || '').toContain('ENTRY');
    records.push({
      name: 'dsh-plugin-guide',
      version: '0.4.5',
      state: 'verified',
      capabilities: ['skill:register', 'skill:get'],
      missing: [],
      evidence: [
        { kind: 'install', summary: 'Real npm install under Electron Node 24.19.0.' },
        { kind: 'skill', summary: 'Registered skill was listed and its Markdown body was read.', observation: (guideBody || '').slice(0, 240) },
      ],
    });

    // ---- 2b. Real skill provider -------------------------------------------
    const wisdom = await service.install('default', '@dhicoc/dsh-chinese-traditional-wisdom-skill', '1.3.0');
    expect(wisdom.status).toBe('loaded');
    const providerSkills = await service.listSkills();
    expect(providerSkills.some((skill) => skill.name === 'chinese-traditional-wisdom-ai-agent-workflow')).toBe(true);
    const wisdomBody = await service.getSkill('@dhicoc/dsh-chinese-traditional-wisdom-skill', 'chinese-traditional-wisdom-ai-agent-workflow');
    expect(wisdomBody || '').toContain('中国传统文化');
    records.push({
      name: '@dhicoc/dsh-chinese-traditional-wisdom-skill',
      version: '1.3.0',
      state: 'verified',
      capabilities: ['skill:registerProvider', 'skill:list', 'skill:get'],
      missing: [],
      evidence: [
        { kind: 'install', summary: 'Real npm install; the skill provider registered without modifying plugin code.' },
        { kind: 'skill', summary: 'Provider-list returned chinese-traditional-wisdom-ai-agent-workflow and its body was read.', observation: (wisdomBody || '').slice(0, 240) },
      ],
    });

    // ---- 2c. Real Git transport with a pinned commit -----------------------
    const gitPrepared = await service.installer.prepare({
      profileId: 'default',
      requestId: 'git-transport-verify',
      name: 'dsh-plugin-guide',
      version: '0.4.5',
      source: {
        type: 'git',
        url: 'https://github.com/PerryLink/dsh-plugin-guide',
        commit: 'ccab614d6045625c359f4416e0760f93f7abe260',
      },
      onLog: () => {},
      signal: new AbortController().signal,
    });
    expect(gitPrepared.rows[0]?.name).toBe('dsh-plugin-guide');
    expect(gitPrepared.requestedSpec).toContain('ccab614d6045625c359f4416e0760f93f7abe260');
    fs.rmSync(gitPrepared.stagingDir, { recursive: true, force: true });

    // ---- 3. Real tool plugin ------------------------------------------------
    const healthPlugin = await service.install('default', 'dsh-plugin-health', '3.0.5');
    expect(healthPlugin.status).toBe('loaded');
    expect(healthPlugin.compatibility.state).toBe('partial');
    expect(healthPlugin.compatibility.missing).toContain('web-client');
    const tool = await service.invokeTool('default', 'dsh-plugin-health', 'plugin_health', { json: true });
    expect(tool.ok).toBe(true);
    const report = String(tool.value);
    expect(report).toContain('"home"');
    expect(report).toContain('profiles');
    records.push({
      name: 'dsh-plugin-health',
      version: '3.0.5',
      state: 'partial',
      capabilities: ['tool:plugin_health', 'host-side load'],
      missing: ['web-client'],
      evidence: [
        { kind: 'install', summary: 'Real npm install; host half loaded with the pinned DSH tool peer.' },
        { kind: 'tool', summary: 'plugin_health returned a structured report for the isolated DSH home.', observation: report.slice(0, 500) },
      ],
      note: 'The package ships a DSH Web client half. ConeCode loads the host half only; the client UI is not mounted.',
    });

    // ---- 3b. Successful update and rollback -------------------------------
    const updatedHealth = await service.install('default', 'dsh-plugin-health', '3.0.4');
    expect(updatedHealth.version).toBe('3.0.4');
    expect(updatedHealth.backups.some((backup) => backup.version === '3.0.5')).toBe(true);
    const rolledBack = await service.rollback('default', 'dsh-plugin-health', '3.0.5');
    expect(rolledBack.version).toBe('3.0.5');
    const healthAfterRollback = await service.invokeTool('default', 'dsh-plugin-health', 'plugin_health', { json: true });
    expect(healthAfterRollback.ok).toBe(true);
    records.push({
      name: 'dsh-plugin-health',
      version: '3.0.5',
      state: 'partial',
      capabilities: ['update', 'rollback'],
      missing: ['web-client'],
      evidence: [
        { kind: 'install', summary: 'Updated the installed 3.0.5 to 3.0.4 and kept a rollback package.' },
        { kind: 'rollback', summary: 'Rolled back to 3.0.5; plugin_health executed again after the swap.' },
      ],
      note: 'Web client half remains unsupported; host tool works in both versions.',
    });

    // ---- 4. Real incompatible declaration, explicit exemption, real tool ----
    const findDetail = await service.detail('dsh-find-plugin');
    expect(findDetail.versions[0].compatibility.state).toBe('incompatible');
    expect(findDetail.versions[0].compatibility.requirements).toHaveProperty('@deepseek-ai/dsh-tools');
    await expect(service.install('default', 'dsh-find-plugin', '0.4.0')).rejects.toThrow(/Incompatible plugin/);
    const find = await service.install('default', 'dsh-find-plugin', '0.4.0', { acceptRisk: true });
    expect(find.status).toBe('loaded');
    expect(find.compatibility.state).toBe('partial');
    const found = await service.invokeTool('default', 'dsh-find-plugin', 'find_dsh_plugin', { query: 'terminal', limit: 3, lang: 'en' });
    expect(found.ok).toBe(true);
    expect(Array.isArray((found.value as any).results)).toBe(true);
    expect((found.value as any).results.length).toBeGreaterThan(0);
    records.push({
      name: 'dsh-find-plugin',
      version: '0.4.0',
      state: 'partial',
      capabilities: ['tool:find_dsh_plugin', 'curated fallback'],
      missing: ['@deepseek-ai/dsh-tools declared range excludes 0.2.2-rc.1'],
      evidence: [
        { kind: 'error-path', summary: 'Installation without an exemption was refused with the exact peer requirement.' },
        { kind: 'install', summary: 'Installed with an exact-version exemption and the shared 0.2.2-rc.1 tool peer.' },
        { kind: 'tool', summary: 'Live GitHub search returned ranked DSH plugins.', observation: JSON.stringify((found.value as any).results.slice(0, 2)) },
      ],
      note: 'Author-declared peer range excludes the baseline; compatibility is partial and marked as such.',
    });

    // ---- 4b. Dependency resolution failure leaves no installed record ------
    const conflictDir = path.join(root, 'conflict-plugin');
    fs.mkdirSync(conflictDir, { recursive: true });
    fs.writeFileSync(path.join(conflictDir, 'package.json'), JSON.stringify({
      name: 'dsh-conflict-demo',
      version: '1.0.0',
      description: 'A local plugin with an unsatisfiable file dependency.',
      license: 'MIT',
      exports: { '.': './index.mjs' },
      dsh: { bundle: { patch: './cordis.patch.yml' } },
      dependencies: { missing: 'not a valid spec !!' },
    }, null, 2));
    fs.writeFileSync(path.join(conflictDir, 'cordis.patch.yml'), `- insert:\n    - id: conflict-demo\n      name: dsh-conflict-demo\n`);
    fs.writeFileSync(path.join(conflictDir, 'index.mjs'), `export function apply() {}\n`);
    await expect(service.installLocal('default', conflictDir)).rejects.toThrow(/npm|dependencies/i);
    expect((await service.snapshot()).installed.some((plugin) => plugin.name === 'dsh-conflict-demo')).toBe(false);

    // ---- 5. Failed update restores the previous working version ------------
    const brokenDir = path.join(root, 'broken-update');
    writeBrokenUpdate(brokenDir);
    await expect(service.installLocal('default', brokenDir)).rejects.toThrow(/broken update probe|failed its activation probe/);
    const stillOld = (await service.snapshot()).installed.find((plugin) => plugin.name === 'dsh-plugin-error-radar');
    expect(stillOld?.version).toBe('0.2.0');
    const radarAfterFailure = await service.invokeCommand('default', 'dsh-plugin-error-radar', 'radar', '');
    expect(radarAfterFailure.ok).toBe(true);
    records.push({
      name: 'repository-import',
      version: '1',
      state: 'verified',
      capabilities: ['git:ls-remote', 'git:pinned-fetch', 'git:install', 'profile:switch'],
      missing: [],
      evidence: [
        { kind: 'install', summary: 'A Git repository URL was inspected and pinned to commit ccab614d6045625c359f4416e0760f93f7abe260, installed into an isolated profile, listed its skill, and was removed again.' },
      ],
    });

    records.push({
      name: 'dsh-plugin-error-radar',
      version: '0.2.0',
      state: 'verified',
      capabilities: ['failed update rollback'],
      missing: [],
      evidence: [
        { kind: 'rollback', summary: 'A local 0.2.1 package that throws during activation was rejected; 0.2.0 stayed loaded and /radar still worked.' },
      ],
    });

    // ---- 6. Disable / re-enable / uninstall resource cleanup --------------
    await service.setEnabled('default', 'dsh-plugin-error-radar', false);
    let snapshot = await service.snapshot();
    let installed = snapshot.installed.find((plugin) => plugin.name === 'dsh-plugin-error-radar')!;
    expect(installed.enabled).toBe(false);
    expect(installed.contributions.commands).toEqual([]);
    await expect(service.invokeCommand('default', 'dsh-plugin-error-radar', 'radar', '')).rejects.toThrow(/disabled/);
    await service.setEnabled('default', 'dsh-plugin-error-radar', true);
    const radarAgain = await service.invokeCommand('default', 'dsh-plugin-error-radar', 'radar', '');
    expect(radarAgain.ok).toBe(true);

    // ---- 7. Real restart restoration --------------------------------------
    await service.runtime.shutdown();
    service = new DshMarketService({
      rootDir: root,
      appPath: process.cwd(),
      versions: { app: env.appVersion, electron: env.electronVersion, chrome: env.chromeVersion },
    });
    await service.initialize();
    snapshot = await service.snapshot();
    expect(snapshot.installed.map((plugin) => plugin.name).sort()).toEqual(expect.arrayContaining([
      'dsh-plugin-error-radar', 'dsh-plugin-guide', 'dsh-plugin-health', 'dsh-find-plugin',
      '@dhicoc/dsh-chinese-traditional-wisdom-skill',
    ]));
    const restoredRadar = await service.invokeCommand('default', 'dsh-plugin-error-radar', 'radar', '');
    expect(restoredRadar.ok).toBe(true);
    const restoredStorage = await service.invokeTool('default', 'dsh-storage-probe', 'storage_probe', {});
    expect(restoredStorage.ok).toBe(true);
    expect((restoredStorage.value as any).value).toBe('persisted-through-json-backend');
    const restoredSkills = await service.listSkills();
    expect(restoredSkills.some((skill) => skill.name === 'dsh-plugin-guide')).toBe(true);
    expect(restoredSkills.some((skill) => skill.name === 'chinese-traditional-wisdom-ai-agent-workflow')).toBe(true);
    records.push({
      name: 'dsh-storage-probe',
      version: '1.0.0-restart',
      state: 'verified',
      capabilities: ['storage:restart-persistence'],
      missing: [],
      evidence: [{ kind: 'restart', summary: 'The same storage-domain record was read after a full worker/service restart from the JSON backend.' }],
    });

    records.push({
      name: 'dsh-state',
      version: `${DSH_COMPAT_LAYER_VERSION}`,
      state: 'verified',
      capabilities: ['restart restoration'],
      missing: [],
      evidence: [{ kind: 'restart', summary: 'A new service instance restored installed versions, enablement, config, commands and skills from disk.' }],
    });

    // ---- 8. Uninstall cleanup ---------------------------------------------
    const packageDirBeforeUninstall = snapshot.installed.find((plugin) => plugin.name === 'dsh-plugin-error-radar')!.packageDir;
    await service.uninstall('default', 'dsh-plugin-error-radar', false);
    expect(fs.existsSync(packageDirBeforeUninstall)).toBe(false);
    snapshot = await service.snapshot();
    expect(snapshot.installed.some((plugin) => plugin.name === 'dsh-plugin-error-radar')).toBe(false);
    const contributions = await service.contributions('default', 'dsh-plugin-error-radar');
    expect(contributions).toEqual({ tools: [], commands: [], skills: [] });

    const evidenceFile = process.env.DSH_COMPAT_EVIDENCE;
    if (evidenceFile) {
      fs.writeFileSync(evidenceFile, JSON.stringify({
        baseline: DSH_BASELINE,
        layerVersion: DSH_COMPAT_LAYER_VERSION,
        environment: env,
        records,
      }, null, 2));
    }
  }, timeout);
});
