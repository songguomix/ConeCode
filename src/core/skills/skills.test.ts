import { describe, it, expect } from 'vitest';
import {
  parseSkill,
  serializeSkill,
  formatSkillsPrompt,
  mergeSkills,
  skillId,
  isSafeSkillId,
  validateDraft,
  draftHasErrors,
  draftFromMarkdown,
  SKILL_FILE,
} from './skills';
import { BUILTIN_SKILLS, findBuiltin } from './builtin';

describe('parseSkill', () => {
  it('reads frontmatter and body', () => {
    const skill = parseSkill(`---
name: Code Review
description: Review a diff for real defects.
tags: quality, review
version: 1.2
---

# Code Review

Look for correctness first.`);

    expect(skill).toMatchObject({
      id: 'code-review',
      name: 'Code Review',
      description: 'Review a diff for real defects.',
      tags: ['quality', 'review'],
      version: '1.2',
    });
    expect(skill!.body).toContain('Look for correctness first.');
    expect(skill!.body).not.toContain('---'); // frontmatter is stripped
  });

  it('strips quotes around values', () => {
    const skill = parseSkill(`---\nname: "Quoted Name"\ndescription: 'single'\n---\nbody`);
    expect(skill!.name).toBe('Quoted Name');
    expect(skill!.description).toBe('single');
  });

  it('falls back to the first heading when frontmatter has no name', () => {
    const skill = parseSkill('# Debugging Guide\n\nReproduce first.');
    expect(skill!.name).toBe('Debugging Guide');
    expect(skill!.id).toBe('debugging-guide');
    // ...and to the first real paragraph for the description.
    expect(skill!.description).toBe('Reproduce first.');
  });

  it('uses the folder name when the file says nothing', () => {
    const skill = parseSkill('some instructions', { id: 'my-skill', name: 'my-skill' });
    expect(skill!.id).toBe('my-skill');
  });

  it('returns null when there is no usable name at all', () => {
    expect(parseSkill('')).toBeNull();
    expect(parseSkill('   \n  ')).toBeNull();
  });

  it('caps an overlong description so the prompt block stays small', () => {
    const skill = parseSkill(`---\nname: X\ndescription: ${'a'.repeat(500)}\n---\nbody`);
    expect(skill!.description.length).toBeLessThanOrEqual(200);
  });

  it('survives CRLF files', () => {
    const skill = parseSkill('---\r\nname: Windows Skill\r\ndescription: d\r\n---\r\n\r\nbody here');
    expect(skill!.name).toBe('Windows Skill');
    expect(skill!.body).toBe('body here');
  });

  it('defaults to enabled and reads an explicit disabled state', () => {
    expect(parseSkill('---\nname: On\ndescription: d\n---\nbody')!.enabled).toBe(true);
    expect(parseSkill('---\nname: Off\ndescription: d\nenabled: false\n---\nbody')!.enabled).toBe(false);
  });
});

describe('serializeSkill', () => {
  it('round-trips through parse', () => {
    const original = {
      name: 'My Skill', description: 'Does a thing.', tags: ['a', 'b'], body: '# My Skill\n\nDo it.',
    };
    const reparsed = parseSkill(serializeSkill(original as any));
    expect(reparsed).toMatchObject({ name: 'My Skill', description: 'Does a thing.', tags: ['a', 'b'] });
    expect(reparsed!.body).toContain('Do it.');
  });

  it('persists disabled skills without adding noise to enabled files', () => {
    const base = { name: 'Toggle', description: 'Can be toggled.', body: 'Follow these detailed instructions.' };
    const disabled = serializeSkill({ ...base, enabled: false });
    expect(disabled).toContain('enabled: false');
    expect(parseSkill(disabled)!.enabled).toBe(false);
    expect(serializeSkill({ ...base, enabled: true })).not.toContain('enabled:');
  });
});

describe('skill ids', () => {
  it('makes a folder- and tool-safe id', () => {
    expect(skillId('Code Review')).toBe('code-review');
    expect(skillId('  Weird!! Name?? ')).toBe('weird-name');
    expect(skillId('')).toBe('skill');
  });

  it('gives non-Latin names distinct deterministic ids', () => {
    const first = skillId('本项目代码规范');
    const second = skillId('测试规范');
    expect(first).toBe(skillId('本项目代码规范'));
    expect(first).not.toBe(second);
    expect(first).toMatch(/^skill-/);
    expect(skillId('React 规范')).toMatch(/^react-/);
    expect(isSafeSkillId(first)).toBe(true);
    expect(isSafeSkillId(second)).toBe(true);
  });

  it('rejects anything that could escape the skills directory', () => {
    expect(isSafeSkillId('code-review')).toBe(true);
    expect(isSafeSkillId('../../etc/passwd')).toBe(false);
    expect(isSafeSkillId('..')).toBe(false);
    expect(isSafeSkillId('/absolute')).toBe(false);
    expect(isSafeSkillId('has space')).toBe(false);
    expect(isSafeSkillId('')).toBe(false);
  });
});

