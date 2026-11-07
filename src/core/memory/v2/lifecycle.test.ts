import { describe, expect, it } from 'vitest';
import { createRecord } from './model';
import {
  archiveMemory, getHistory, isWorkingMemoryExpired, mergeMemories, reconcile,
  reinforce, tombstone, undoUpdate, updateMemory,
} from './lifecycle';
import type { ClassifiedMemory } from './classify';
import type { MemoryRecord } from './types';

const NOW = 1_800_000_000_000;
const CTX = { now: NOW, deviceId: 'dev-a', reason: 'test' };

function base(overrides: Partial<Parameters<typeof createRecord>[0]> = {}, id = 'm1'): MemoryRecord {
  return createRecord({
    content: 'The API lives in src/core/api.ts',
    type: 'architecture',
    layer: 'project',
    projectId: 'proj-a',
    importance: 0.6,
    ...overrides,
  }, { id, deviceId: 'dev-a', now: NOW - 10_000 });
}

function candidate(content: string, overrides: Partial<ClassifiedMemory> = {}): ClassifiedMemory {
  return {
    title: content.slice(0, 30),
    content,
    type: 'architecture',
    layer: 'project',
    projectId: 'proj-a',
    tags: ['architecture'],
    importance: 0.7,
    confidence: 0.8,
    status: 'inferred',
    ...overrides,
  };
}

describe('memory lifecycle', () => {
  it('increments version, snapshots history and updates the content hash', () => {
    const original = base();
    const updated = updateMemory(original, { content: 'The API lives in src/core/http/api.ts' }, CTX);
    expect(updated.version).toBe(2);
    expect(updated.history).toHaveLength(1);
    expect(updated.history[0].content).toBe(original.content);
    expect(updated.contentHash).not.toBe(original.contentHash);
    expect(updated.updatedAt).toBe(NOW);
  });

  it('protects high-importance memories unless force is explicit', () => {
    const important = base({ importance: 0.95 });
    expect(() => updateMemory(important, { content: 'overwritten' }, CTX)).toThrow(/protected/i);
    expect(updateMemory(important, { content: 'overwritten' }, { ...CTX, force: true }).content).toBe('overwritten');
    expect(() => tombstone(important, CTX)).toThrow(/protected/i);
    expect(tombstone(important, { ...CTX, force: true }).deletedAt).toBe(NOW);
  });

  it('soft-deletes with a tombstone that keeps history', () => {
    const dead = tombstone(base(), CTX);
    expect(dead.deletedAt).toBe(NOW);
    expect(dead.status).toBe('archived');
    expect(dead.version).toBe(2);
    expect(getHistory(dead).length).toBe(2);
  });

  it('archives and restores the previous version', () => {
    const original = base();
    const archived = archiveMemory(original, CTX);
    expect(archived.status).toBe('archived');
    const restored = undoUpdate(archived, { ...CTX, now: NOW + 1, reason: 'undo archive' });
    expect(restored.status).toBe(original.status);
    expect(restored.version).toBe(3);
  });

  it('reinforces without creating a duplicate and keeps the sharper phrasing', () => {
    const original = base();
    const sharper = 'The API lives in src/core/api.ts and all network calls go through it';
    const updated = reinforce(original, CTX, sharper);
    expect(updated.content).toBe(sharper);
    expect(updated.importance).toBeGreaterThan(original.importance);
    expect(updated.history).toHaveLength(1);
  });

  it('merges two records and links the absorbed one', () => {
    const a = base();
    const b = base({ content: 'The API retries POSTs with exponential backoff', type: 'technical_decision' }, 'm2');
    const merged = mergeMemories(a, b, CTX);
    expect(merged.content).toContain(a.content);
    expect(merged.content).toContain(b.content);
    expect(merged.relatedMemoryIds).toContain(b.id);
    expect(merged.relations.some((r) => r.kind === 'part_of')).toBe(true);
  });

  it('a confirmed user correction supersedes an earlier inference', () => {
    const existing = base({ origin: 'extracted', status: 'inferred', confidence: 0.65 });
    const result = reconcile(existing, candidate('The API actually lives in src/core/http/api.ts', {
      status: 'confirmed', confidence: 0.95,
    }), CTX);
    expect(result.outcome).toBe('superseded');
    expect(result.record.content).toContain('src/core/http/api.ts');
    expect(result.record.history[result.record.history.length - 1]?.content).toBe(existing.content);
  });

  it('an inference cannot silently overwrite a user-confirmed fact', () => {
    const existing = base({ origin: 'user', status: 'confirmed', confidence: 0.95 });
    const result = reconcile(existing, candidate('The API lives somewhere else', {
      status: 'inferred', confidence: 0.8,
    }), CTX);
    expect(result.outcome).toBe('kept_both');
    expect(result.record.content).toBe(existing.content);
  });

  it('never auto-corrects a protected memory, even with a confirmed incoming fact', () => {
    const existing = base({ origin: 'user', status: 'confirmed', confidence: 0.95, importance: 0.95 });
    const result = reconcile(existing, candidate('The API lives in src/core/http/api.ts', {
      status: 'confirmed', confidence: 0.98,
    }), CTX);
    expect(result.outcome).toBe('kept_both');
    expect(result.record.content).toBe(existing.content);
  });

  it('keeps both materially different claims when confidence is similar', () => {
    const existing = base({ status: 'inferred', confidence: 0.8 });
    const result = reconcile(existing, candidate('The API is generated from the schema at build time', {
      status: 'inferred', confidence: 0.85,
    }), CTX);
    expect(result.outcome).toBe('kept_both');
  });

  it('expires only working memory', () => {
    const working = base({ layer: 'working', type: 'progress', importance: 0.3 });
    expect(isWorkingMemoryExpired(working, 1000, NOW + 2000)).toBe(true);
    expect(isWorkingMemoryExpired(base(), 1000, NOW + 2000)).toBe(false);
  });
});
