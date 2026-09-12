import { describe, it, expect } from 'vitest';
import { PICK_PREFIX, parsePick, pickToPrompt, pickerScript } from './picker';

describe('parsePick', () => {
  const payload = { selector: 'main > h1', tag: 'h1', text: 'Hello', html: '<h1>Hello</h1>' };

  it('reads the picker\'s answer off the console channel', () => {
    expect(parsePick(PICK_PREFIX + JSON.stringify(payload))).toEqual(payload);
  });

  it('ignores the ordinary page logging that shares the channel', () => {
    expect(parsePick('[vite] connected.')).toBeNull();
    expect(parsePick('')).toBeNull();
  });

  it('does not throw on a line that only looks like an answer', () => {
    expect(parsePick(PICK_PREFIX + 'not json')).toBeNull();
    expect(parsePick(PICK_PREFIX + '"a string"')).toBeNull();
    expect(parsePick(PICK_PREFIX + 'null')).toBeNull();
  });

  it('coerces whatever the page put in the fields to strings', () => {
    // The guest is untrusted: the payload is data, never something to trust as-is.
    const parsed = parsePick(PICK_PREFIX + JSON.stringify({ selector: 42, tag: null, text: {}, html: [1] }));
    expect(parsed).toEqual({ selector: '42', tag: '', text: '[object Object]', html: '1' });
  });
});

describe('pickToPrompt', () => {
  it('writes the element up as a message the user can send', () => {
    const prompt = pickToPrompt(
      { selector: 'main > h1', tag: 'h1', text: 'Hello', html: '<h1>Hello</h1>' },
      'About this element:',
    );
    expect(prompt).toContain('About this element: `main > h1`');
    expect(prompt).toContain('> Hello');
    expect(prompt).toContain('```html\n<h1>Hello</h1>\n```');
  });

  it('collapses runaway whitespace in the quoted text', () => {
    const prompt = pickToPrompt({ selector: 'p', tag: 'p', text: 'a\n\n   b', html: '' }, 'X:');
    expect(prompt).toContain('> a b');
  });

  it('falls back to the tag when no selector could be built', () => {
    expect(pickToPrompt({ selector: '', tag: 'button', text: '', html: '' }, 'X:')).toContain('X: `button`');
  });
});

describe('pickerScript', () => {
  it('carries the accent colour into the page it is injected in', () => {
    expect(pickerScript('#C96442')).toContain('#C96442');
  });

  it('answers on the prefix the host listens for', () => {
    expect(pickerScript('#000')).toContain(JSON.stringify(PICK_PREFIX));
  });

  it('is a single expression, so executeJavaScript can evaluate it', () => {
    expect(() => new Function(`return ${pickerScript('#000')}`)).not.toThrow();
  });
});
