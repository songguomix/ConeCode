import { describe, expect, it } from 'vitest';
import { outputErrors, errorPrompt } from './output';

describe('output diagnostics', () => {
  it('deduplicates errors without treating all stderr progress as failure', () => {
    expect(outputErrors([
      { stream: 'stderr', data: 'installing dependencies' },
      { stream: 'console', level: 'error', data: 'TypeError: broken' },
      { stream: 'stderr', data: 'Error: build failed' },
      { stream: 'console', level: 'error', data: 'TypeError: broken' },
    ])).toEqual(['TypeError: broken', 'Error: build failed']);
  });
  it('keeps selected errors and bounded surrounding output in the prompt', () => {
    const prompt = errorPrompt('Please diagnose', ['Error: build failed'], [{ stream: 'stdout', data: 'x'.repeat(20000) }]);
    expect(prompt).toContain('Error: build failed');
    expect(prompt.length).toBeLessThan(13000);
  });
});
