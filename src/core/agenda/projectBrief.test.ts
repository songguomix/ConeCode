import { describe, it, expect } from 'vitest';
import {
  BRIEF_CEILING_OUTPUT_TOKENS, BRIEF_FLOOR_OUTPUT_TOKENS, PROJECT_BRIEF_SYSTEM_PROMPT,
  briefFinishReason, briefHasText, briefMaxTokens, parseProjectBrief, projectExecutionPrompt,
} from './projectBrief';

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

  it('never promotes truncated reasoning into a prompt', () => {
    const result = {
      choices: [{ message: { content: '', reasoning_content: 'The user wants a todo app and I should' }, finish_reason: 'length' }],
    };
    expect(() => parseProjectBrief(result)).toThrow('EMPTY_TRUNCATED');
    expect(() => parseProjectBrief(result, { finishReason: 'length' })).toThrow('EMPTY_TRUNCATED');
  });

  it('promotes reasoning_content when content is empty (reasoning-only models)', () => {
    const raw = JSON.stringify({ title: 'Todo App', prompt: 'Build a todo app.' });
    expect(parseProjectBrief({ choices: [{ message: { content: '', reasoning_content: raw } }] }))
      .toEqual({ title: 'Todo App', prompt: 'Build a todo app.' });
    expect(parseProjectBrief({ choices: [{ message: { content: '   ', reasoning_content: '# My App\nBuild it well.' } }] }).title)
      .toBe('My App');
  });
});

describe('briefMaxTokens', () => {
  it('keeps enough room for hidden reasoning', () => {
    // The old fixed 4096 let DeepSeek Flash spend every token thinking.
    expect(briefMaxTokens(undefined)).toBe(BRIEF_FLOOR_OUTPUT_TOKENS);
    expect(briefMaxTokens({ maxOutputTokens: 8192 })).toBe(8192);
    expect(briefMaxTokens({ maxOutputTokens: 128000 })).toBe(BRIEF_CEILING_OUTPUT_TOKENS);
    expect(briefMaxTokens({ maxOutputTokens: 16000 })).toBe(16000);
  });

  it('respects a declared limit below the floor', () => {
    expect(briefMaxTokens({ maxOutputTokens: 2048 })).toBe(2048);
  });
});

describe('briefFinishReason', () => {
  it('normalises every provider shape to the OpenAI name', () => {
    expect(briefFinishReason({ choices: [{ finish_reason: 'length' }] })).toBe('length');
    expect(briefFinishReason({ finish_reason: 'length' })).toBe('length');
    expect(briefFinishReason({ candidates: [{ finishReason: 'MAX_TOKENS' }] })).toBe('length');
    expect(briefFinishReason({ candidates: [{ finishReason: 'STOP' }] })).toBe('STOP');
  });
});

describe('briefHasText', () => {
  it('sees text in any adapter shape', () => {
    expect(briefHasText({ choices: [{ message: { content: 'hi' } }] })).toBe(true);
    expect(briefHasText({ content: [{ type: 'text', text: 'hi' }] })).toBe(true);
    expect(briefHasText({ candidates: [{ content: { parts: [{ text: 'hi' }] } }] })).toBe(true);
    expect(briefHasText({ choices: [{ message: { content: '' } }] })).toBe(false);
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
