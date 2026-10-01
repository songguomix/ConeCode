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

  it('falls back to raw text so output is always a prompt', () => {
    const onlyTitle = parseProjectBrief({ choices: [{ message: { content: '{"title":"A"}' } }] });
    expect(onlyTitle.prompt).toContain('{"title":"A"}');
    const onlyPrompt = parseProjectBrief({ choices: [{ message: { content: '{"prompt":"B"}' } }] });
    expect(onlyPrompt.prompt).toContain('{"prompt":"B"}');
    const markdown = parseProjectBrief({ choices: [{ message: { content: '# My App\nBuild it well.' } }] });
    expect(markdown.title).toBe('My App');
    expect(markdown.prompt).toContain('Build it well.');
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

  it('reuses an already-open directory without claiming a fresh README', () => {
    const prompt = projectExecutionPrompt('Build the app.', '/proj/existing', false);
    expect(prompt).toContain('/proj/existing');
    expect(prompt).toMatch(/already open, reuse it/i);
    expect(prompt).toMatch(/Preserve existing user files/i);
  });
});

describe('PROJECT_BRIEF_SYSTEM_PROMPT', () => {
  it('makes README.md a mandatory deliverable', () => {
    expect(PROJECT_BRIEF_SYSTEM_PROMPT).toMatch(/README\.md is mandatory/i);
  });
});
