import { describe, it, expect } from 'vitest';
import {
  parseSuggestions,
  buildScanBriefing,
  rankTasks,
  recoverOpenTodos,
  buildResumePrompt,
  buildNewProjectPrompt,
  MAX_TASKS,
  recommendNext,
  type WorkspaceScan,
} from './agenda';

let n = 0;
const makeId = () => `t${n++}`;

const scan = (over: Partial<WorkspaceScan> = {}): WorkspaceScan => ({
  rootPath: '/proj', scannedAt: 0,
  git: { isRepo: true, branch: 'main', dirty: 2 },
  statusText: 'M src/a.ts', diffText: '- old\n+ new',
  todoComments: [{ file: 'src/a.ts', line: 12, text: '// TODO: handle the empty case' }],
  scripts: ['test', 'build'], projectName: 'demo', readmeHead: '# demo',
  hasTests: true, fileCount: 42, languages: ['TypeScript'],
  ...over,
});

const task = (over: Record<string, any> = {}) => ({
  title: 'Fix the thing', rationale: 'because TODO', kind: 'bug',
  effort: 'quick', risk: 'low', files: ['src/a.ts'], prompt: 'Go fix it and run npm test.',
  ...over,
});

describe('parseSuggestions', () => {
  it('parses a well-formed task list', () => {
    const out = parseSuggestions(JSON.stringify({ tasks: [task()] }), makeId);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      title: 'Fix the thing', kind: 'bug', effort: 'quick', risk: 'low', files: ['src/a.ts'],
    });
  });

  it('digs the JSON out of fences and prose', () => {
    const raw = 'Here you go:\n```json\n' + JSON.stringify({ tasks: [task()] }) + '\n```\nEnjoy!';
    expect(parseSuggestions(raw, makeId)).toHaveLength(1);
  });

  it('drops tasks that cannot be acted on', () => {
    // No title = nothing to show; no prompt = nothing to run when clicked.
    const out = parseSuggestions(JSON.stringify({
      tasks: [task({ title: '' }), task({ prompt: '' }), task({ title: 'Keep me' })],
    }), makeId);
    expect(out.map((x) => x.title)).toEqual(['Keep me']);
  });

  it('drops duplicate titles', () => {
    const out = parseSuggestions(JSON.stringify({
      tasks: [task({ title: 'Same thing' }), task({ title: 'same THING' })],
    }), makeId);
    expect(out).toHaveLength(1);
  });

  it('falls back to safe values for unknown enums', () => {
    const out = parseSuggestions(JSON.stringify({ tasks: [task({ kind: 'nope', effort: 'huge', risk: 'nuclear' })] }), makeId);
    expect(out[0]).toMatchObject({ kind: 'chore', effort: 'medium', risk: 'low' });
  });

  it('caps the number of tasks', () => {
    const many = Array.from({ length: 20 }, (_, i) => task({ title: `Task ${i}` }));
    expect(parseSuggestions(JSON.stringify({ tasks: many }), makeId)).toHaveLength(MAX_TASKS);
  });

  it('returns nothing for unusable output', () => {
    expect(parseSuggestions('', makeId)).toEqual([]);
    expect(parseSuggestions('I could not find any work.', makeId)).toEqual([]);
    expect(parseSuggestions('{"tasks": [broken', makeId)).toEqual([]);
    expect(parseSuggestions(JSON.stringify({ other: [] }), makeId)).toEqual([]);
  });
});

describe('buildScanBriefing', () => {
  it('includes the facts a proposal must be grounded in', () => {
    const text = buildScanBriefing(scan());
    expect(text).toContain('demo');
    expect(text).toContain('branch main');
    expect(text).toContain('2 uncommitted');
    expect(text).toContain('npm scripts: test, build');
    expect(text).toContain('src/a.ts:12');
    expect(text).toContain('TODO: handle the empty case');
  });

  it('states plainly when there is no git and no tests', () => {
    const text = buildScanBriefing(scan({ git: { isRepo: false, branch: null, dirty: 0 }, hasTests: false, todoComments: [] }));
    expect(text).toContain('not a repository');
    expect(text).toContain('Tests present: no');
  });
});

