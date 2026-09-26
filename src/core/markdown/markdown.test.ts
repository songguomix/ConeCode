import { describe, expect, it } from 'vitest';
import {
  isSafeHttpUrl, parseInline, parseMarkdownBlocks, type MdBlock,
} from './markdown';

describe('parseMarkdownBlocks', () => {
  it('parses paragraphs and preserves soft breaks inside them', () => {
    const blocks = parseMarkdownBlocks('line one\nline two\n\nnext para');
    expect(blocks).toEqual([
      { type: 'p', text: 'line one\nline two' },
      { type: 'p', text: 'next para' },
    ]);
  });

  it('parses headings 1–6', () => {
    const blocks = parseMarkdownBlocks('# H1\n###### H6');
    expect(blocks[0]).toMatchObject({ type: 'heading', level: 1, text: 'H1' });
    expect(blocks[1]).toMatchObject({ type: 'heading', level: 6, text: 'H6' });
  });

  it('parses thematic breaks', () => {
    expect(parseMarkdownBlocks('a\n\n---\n\nb').map((b) => b.type)).toEqual(['p', 'hr', 'p']);
  });

  it('parses nested bullets with depth from indent', () => {
    const blocks = parseMarkdownBlocks('- top\n  - child\n    - grand\n- sibling');
    const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;
    expect(list.items.map((i) => [i.depth, i.text, i.ordered])).toEqual([
      [0, 'top', false],
      [1, 'child', false],
      [2, 'grand', false],
      [0, 'sibling', false],
    ]);
  });

  it('parses task list checkboxes', () => {
    const blocks = parseMarkdownBlocks('- [ ] todo\n- [x] done\n- plain');
    const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;
    expect(list.items.map((i) => i.checked)).toEqual([false, true, null]);
    expect(list.items.map((i) => i.text)).toEqual(['todo', 'done', 'plain']);
  });

  it('parses ordered lists with ordinals', () => {
    const blocks = parseMarkdownBlocks('1. first\n2. second');
    const list = blocks[0] as Extract<MdBlock, { type: 'list' }>;
    expect(list.items.every((i) => i.ordered)).toBe(true);
    expect(list.items.map((i) => i.ordinal)).toEqual([1, 2]);
  });

  it('joins multi-line blockquotes', () => {
    const blocks = parseMarkdownBlocks('> a\n> b\n\n> other');
    expect(blocks[0]).toEqual({ type: 'quote', text: 'a\nb' });
    expect(blocks[1]).toEqual({ type: 'quote', text: 'other' });
  });

  it('parses GFM tables with alignment', () => {
    const md = [
      '| Name | Qty | Note |',
      '|:-----|:---:|-----:|',
      '| a | 1 | x |',
      '| b | 2 | y |',
    ].join('\n');
    const blocks = parseMarkdownBlocks(md);
    expect(blocks[0]).toEqual({
      type: 'table',
      align: ['left', 'center', 'right'],
      header: ['Name', 'Qty', 'Note'],
      rows: [
        ['a', '1', 'x'],
        ['b', '2', 'y'],
      ],
    });
  });

  it('unescapes pipes inside table cells', () => {
    const md = '| a \\| b | c |\n|---|---|\n| d | e |';
    const blocks = parseMarkdownBlocks(md);
    const table = blocks[0] as Extract<MdBlock, { type: 'table' }>;
    expect(table.header[0]).toBe('a | b');
  });

  it('does not treat a plain pipe line as a table without a divider', () => {
    const blocks = parseMarkdownBlocks('a | b');
    expect(blocks[0]?.type).toBe('p');
  });
});

describe('parseInline', () => {
  it('tokenizes code, strong, em, del, and links', () => {
    const tokens = parseInline('use `x` and **bold** and *em* and ~~gone~~ and [t](https://e.com)');
    expect(tokens.map((t) => t.type)).toEqual([
      'text', 'code', 'text', 'strong', 'text', 'em', 'text', 'del', 'text', 'link',
    ]);
  });

  it('treats non-http links as text', () => {
    const tokens = parseInline('[x](javascript:alert(1))');
    expect(tokens.some((t) => t.type === 'link')).toBe(false);
    expect(tokens[0].type).toBe('text');
  });
});

describe('isSafeHttpUrl', () => {
  it('allows only http(s)', () => {
    expect(isSafeHttpUrl('https://a.com')).toBe(true);
    expect(isSafeHttpUrl('HTTP://a.com')).toBe(true);
    expect(isSafeHttpUrl('javascript:alert(1)')).toBe(false);
    expect(isSafeHttpUrl('file:///etc/passwd')).toBe(false);
  });
});
