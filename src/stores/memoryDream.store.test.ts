import { beforeEach, describe, expect, it } from 'vitest';
import { memoryV2ContextBlock, memoryV2WikiBlock, useMemoryV2Store } from './memoryV2.store';

beforeEach(() => {
  useMemoryV2Store.setState({ active: true, contextBlock: '', wikiContext: '' });
});

describe('dream context mounting', () => {
  it('keeps the durable record block separate from the dream wiki', () => {
    useMemoryV2Store.setState({
      contextBlock: '## Memory\n- prefers pnpm',
      wikiContext: '## Dream memory (read-only)\n- [[build]] — how builds work',
    });
    const block = memoryV2ContextBlock();
    expect(block).toContain('prefers pnpm');
    // Dream notes must never ride the system channel: they are mounted on the user channel.
    expect(block).not.toContain('Dream memory');
    expect(memoryV2WikiBlock()).toContain('Dream memory (read-only)');
  });

  it('exposes nothing while Memory 2.0 is inactive', () => {
    useMemoryV2Store.setState({
      active: false,
      contextBlock: 'secret',
      wikiContext: 'dream',
    });
    expect(memoryV2ContextBlock()).toBe('');
    expect(memoryV2WikiBlock()).toBe('');
  });
});
