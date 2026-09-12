import { describe, it, expect } from 'vitest';
import { PROJECT_BRIEF_SYSTEM_PROMPT, parseProjectBrief, projectExecutionPrompt } from './projectBrief';

describe('parseProjectBrief', () => {
  it('parses a clean JSON object', () => {
    const brief = parseProjectBrief({
      choices: [{ message: { content: JSON.stringify({ title: 'Todo App', prompt: 'Build a todo app.' }) } }],
    });
    expect(brief).toEqual({ title: 'Todo App', prompt: 'Build a todo app.' });
  });

  it('strips markdown fences around the JSON', () => {
    const raw = '```json\n{"title":"A","prompt":"B"}\n```';
    expect(parseProjectBrief({ choices: [{ message: { content: raw } }] })).toEqual({ title: 'A', prompt: 'B' });
  });

  it('rejects a missing title or prompt', () => {
    expect(() => parseProjectBrief({ choices: [{ message: { content: '{"title":"A"}' } }] })).toThrow();
    expect(() => parseProjectBrief({ choices: [{ message: { content: '{"prompt":"B"}' } }] })).toThrow();
  });
});

describe('projectExecutionPrompt', () => {
  it('binds the work to the created directory and requires a complete README', () => {
    const prompt = projectExecutionPrompt('Build the app.', '/home/me/ConeCode Projects/todo');
    expect(prompt).toContain('Build the app.');
    expect(prompt).toContain('/home/me/ConeCode Projects/todo');
    expect(prompt).toMatch(/README\.md is already in the directory/i);
    expect(prompt).toMatch(/keep README\.md complete and accurate/i);
    expect(prompt).toMatch(/Replace every placeholder section/i);
  });
});

describe('PROJECT_BRIEF_SYSTEM_PROMPT', () => {
  it('makes README.md a mandatory deliverable', () => {
    expect(PROJECT_BRIEF_SYSTEM_PROMPT).toMatch(/README\.md is mandatory/i);
  });
});
