import { describe, it, expect } from 'vitest';
import {
  parseExtraction,
  mergeMemories,
  isSameMemory,
  looksLikeSecret,
  selectRelevant,
  formatMemoryPrompt,
  MAX_MEMORIES,
  migrateEntry,
  migrateEntries,
  type MemoryEntry,
} from './memory';

let counter = 0;
const makeId = () => `id${counter++}`;

const entry = (e: Partial<MemoryEntry>): MemoryEntry => ({
  id: makeId(), kind: 'workflow', text: 'x', scope: 'global',
  createdAt: 0, updatedAt: 0, hits: 1, ...e,
});

describe('parseExtraction', () => {
  it('reads a clean JSON reply', () => {
    const out = parseExtraction('{"memories":[{"kind":"style","scope":"global","text":"Writes in Chinese; answer in Chinese."}]}');
    expect(out).toEqual([{ kind: 'style', scope: 'global', text: 'Writes in Chinese; answer in Chinese.' }]);
  });

  it('digs the JSON out of a fenced or chatty reply', () => {
    const fenced = parseExtraction('Sure!\n```json\n{"memories":[{"kind":"fact","text":"Uses pnpm"}]}\n```\nHope that helps.');
    expect(fenced).toHaveLength(1);
    expect(fenced[0].text).toBe('Uses pnpm');
  });

  it('returns nothing for unusable output instead of throwing', () => {
    expect(parseExtraction('')).toEqual([]);
    expect(parseExtraction('I could not find anything.')).toEqual([]);
    expect(parseExtraction('{"memories": [broken')).toEqual([]);
    expect(parseExtraction('{"notMemories":[]}')).toEqual([]);
  });

  it('defaults an unknown kind to fact and an unknown scope to global', () => {
    const out = parseExtraction('{"memories":[{"kind":"nonsense","scope":"weird","text":"Prefers tabs"}]}');
    expect(out[0]).toMatchObject({ kind: 'fact', scope: 'global' });
  });

  it('drops secrets and over-long entries', () => {
    const out = parseExtraction(JSON.stringify({
      memories: [
        { kind: 'fact', text: 'Their API key is sk-abcdefghijklmnop123456' },
        { kind: 'fact', text: 'password: hunter2' },
        { kind: 'fact', text: 'a'.repeat(400) },
        { kind: 'fact', text: 'Deploys to Vercel' },
      ],
    }));
    expect(out.map((m) => m.text)).toEqual(['Deploys to Vercel']);
  });
});

describe('looksLikeSecret', () => {
  it('catches common credential shapes', () => {
    expect(looksLikeSecret('sk-1234567890abcdefghij')).toBe(true);
    expect(looksLikeSecret('API_KEY = abc')).toBe(true);
    expect(looksLikeSecret('ghp_abcdefghijklmnopqrstuvwxyz1234')).toBe(true);
    expect(looksLikeSecret('Prefers short answers')).toBe(false);
  });
});

describe('isSameMemory', () => {
  it('collapses restatements of the same fact', () => {
    expect(isSameMemory('Prefers concise answers', 'prefers concise answers.')).toBe(true);
    expect(isSameMemory('Prefers concise answers', 'Prefers concise answers in Chinese')).toBe(true);
  });

  it('keeps genuinely different facts apart', () => {
    expect(isSameMemory('Prefers concise answers', 'Uses pnpm as the package manager')).toBe(false);
  });

  it('does not collapse on a trivially short overlap', () => {
    expect(isSameMemory('uses go', 'uses golang for the backend service')).toBe(false);
  });
});