describe('rankTasks', () => {
  it('puts bugs before features, and cheap before expensive', () => {
    const ranked = rankTasks([
      { ...task({ title: 'big feature', kind: 'feature', effort: 'large' }), id: 'a' } as any,
      { ...task({ title: 'quick bug', kind: 'bug', effort: 'quick' }), id: 'b' } as any,
      { ...task({ title: 'slow bug', kind: 'bug', effort: 'large' }), id: 'c' } as any,
    ]);
    expect(ranked.map((r) => r.title)).toEqual(['quick bug', 'slow bug', 'big feature']);
  });
});

describe('recoverOpenTodos', () => {
  it('recovers unfinished items from a fenced update_todos action', () => {
    const content = '```json\n' + JSON.stringify({
      action: 'update_todos',
      todos: [
        { content: 'done thing', status: 'completed' },
        { content: 'current thing', status: 'in_progress' },
        { content: 'later thing', status: 'pending' },
      ],
    }) + '\n```';
    expect(recoverOpenTodos([{ role: 'assistant', content }]))
      .toEqual(['current thing', 'later thing']);
  });

  it('recovers them from a native tool call blob too', () => {
    const content = 'update_todos {"todos":[{"content":"open one","status":"pending"}]}';
    expect(recoverOpenTodos([{ role: 'assistant', content }])).toEqual(['open one']);
  });

  it('uses the most recent checklist', () => {
    const older = '```json\n{"action":"update_todos","todos":[{"content":"old","status":"pending"}]}\n```';
    const newer = '```json\n{"action":"update_todos","todos":[{"content":"new","status":"pending"}]}\n```';
    expect(recoverOpenTodos([
      { role: 'assistant', content: older },
      { role: 'assistant', content: newer },
    ])).toEqual(['new']);
  });

  it('returns nothing when the conversation never had a checklist', () => {
    expect(recoverOpenTodos([{ role: 'user', content: 'hello' }])).toEqual([]);
  });
});

describe('buildResumePrompt', () => {
  it('tells the agent to re-read the code before trusting the transcript', () => {
    const prompt = buildResumePrompt({
      conversationId: 'c', title: 'x', updatedAt: 0, lastMessage: '',
      openTodos: ['finish the parser'], pendingChanges: 2,
    });
    expect(prompt).toContain('re-read');
    expect(prompt).toContain('finish the parser');
    expect(prompt).toContain('2 proposed change');
  });

  it('omits the sections that do not apply', () => {
    const prompt = buildResumePrompt({
      conversationId: 'c', title: 'x', updatedAt: 0, lastMessage: '', openTodos: [], pendingChanges: 0,
    });
    expect(prompt).not.toContain('Still open');
    expect(prompt).not.toContain('proposed change');
  });
});

describe('buildNewProjectPrompt', () => {
  it('demands working code, a test, and a stop if the directory is occupied', () => {
    const prompt = buildNewProjectPrompt('a todo CLI', '/tmp/new');
    expect(prompt).toContain('a todo CLI');
    expect(prompt).toContain('/tmp/new');
    expect(prompt).toContain('not placeholders');
    expect(prompt).toContain('stop and ask me');
  });
});

describe('recommendNext', () => {
  const base = { hasFolder: true, dirty: 0, hasTests: true, openTodos: 0 };

  it('asks for a project when there is none', () => {
    expect(recommendNext({ ...base, hasFolder: false }).kind).toBe('start');
  });

  it('puts unfinished work above everything else', () => {
    // Half-done work outranks even uncommitted changes and a found task.
    const rec = recommendNext({ ...base, openTodos: 2, dirty: 5, topTask: 'Fix the parser' });
    expect(rec).toMatchObject({ kind: 'resume', detail: '2' });
  });

  it('then uncommitted changes', () => {
    expect(recommendNext({ ...base, dirty: 3, topTask: 'Fix the parser' }))
      .toMatchObject({ kind: 'review', detail: '3' });
  });

  it('then the best task it found', () => {
    expect(recommendNext({ ...base, topTask: 'Fix the parser' }))
      .toMatchObject({ kind: 'task', detail: 'Fix the parser' });
  });

  it('then getting a test suite at all', () => {
    expect(recommendNext({ ...base, hasTests: false }).kind).toBe('tests');
  });

  it('falls back to starting something new on a clean, healthy project', () => {
    expect(recommendNext(base).kind).toBe('start');
  });
});
