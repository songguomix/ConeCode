import { describe, it, expect } from 'vitest';
import { parseSlashInput, matchCommands, findCommand, expandTemplate, BUILTIN_COMMANDS, type SlashCommand } from './commands';

describe('parseSlashInput', () => {
  it('parses a bare command', () => {
    expect(parseSlashInput('/help')).toEqual({ name: 'help', args: '' });
  });
  it('parses a command with arguments', () => {
    expect(parseSlashInput('/commit fix the bug')).toEqual({ name: 'commit', args: 'fix the bug' });
  });
  it('lowercases the command name', () => {
    expect(parseSlashInput('/INIT')?.name).toBe('init');
  });
  it('returns null for non-slash input', () => {
    expect(parseSlashInput('hello')).toBeNull();
    expect(parseSlashInput('a/b')).toBeNull();
  });
});

describe('matchCommands', () => {
  it('filters builtins by prefix', () => {
    const names = matchCommands('c', []).map((c) => c.name);
    expect(names).toContain('clear');
    expect(names).toContain('compact');
    expect(names).toContain('commit');
    expect(names).not.toContain('help');
  });
  it('returns everything for an empty prefix', () => {
    expect(matchCommands('', []).length).toBe(BUILTIN_COMMANDS.length);
  });
  it('includes custom commands', () => {
    const custom: SlashCommand[] = [{ name: 'deploy', description: 'ship it', kind: 'prompt', custom: true }];
    expect(matchCommands('de', custom).map((c) => c.name)).toEqual(['deploy']);
  });
});

describe('findCommand', () => {
  it('finds a builtin and reports its kind', () => {
    expect(findCommand('help', [])?.kind).toBe('client');
    expect(findCommand('init', [])?.kind).toBe('prompt');
  });
  it('is case-insensitive', () => {
    expect(findCommand('HELP', [])?.name).toBe('help');
  });
  it('returns undefined for an unknown command', () => {
    expect(findCommand('nope', [])).toBeUndefined();
  });
});

describe('expandTemplate', () => {
  it('substitutes $ARGUMENTS', () => {
    expect(expandTemplate('do $ARGUMENTS now', 'X')).toBe('do X now');
  });
  it('appends args when there is no placeholder', () => {
    expect(expandTemplate('base', 'extra')).toBe('base\n\nextra');
  });
  it('returns the template unchanged when no args and no placeholder', () => {
    expect(expandTemplate('base', '')).toBe('base');
  });
});
