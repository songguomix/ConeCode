import { describe, expect, it } from 'vitest';
import { buildToolset, CHAT_MODE_TOOLS, PLAN_MODE_TOOLS, validateToolArgs } from './definitions';

describe('memory_search tool', () => {
  it('is available in normal and plan mode but not in chat-only mode', () => {
    expect(buildToolset().some((tool) => tool.name === 'memory_search')).toBe(true);
    expect(buildToolset({ planMode: true }).some((tool) => tool.name === 'memory_search')).toBe(true);
    expect(buildToolset({ isChatMode: true }).some((tool) => tool.name === 'memory_search')).toBe(false);
    expect(PLAN_MODE_TOOLS.has('memory_search')).toBe(true);
    expect(CHAT_MODE_TOOLS.has('memory_search')).toBe(false);
  });

  it('validates query, scope and layer enums', () => {
    expect(validateToolArgs('memory_search', { query: 'timeout bug' })).toBeNull();
    expect(validateToolArgs('memory_search', { query: 'timeout bug', scope: 'project', layers: ['episodic'] })).toBeNull();
    expect(validateToolArgs('memory_search', {})).toContain('query');
    expect(validateToolArgs('memory_search', { query: 'x', scope: 'other' })).toContain('one of');
    expect(validateToolArgs('memory_search', { query: 'x', layers: ['not-a-layer'] })).toContain('one of');
  });
});
