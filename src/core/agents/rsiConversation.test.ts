import { describe, expect, it } from 'vitest';
import {
  defaultRsiState, isRsiConversation, readRsiProgress,
  rsiDirectionPrompt, rsiWorkspaceDir,
} from './rsiConversation';

describe('rsiWorkspaceDir', () => {
  it('isolates one archive per conversation under the workspace', () => {
    expect(rsiWorkspaceDir('/proj', 'abc-123'))
      .toBe('/proj/.conecode/rsi/conversations/abc-123');
  });

  it('strips trailing slashes and sanitizes unsafe conversation ids', () => {
    expect(rsiWorkspaceDir('/proj/', '../etc/passwd'))
      .toBe('/proj/.conecode/rsi/conversations/___etc_passwd');
  });
});

describe('isRsiConversation', () => {
  it('requires both the rsi agent mode and rsi state', () => {
    expect(isRsiConversation({ agentMode: 'rsi', rsi: defaultRsiState() })).toBe(true);
    expect(isRsiConversation({ agentMode: 'rsi' })).toBe(false);
    expect(isRsiConversation({ agentMode: 'standard', rsi: defaultRsiState() })).toBe(false);
    expect(isRsiConversation({})).toBe(false);
  });
});

describe('readRsiProgress', () => {
  it('reads the real LOOP_STATE.json envelope ({version, state})', () => {
    const raw = JSON.stringify({
      version: 1,
      state: { episodeIndex: 4, acceptedCount: 2 },
    });
    expect(readRsiProgress(raw)).toEqual({ iteration: 4, acceptedCount: 2 });
  });

  it('returns null for missing, malformed, or incomplete evidence', () => {
    expect(readRsiProgress(null)).toBeNull();
    expect(readRsiProgress('not json')).toBeNull();
    expect(readRsiProgress(JSON.stringify({ version: 1, state: {} }))).toBeNull();
    // A loop-state WITHOUT the envelope (raw LoopState) is not trusted either.
    expect(readRsiProgress(JSON.stringify({ episodeIndex: 9, acceptedCount: 9 }))).toBeNull();
  });

  it('clamps negative numbers to zero', () => {
    const raw = JSON.stringify({ version: 1, state: { episodeIndex: -1, acceptedCount: -5 } });
    expect(readRsiProgress(raw)).toEqual({ iteration: 0, acceptedCount: 0 });
  });
});

describe('rsiDirectionPrompt', () => {
  it('injects the conversation id, its isolated archive path, and every direction field', () => {
    const prompt = rsiDirectionPrompt('conv-1', '/proj', {
      objective: 'Cut test time in half',
      priorities: 'reliability first',
      metrics: 'vitest duration',
      scope: 'src/core only',
      constraints: 'never weaken assertions',
    });
    expect(prompt).toContain('Conversation ID: conv-1');
    expect(prompt).toContain('/proj/.conecode/rsi/conversations/conv-1');
    expect(prompt).toContain('Objective: Cut test time in half');
    expect(prompt).toContain('Priorities: reliability first');
    expect(prompt).toContain('Evaluation metrics: vitest duration');
    expect(prompt).toContain('Modification scope: src/core only');
    expect(prompt).toContain('Constraints: never weaken assertions');
    // The isolation contract: never fall back to the shared legacy archive.
    expect(prompt).toContain('instead of the legacy shared');
  });

  it('marks empty fields honestly instead of inventing direction', () => {
    const prompt = rsiDirectionPrompt('conv-1', '/proj', {
      objective: '', priorities: '', metrics: '', scope: '', constraints: '',
    });
    expect(prompt).toContain('Objective: (not specified)');
  });

  it('states the open-a-workspace requirement when no root is bound', () => {
    const prompt = rsiDirectionPrompt('conv-1', null, {
      objective: 'x', priorities: '', metrics: '', scope: '', constraints: '',
    });
    expect(prompt).toContain('(open a workspace before execution)');
  });
});
