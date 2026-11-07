import { describe, expect, it } from 'vitest';
import { createRecord } from './model';
import { linkMemories } from './relations';
import { buildIndex, formatRetrievalBlock, mergeHybrid, needsHistory, searchRecords } from './retrieval';
import { tokenize } from './text';
import type { MemoryRecord } from './types';

const NOW = 1_800_000_000_000;
const DEVICE = 'test-device';

function record(id: string, content: string, extra: Partial<Parameters<typeof createRecord>[0]> = {}): MemoryRecord {
  return createRecord({
    content,
    title: content.slice(0, 40),
    type: 'project_fact',
    layer: 'project',
    projectId: 'proj-a',
    ...extra,
  }, { id, deviceId: DEVICE, now: NOW });
}

describe('memory text indexing', () => {
  it('splits Chinese runs into bigrams so full-text search works without spaces', () => {
    expect(tokenize('网络模块超时')).toEqual(['网络', '络模', '模块', '块超', '超时']);
    expect(tokenize('Fix the API_timeout bug')).toEqual(['fix', 'the', 'api_timeout', 'bug']);
  });
});

describe('ranked retrieval', () => {
  const globalPref = record('g1', 'Always answer in Chinese and keep replies short', {
    layer: 'global', projectId: null, type: 'user_fact', status: 'confirmed', importance: 0.9,
  });
  const bugA = record('a1', 'Network module times out when the proxy retries a POST', {
    type: 'known_bug', tags: ['network', 'timeout'], importance: 0.8,
  });
  const decisionA = record('a2', 'Network retries use exponential backoff to avoid a request storm', {
    type: 'technical_decision', layer: 'semantic', importance: 0.75,
  });
  const bugB = record('b1', 'Network module in project B has a different timeout', {
    projectId: 'proj-b', type: 'known_bug',
  });
  const records = [globalPref, bugA, decisionA, bugB];

  it('never returns another project’s memory', () => {
    const hits = searchRecords(records, { text: 'network timeout Chinese', projectId: 'proj-a', scope: 'all' });
    expect(hits.map((h) => h.record.id)).toContain('a1');
    expect(hits.map((h) => h.record.id)).toContain('g1');
    expect(hits.map((h) => h.record.id)).not.toContain('b1');
  });

  it('project scope excludes global memory, global scope excludes project memory', () => {
    expect(searchRecords(records, { text: 'network', projectId: 'proj-a', scope: 'project' })
      .every((h) => h.record.projectId === 'proj-a')).toBe(true);
    expect(searchRecords(records, { text: 'network', projectId: 'proj-a', scope: 'global' })
      .every((h) => h.record.layer === 'global')).toBe(true);
  });

  it('supports layer, type, tag and importance filters', () => {
    const semantic = searchRecords(records, {
      text: 'network', projectId: 'proj-a', layers: ['semantic'],
    });
    expect(semantic.map((h) => h.record.id)).toEqual(['a2']);
    const bugs = searchRecords(records, {
      text: 'network', projectId: 'proj-a', types: ['known_bug'], tags: ['timeout'], importanceMin: 0.7,
    });
    expect(bugs.map((h) => h.record.id)).toEqual(['a1']);
  });

  it('expands along relations without crossing a project boundary', () => {
    const [linkedA, linkedDecision] = linkMemories(bugA, decisionA, 'related', { now: NOW, deviceId: DEVICE });
    const linkedBugB = record('b2', 'A related note that belongs to another project', { projectId: 'proj-b' });
    const [linkedA2, linkedB2] = linkMemories(linkedA, linkedBugB, 'related', { now: NOW, deviceId: DEVICE });
    const all = [linkedA2, linkedDecision, linkedB2, globalPref];
    const hits = searchRecords(all, {
      text: 'proxy', projectId: 'proj-a', includeRelated: true, relatedDepth: 1,
    });
    const ids = hits.map((h) => h.record.id);
    expect(ids).toContain('a1');
    expect(ids).toContain('a2');
    expect(ids).not.toContain('b2');
    expect(hits.find((h) => h.record.id === 'a2')?.reasons.some((r) => r.startsWith('related via'))).toBe(true);
  });

  it('merges local and cloud hits by UUID without losing provenance', () => {
    const localHit = { record: bugA, score: 3, source: 'local' as const, matchedTerms: ['network'], reasons: ['local'] };
    const cloudNewer = { record: { ...bugA, version: 2 }, score: 5, source: 'cloud' as const, matchedTerms: ['timeout'], reasons: ['cloud'] };
    const merged = mergeHybrid([localHit], [cloudNewer], { text: 'network', projectId: 'proj-a', scope: 'all' });
    expect(merged).toHaveLength(1);
    expect(merged[0].record.version).toBe(2);
    expect(merged[0].source).toBe('cloud');
    expect(merged[0].reasons.join(' ')).toContain('merged local+cloud');
  });

  it('formats a bounded prompt block with status and provenance', () => {
    const index = buildIndex(records);
    const hits = searchRecords(records, { text: 'network timeout', projectId: 'proj-a' }, { index });
    const block = formatRetrievalBlock(hits, 1200);
    expect(block).toContain('RELEVANT LONG-TERM MEMORY');
    expect(block).toContain('[project/known_bug | inferred | v1 | local');
    expect(block.length).toBeLessThanOrEqual(1400);
  });

  it('does not turn a punctuation-only query into a full memory dump', () => {
    const hits = searchRecords(records, { text: '？？？', projectId: 'proj-a', scope: 'all' });
    expect(hits).toEqual([]);
  });

  it('does not treat greetings as a reason to retrieve history', () => {
    expect(needsHistory('你好')).toBe(false);
    expect(needsHistory('修复网络模块超时')).toBe(true);
  });
});