describe('mergeMemories', () => {
  it('adds a new memory', () => {
    const out = mergeMemories([], [{ kind: 'style', text: 'Answers in Chinese', scope: 'global' }], { makeId });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'style', text: 'Answers in Chinese', hits: 1 });
  });

  it('reinforces instead of duplicating a known fact', () => {
    const existing = [entry({ text: 'Prefers concise answers', hits: 1 })];
    const out = mergeMemories(existing, [{ kind: 'style', text: 'Prefers concise answers.', scope: 'global' }], { makeId });
    expect(out).toHaveLength(1);
    expect(out[0].hits).toBe(2);
  });

  it('keeps the sharper phrasing when reinforcing', () => {
    const existing = [entry({ text: 'Prefers concise answers' })];
    const out = mergeMemories(existing, [{ kind: 'style', text: 'Prefers concise answers with no preamble', scope: 'global' }], { makeId });
    expect(out[0].text).toBe('Prefers concise answers with no preamble');
  });

  it('scopes a project memory to the workspace, and degrades to global without one', () => {
    const scoped = mergeMemories([], [{ kind: 'fact', text: 'Uses vitest here', scope: 'project' }], { projectPath: '/p', makeId });
    expect(scoped[0]).toMatchObject({ scope: 'project', projectPath: '/p' });

    const noProject = mergeMemories([], [{ kind: 'fact', text: 'Uses vitest here', scope: 'project' }], { makeId });
    expect(noProject[0].scope).toBe('global');
  });

  it('keeps the same text separate per project', () => {
    const existing = [entry({ text: 'Uses vitest', scope: 'project', projectPath: '/a' })];
    const out = mergeMemories(existing, [{ kind: 'fact', text: 'Uses vitest', scope: 'project' }], { projectPath: '/b', makeId });
    expect(out).toHaveLength(2);
  });

  it('caps growth by dropping the least reinforced', () => {
    const existing = Array.from({ length: MAX_MEMORIES }, (_, i) =>
      entry({ text: `fact number ${i}`, hits: i === 0 ? 1 : 5 }),
    );
    const out = mergeMemories(existing, [{ kind: 'fact', text: 'a brand new durable fact', scope: 'global' }], { makeId });
    expect(out).toHaveLength(MAX_MEMORIES);
    expect(out.some((e) => e.text === 'fact number 0')).toBe(false); // weakest pruned
  });
});

describe('selectRelevant', () => {
  const entries = [
    entry({ text: 'global one', scope: 'global', hits: 1 }),
    entry({ text: 'project A', scope: 'project', projectPath: '/a', hits: 9 }),
    entry({ text: 'project B', scope: 'project', projectPath: '/b' }),
  ];

  it('returns global plus the current project, most reinforced first', () => {
    const out = selectRelevant(entries, '/a');
    expect(out.map((e) => e.text)).toEqual(['project A', 'global one']);
  });

  it('returns only global memories with no workspace open', () => {
    expect(selectRelevant(entries, null).map((e) => e.text)).toEqual(['global one']);
  });
});

describe('formatMemoryPrompt', () => {
  it('groups by kind, and code problems come before tone', () => {
    // Ordering is deliberate: the sections that change what the assistant DOES
    // are read first, and tone last. See the ordering test further down.
    const text = formatMemoryPrompt([
      entry({ kind: 'style', text: 'Writes in Chinese' }),
      entry({ kind: 'codeIssue', text: 'Often forgets null checks' }),
    ]);
    expect(text.indexOf('Often forgets null checks')).toBeLessThan(text.indexOf('Writes in Chinese'));
    expect(text).toContain('communicate');
    expect(text).toContain('Recurring problems');
  });

  it('costs nothing when there is no memory', () => {
    expect(formatMemoryPrompt([])).toBe('');
  });
});

describe('migrating memory written before workflow/project existed', () => {
  // Memory is persisted as plain JSON, so entries recorded under the old kinds
  // are still on disk. An unmigrated one would land under a heading that no
  // longer exists and silently vanish from the prompt.
  it('turns the old preference catch-all into a workflow rule', () => {
    const migrated = migrateEntry({ id: 'a', kind: 'preference', text: 'Wants a plan first', scope: 'global', hits: 3 });
    expect(migrated?.kind).toBe('workflow');
    expect(migrated?.hits).toBe(3);
  });

  it('promotes a project-scoped fact to a project memory', () => {
    const migrated = migrateEntry({ kind: 'fact', text: 'Uses pnpm', scope: 'project', projectPath: '/p' });
    expect(migrated?.kind).toBe('project');
    expect(migrated?.projectPath).toBe('/p');
  });

  it('leaves a global fact as a fact', () => {
    expect(migrateEntry({ kind: 'fact', text: 'Ships on Fridays', scope: 'global' })?.kind).toBe('fact');
  });

  it('keeps the kinds that did not change', () => {
    expect(migrateEntry({ kind: 'style', text: 'Writes Chinese', scope: 'global' })?.kind).toBe('style');
    expect(migrateEntry({ kind: 'codeIssue', text: 'Misses deps arrays', scope: 'global' })?.kind).toBe('codeIssue');
  });

  it('backfills what an old entry never stored', () => {
    const migrated = migrateEntry({ kind: 'style', text: 'Terse', scope: 'global' });
    expect(migrated?.id).toBeTruthy();
    expect(migrated?.hits).toBe(1);
    expect(migrated?.createdAt).toBeGreaterThan(0);
  });

  it('drops entries with nothing readable in them', () => {
    expect(migrateEntry({ kind: 'style', scope: 'global' })).toBeNull();
    expect(migrateEntry({ text: '   ' })).toBeNull();
    expect(migrateEntry(null)).toBeNull();
  });

  it('falls back to fact for a kind it has never heard of', () => {
    expect(migrateEntry({ kind: 'astrology', text: 'Mercury retrograde', scope: 'global' })?.kind).toBe('fact');
  });

  it('migrates a whole stored list and skips the unreadable ones', () => {
    const out = migrateEntries([
      { kind: 'preference', text: 'Plan first', scope: 'global' },
      null,
      { kind: 'fact', text: 'Vite project', scope: 'project', projectPath: '/p' },
      { text: '' },
    ]);
    expect(out.map((e) => e.kind)).toEqual(['workflow', 'project']);
  });

  it('returns nothing for a store that is not a list', () => {
    expect(migrateEntries(undefined)).toEqual([]);
    expect(migrateEntries({} as any)).toEqual([]);
  });
});