describe('mergeSkills', () => {
  const g = (id: string) => ({ id, name: id, description: 'global one', tags: [], scope: 'global' as const, source: 'custom' as const });
  const p = (id: string) => ({ id, name: id, description: 'project one', tags: [], scope: 'project' as const, source: 'custom' as const });

  it('lets a project skill shadow the global one with the same id', () => {
    const merged = mergeSkills([g('review')], [p('review')]);
    expect(merged).toHaveLength(1);
    expect(merged[0]).toMatchObject({ scope: 'project', description: 'project one' });
  });

  it('keeps skills that exist in only one scope', () => {
    const merged = mergeSkills([g('a')], [p('b')]);
    expect(merged.map((s) => s.id).sort()).toEqual(['a', 'b']);
  });
});

describe('formatSkillsPrompt', () => {
  it('lists ids and descriptions only — never the bodies', () => {
    const text = formatSkillsPrompt([
      { id: 'code-review', name: 'Code Review', description: 'Review a diff.', tags: [], scope: 'global', source: 'builtin' },
    ]);
    expect(text).toContain('code-review: Review a diff.');
    expect(text).toContain('use_skill');
    // The whole point: bodies stay out of the prompt until asked for.
    expect(text.length).toBeLessThan(600);
  });

  it('costs nothing when no skills are installed', () => {
    expect(formatSkillsPrompt([])).toBe('');
  });

  it('does not advertise disabled skills', () => {
    expect(formatSkillsPrompt([
      { id: 'off', name: 'Off', description: 'Do not show.', tags: [], scope: 'global', source: 'custom', enabled: false },
    ])).toBe('');
  });
});

describe('the built-in library', () => {
  it('ships skills that parse, install and load', () => {
    expect(BUILTIN_SKILLS.length).toBeGreaterThanOrEqual(6);
    for (const skill of BUILTIN_SKILLS) {
      expect(isSafeSkillId(skill.id), skill.id).toBe(true);
      expect(skill.description.length).toBeGreaterThan(20);
      // Every catalogue entry must survive the write→read round trip.
      const reparsed = parseSkill(serializeSkill(skill as any), { id: skill.id, scope: 'global' });
      expect(reparsed, skill.id).not.toBeNull();
      expect(reparsed!.id).toBe(skill.id);
      expect(reparsed!.body.length).toBeGreaterThan(100);
    }
  });

  it('has unique ids', () => {
    const ids = BUILTIN_SKILLS.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('tells the model WHEN to use each skill, not just what it is', () => {
    for (const skill of BUILTIN_SKILLS) {
      expect(skill.description.toLowerCase(), skill.id).toContain('use when');
    }
  });

  it('can be looked up by id', () => {
    expect(findBuiltin('code-review')?.name).toBe('Code Review');
    expect(findBuiltin('nope')).toBeUndefined();
  });
});

describe('the on-disk contract', () => {
  it('uses the conventional filename', () => {
    expect(SKILL_FILE).toBe('SKILL.md');
  });
});

describe('custom skill provenance', () => {
  it('marks a hand-written SKILL.md as custom, never as reviewed', () => {
    // Anything without an explicit builtin stamp is user-authored.
    expect(parseSkill('---\nname: Mine\ndescription: d\n---\nbody')!.source).toBe('custom');
    expect(parseSkill('# Mine\n\nSome body')!.source).toBe('custom');
  });

  it('cannot be forged into builtin by omission', () => {
    const custom = parseSkill(serializeSkill({ name: 'Mine', description: 'd', body: 'b', source: 'custom' } as any));
    expect(custom!.source).toBe('custom');
  });

  it('preserves the builtin stamp for library installs', () => {
    const builtin = parseSkill(serializeSkill({ name: 'Review', description: 'd', body: 'b', source: 'builtin' } as any));
    expect(builtin!.source).toBe('builtin');
  });
});

describe('validateDraft', () => {
  const ok = { name: 'House Style', description: 'Use before writing code here.', body: 'Always use tabs and never use var.' };

  it('accepts a complete draft', () => {
    expect(draftHasErrors(validateDraft(ok))).toBe(false);
  });

  it('requires a name that yields a safe id', () => {
    expect(validateDraft({ ...ok, name: '' }).name).toBe('required');
    expect(validateDraft({ ...ok, name: '   ' }).name).toBe('required');
  });

  it('requires a description — without one the model can never pick the skill', () => {
    expect(validateDraft({ ...ok, description: '' }).description).toBe('required');
    expect(validateDraft({ ...ok, description: 'a'.repeat(300) }).description).toBe('tooLong');
  });

  it('requires actual instructions', () => {
    expect(validateDraft({ ...ok, body: '' }).body).toBe('required');
    expect(validateDraft({ ...ok, body: 'short' }).body).toBe('tooShort');
  });
});

describe('draftFromMarkdown', () => {
  it('loads an imported file into the editor', () => {
    const draft = draftFromMarkdown('---\nname: Imported\ndescription: From elsewhere.\n---\n\nDo the thing carefully.');
    expect(draft).toMatchObject({ name: 'Imported', description: 'From elsewhere.' });
    expect(draft!.body).toContain('Do the thing carefully.');
  });

  it('returns null for something that is not a skill', () => {
    expect(draftFromMarkdown('')).toBeNull();
    expect(draftFromMarkdown('   ')).toBeNull();
  });
});
