import { describe, expect, it } from 'vitest';
import {
  applyMigration, migrationSourceHash, planMigration, validateMigration, type MigrationInput,
} from './migration';
import { emptyState } from './storage/interface';

const NOW = 1_800_000_000_000;

function input(overrides: Partial<MigrationInput> = {}): MigrationInput {
  return {
    entries: [
      { id: 'e1', kind: 'workflow', text: 'Always run the test suite before saying a task is done', scope: 'global', hits: 3 },
      { id: 'e2', kind: 'project', text: 'Pure logic lives in src/core', scope: 'project', projectPath: '/repo/a' },
      { id: 'e3', kind: 'project', text: 'Other project secret architecture', scope: 'project', projectPath: '/repo/b' },
    ],
    files: [
      { path: '/home/u/.conecode/CLAUDE.md', scope: 'user', content: '# Rules\n- Prefer small, reviewable changes\n' },
      {
        path: '/repo/a/AGENTS.md',
        scope: 'project',
        content: '# Project\n- Always keep the Electron main process thin\n```ts\nconst notAFact = 1\n```\n- known bug: preview reload races the watcher\n',
      },
    ],
    projectId: 'proj-a',
    projectRootPath: '/repo/a',
    now: NOW,
    makeId: () => 'unused',
    deviceId: 'dev-a',
    sessionId: 'migration',
    backupPath: '/tmp/backup.json',
    ...overrides,
  };
}

describe('legacy memory migration', () => {
  it('maps legacy entries and files into the five-layer model', () => {
    const plan = planMigration(input());
    expect(plan.records.map((r) => r.content)).toContain('Always run the test suite before saying a task is done');
    expect(plan.records.find((r) => r.content === 'Pure logic lives in src/core')?.layer).toBe('project');
    expect(plan.records.find((r) => r.content === 'Prefer small, reviewable changes')?.layer).toBe('global');
    expect(plan.report.skippedOtherProject).toBe(1);
    expect(plan.records.some((r) => r.content.includes('Other project secret'))).toBe(false);
  });

  it('skips fenced code blocks instead of importing code as facts', () => {
    const plan = planMigration(input());
    expect(plan.records.some((r) => r.content.includes('notAFact'))).toBe(false);
  });

  it('verifies completeness before apply and reports missing text', () => {
    const plan = planMigration(input());
    const check = validateMigration(plan, input());
    expect(check.ok).toBe(true);
    expect(check.report.verified).toBe(true);

    const tampered = { ...plan, records: plan.records.filter((r) => !r.content.includes('Pure logic')) };
    const failed = validateMigration(tampered, input());
    expect(failed.ok).toBe(false);
    expect(failed.missing.join(' ')).toContain('Pure logic');
  });

  it('is idempotent: applying twice adds nothing and keeps source hashes', () => {
    const plan = planMigration(input());
    const once = applyMigration(emptyState(), { ...plan, report: validateMigration(plan, input()).report });
    const twice = applyMigration(once, { ...plan, report: validateMigration(plan, input()).report });
    expect(twice.records).toHaveLength(once.records.length);
    expect(twice.migration.sourceHashes).toContain(migrationSourceHash(input()));
    expect(twice.migration.legacyDone).toBe(true);
  });

  it('produces the same ids on a re-run, so another project pass cannot duplicate global rows', () => {
    const first = planMigration(input());
    const second = planMigration(input());
    expect(first.records.map((r) => r.id).sort()).toEqual(second.records.map((r) => r.id).sort());
  });

  it('does not import project rows when no project is open', () => {
    const plan = planMigration(input({ projectId: null, projectRootPath: null }));
    expect(plan.report.skippedNoProject).toBeGreaterThan(0);
    expect(plan.records.every((r) => r.layer === 'global')).toBe(true);
  });

  it('keeps unclassifiable file lines for triage instead of dropping them', () => {
    const plan = planMigration(input({
      files: [{ path: '/repo/a/NOTES.md', scope: 'project', content: '- misc\n- random misc note\n' }],
      entries: [],
    }));
    const triage = plan.records.find((r) => r.needsTriage);
    expect(triage).toBeTruthy();
    expect(triage?.status).toBe('pending');
    expect(plan.report.needsTriage).toBe(1);
  });
});