describe('the reason a memory was learned', () => {
  it('is parsed off the extraction', () => {
    const out = parseExtraction(JSON.stringify({
      memories: [{ kind: 'workflow', scope: 'global', text: 'Run tests before saying done', why: 'a claim turned out untested' }],
    }));
    expect(out[0].why).toBe('a claim turned out untested');
  });

  it('is dropped when it would leak a secret', () => {
    const out = parseExtraction(JSON.stringify({
      memories: [{ kind: 'workflow', scope: 'global', text: 'Deploy nightly', why: 'api_key: sk-abcdefghijklmnop123' }],
    }));
    expect(out[0].text).toBe('Deploy nightly');
    expect(out[0].why).toBeUndefined();
  });

  it('is filled in later when the same rule is seen again with a reason', () => {
    const existing = [entry({ kind: 'workflow', text: 'Run tests before saying done' })];
    const merged = mergeMemories(existing, [
      { kind: 'workflow', scope: 'global', text: 'Run tests before saying done', why: 'was asked twice' },
    ], { makeId });
    expect(merged).toHaveLength(1);
    expect(merged[0].why).toBe('was asked twice');
    expect(merged[0].hits).toBe(2);
  });

  it('reaches the prompt, so a stale rule can be recognised as stale', () => {
    const block = formatMemoryPrompt([
      entry({ kind: 'workflow', text: 'Rebuild before packaging', why: 'a stale dmg shipped once' }),
    ]);
    expect(block).toContain('- Rebuild before packaging');
    expect(block).toContain('(learned: a stale dmg shipped once)');
    expect(block).toContain('no longer holds');
  });
});

describe('formatMemoryPrompt ordering', () => {
  it('puts workflow and project ahead of tone, because they change what gets done', () => {
    const block = formatMemoryPrompt([
      entry({ kind: 'style', text: 'Answer in Chinese' }),
      entry({ kind: 'fact', text: 'Ships on Fridays' }),
      entry({ kind: 'project', text: 'Pure logic lives in src/core', scope: 'project', projectPath: '/p' }),
      entry({ kind: 'workflow', text: 'Run the tests first' }),
    ]);
    const at = (needle: string) => block.indexOf(needle);
    expect(at('HOW THIS USER WANTS WORK DONE')).toBeLessThan(at('ABOUT THIS PROJECT'));
    expect(at('ABOUT THIS PROJECT')).toBeLessThan(at('How they communicate'));
    expect(at('How they communicate')).toBeLessThan(at('Durable facts'));
  });

  it('says nothing at all when there is nothing learned', () => {
    expect(formatMemoryPrompt([])).toBe('');
  });
});

describe('project memories are pinned to a project', () => {
  it('is scoped to the project even if the model said global', () => {
    const out = parseExtraction(JSON.stringify({
      memories: [{ kind: 'project', scope: 'global', text: 'Tests live beside the source' }],
    }));
    expect(out[0].scope).toBe('project');
  });

  it('only surfaces inside its own project', () => {
    const entries = [
      entry({ kind: 'project', text: 'Uses pnpm', scope: 'project', projectPath: '/a' }),
      entry({ kind: 'project', text: 'Uses yarn', scope: 'project', projectPath: '/b' }),
      entry({ kind: 'workflow', text: 'Plan first' }),
    ];
    expect(selectRelevant(entries, '/a').map((e) => e.text)).toEqual(['Uses pnpm', 'Plan first']);
    expect(selectRelevant(entries, null).map((e) => e.text)).toEqual(['Plan first']);
  });
});
