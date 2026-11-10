import { beforeEach, describe, expect, it } from 'vitest';
import { memoryV2ContextBlock, useMemoryV2Store } from './memoryV2.store';

beforeEach(() => {
  useMemoryV2Store.setState({ active: true, contextBlock: '', wikiContext: '' });
});

describe('dream context mounting', () => {
  it('mounts the read-only dream wiki after the memory block', () => {
    useMemoryV2Store.setState({
      contextBlock: '## Memory\n- prefers pnpm',
      wikiContext: '## Dream memory (read-only)\n- [[build]] — how builds work',
    });
    const block = memoryV2ContextBlock();
    expect(block).toContain('prefers pnpm');
    expect(block).toContain('Dream memory (read-only)');
    expect(block.indexOf('prefers pnpm')).toBeLessThan(block.indexOf('Dream memory'));
  });

  it('exposes nothing while Memory 2.0 is inactive', () => {
    useMemoryV2Store.setState({
      active: false,
      contextBlock: 'secret',
      wikiContext: 'dream',
    });
    expect(memoryV2ContextBlock()).toBe('');
  });
});
