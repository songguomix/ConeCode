import { describe, expect, it, vi } from 'vitest';
import { MemoryService } from './service';
import { CompositeStorageProvider } from './storage/composite';
import { InMemoryStorageProvider } from './storage/inMemory';
import { emptyState } from './storage/interface';

const NOW = 1_800_000_000_000;

function makeIdFactory() {
  let n = 0;
  return () => `mem-${++n}`;
}

async function makeService(opts: {
  local?: InMemoryStorageProvider;
  deviceId?: string;
  llm?: (req: { system: string; user: string }) => Promise<string>;
  trackWorkingMemory?: boolean;
} = {}) {
  const local = opts.local ?? new InMemoryStorageProvider({ kind: 'local', initial: emptyState() });
  const composite = new CompositeStorageProvider(local, null);
  const service = new MemoryService({
    storage: composite,
    makeId: makeIdFactory(),
    deviceId: opts.deviceId ?? 'dev-a',
    now: () => NOW,
    llm: opts.llm,
    trackWorkingMemory: opts.trackWorkingMemory,
  });
  await service.init();
  service.setProject('/repo/a', 'proj-a');
  return { service, local, composite };
}

const EXTRACTION = JSON.stringify({
  memories: [{
    title: 'SQLite for local memory',
    content: 'We decided to use SQLite plus Markdown for local memory storage, so offline search stays fast.',
    type: 'technical_decision',
    scope: 'project',
    tags: ['storage', 'sqlite'],
    importance: 0.8,
    confidence: 0.95,
    status: 'confirmed',
    why: 'chosen after comparing JSON-only storage',
  }],
});

describe('MemoryService', () => {
  it('extracts a durable decision at a value node and records provenance', async () => {
    const llm = vi.fn(async () => EXTRACTION);
    const { service } = await makeService({ llm });
    const result = await service.endTask({
      messages: [
        { role: 'user', content: 'We decided to use SQLite for local memory storage.' },
        { role: 'assistant', content: 'I will implement SQLite plus Markdown export.' },
      ],
      sessionId: 'session-1',
      taskText: 'Implement memory storage',
    });
    expect(result.triggered).toBe(true);
    expect(result.added).toBe(1);
    expect(service.getState().records).toHaveLength(1);
    const record = service.getState().records[0];
    expect(record.type).toBe('technical_decision');
    expect(record.status).toBe('confirmed');
    expect(record.sourceSessionId).toBe('session-1');
    expect(record.why).toContain('JSON-only');
    expect(record.layer).toBe('project');
  });

  it('runs one session-end extraction even when no keyword signal fired', async () => {
    const llm = vi.fn(async () => JSON.stringify({ memories: [] }));
    const { service } = await makeService({ llm });
    const result = await service.endTask({
      messages: [
        { role: 'user', content: 'We looked through the release checklist together.' },
        { role: 'assistant', content: 'The checklist is in docs/release.md and all steps were reviewed.' },
        { role: 'user', content: 'We checked the installer size and the signing step.' },
        { role: 'assistant', content: 'Both look normal; the notes are in the release document.' },
        { role: 'user', content: 'We also confirmed the rollback instructions.' },
        { role: 'assistant', content: 'The rollback section is up to date.' },
      ],
      sessionId: 'session-end',
      event: 'session_end',
    });
    expect(result.triggered).toBe(true);
    expect(llm).toHaveBeenCalledOnce();
  });

  it('does not run a session-end summary for a tiny generic exchange', async () => {
    const llm = vi.fn(async () => JSON.stringify({ memories: [] }));
    const { service } = await makeService({ llm });
    const result = await service.endTask({
      messages: [
        { role: 'user', content: 'We looked at the release checklist.' },
        { role: 'assistant', content: 'It is in the docs folder.' },
      ],
      sessionId: 'short-session',
      event: 'session_end',
    });
    expect(result.triggered).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });

  it('does not call the provider for small talk', async () => {
    const llm = vi.fn(async () => EXTRACTION);
    const { service } = await makeService({ llm });
    const result = await service.endTask({
      messages: [{ role: 'user', content: '谢谢' }, { role: 'assistant', content: '不客气' }],
    });
    expect(result.triggered).toBe(false);
    expect(llm).not.toHaveBeenCalled();
  });

  it('links a semantic lesson back to the episode that produced it', async () => {
    const llm = vi.fn(async () => JSON.stringify({
      memories: [
        {
          title: 'Watcher debounce fix', content: 'The preview reload race was solved by debouncing the watcher for 80ms.',
          type: 'success_experience', scope: 'project', tags: ['preview'], importance: 0.7, confidence: 0.8,
          status: 'inferred', outcome: 'success',
        },
        {
          title: 'Debounce file watchers', content: 'Reusable rule: debounce filesystem watchers before triggering a reload in Electron.',
          type: 'reusable_knowledge', scope: 'project', tags: ['electron', 'watcher'], importance: 0.8, confidence: 0.8,
          status: 'inferred',
        },
      ],
    }));
    const { service } = await makeService({ llm });
    await service.endTask({
      messages: [
        { role: 'user', content: 'We resolved the preview reload race by debouncing the watcher for 80ms.' },
        { role: 'assistant', content: 'Verified the reload test passes now.' },
      ],
      sessionId: 'session-semantic',
    });
    const episode = service.getState().records.find((r) => r.layer === 'episodic');
    const lesson = service.getState().records.find((r) => r.layer === 'semantic');
    expect(episode).toBeTruthy();
    expect(lesson).toBeTruthy();
    expect(lesson?.relatedMemoryIds).toContain(episode!.id);
    expect(lesson?.relations.some((r) => r.kind === 'derived_from')).toBe(true);
    expect(episode?.relatedMemoryIds).toContain(lesson!.id);
  });

  it('reinforces the same extracted fact instead of duplicating it', async () => {
    const llm = vi.fn(async () => EXTRACTION);
    const { service } = await makeService({ llm });
    const messages = [
      { role: 'user', content: 'We decided to use SQLite for local memory storage.' },
      { role: 'assistant', content: 'Done.' },
    ];
    await service.endTask({ messages, sessionId: 's1' });
    const second = await service.endTask({ messages, sessionId: 's1' });
    expect(second.reinforced).toBe(1);
    expect(service.getState().records).toHaveLength(1);
    expect(service.getState().records[0].importance).toBeGreaterThan(0.8);
  });

  it('does not duplicate an identical manual save', async () => {
    const { service } = await makeService();
    const first = await service.saveMemory({
      content: 'Always run the tests before claiming a task is done',
      type: 'constraint',
      layer: 'global',
      status: 'confirmed',
      origin: 'user',
    });
    const second = await service.saveMemory({
      content: 'Always run the tests before claiming a task is done!',
      type: 'constraint',
      layer: 'global',
      status: 'confirmed',
      origin: 'user',
    });
    expect(second.id).toBe(first.id);
    expect(service.getState().records).toHaveLength(1);
  });

  it('keeps memory across service instances (sessions) on the same durable store', async () => {
    const local = new InMemoryStorageProvider({ kind: 'local', initial: emptyState() });
    const first = await makeService({ local, llm: async () => EXTRACTION });
    await first.service.endTask({
      messages: [
        { role: 'user', content: 'We decided to use SQLite for local memory storage.' },
        { role: 'assistant', content: 'Implemented.' },
      ],
      sessionId: 'session-1',
    });

    const second = await makeService({ local, deviceId: 'dev-b' });
    const block = await second.service.beginTask('How does local memory storage work?', { sessionId: 'session-2' });
    expect(block).toContain('SQLite plus Markdown');
    expect(block).toContain('session');
  });

  it('never leaks project A memory into project B, but keeps global memory visible', async () => {
    const { service } = await makeService();
    await service.saveMemory({
      content: 'Project A uses a custom retry scheduler',
      type: 'architecture',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    await service.saveMemory({
      content: 'Always answer in Chinese',
      type: 'user_fact',
      layer: 'global',
      status: 'confirmed',
      origin: 'user',
    });

    const a = await service.searchMemory({ text: 'retry scheduler', scope: 'all' });
    expect(a.map((h) => h.record.projectId)).toContain('proj-a');

    service.setProject('/repo/b', 'proj-b');
    const b = await service.searchMemory({ text: 'retry scheduler', scope: 'all' });
    expect(b).toHaveLength(0);
    const global = await service.searchMemory({ text: 'Chinese', scope: 'all' });
    expect(global.map((h) => h.record.layer)).toEqual(['global']);
  });

  it('creates and promotes working memory for the current task only', async () => {
    const { service } = await makeService({ trackWorkingMemory: true });
    await service.beginTask('修复网络模块超时问题', { sessionId: 'session-1' });
    const working = service.getState().records.find((r) => r.layer === 'working');
    expect(working?.type).toBe('progress');
    expect(working?.tags).toContain('current-task');

    const promoted = await service.promoteWorkingMemory(working!.id);
    expect(promoted.layer).toBe('project');
    expect(service.getStats().byLayer.working).toBe(0);
  });

  it('updates a memory with version history and can undo the correction', async () => {
    const { service } = await makeService();
    const original = await service.saveMemory({
      content: 'The API lives in src/core/api.ts',
      type: 'architecture',
      layer: 'project',
      projectId: 'proj-a',
      status: 'confirmed',
      origin: 'user',
    });
    const updated = await service.updateMemory(original.id, { content: 'The API lives in src/core/http/api.ts' });
    expect(updated.version).toBe(2);
    expect(service.getMemoryHistory(original.id)).toHaveLength(2);
    const restored = await service.undo(original.id);
    expect(restored.content).toBe(original.content);
    expect(restored.version).toBe(3);
    const fromHistory = await service.restoreVersion(original.id, 2);
    expect(fromHistory.content).toContain('src/core/http/api.ts');
    expect(fromHistory.version).toBe(4);
  });

  it('records a failure deterministically and reinforces an identical one', async () => {
    const { service } = await makeService();
    const first = await service.recordFailure({ task: 'build release', reason: 'signing key missing' });
    const second = await service.recordFailure({ task: 'build release', reason: 'signing key missing' });
    expect(second.id).toBe(first.id);
    expect(service.getState().records.filter((r) => r.type === 'failure_experience')).toHaveLength(1);
    const hits = await service.searchMemory({ text: 'signing key missing', scope: 'all' });
    expect(hits[0].record.type).toBe('failure_experience');
  });

  it('protects important memories from deletion unless force is explicit', async () => {
    const { service } = await makeService();
    const important = await service.saveMemory({
      content: 'Never commit directly to main on release day',
      type: 'constraint',
      layer: 'global',
      importance: 0.95,
      status: 'confirmed',
      origin: 'user',
    });
    await expect(service.deleteMemory(important.id)).rejects.toThrow(/protected/i);
    const deleted = await service.deleteMemory(important.id, true);
    expect(deleted.deletedAt).toBe(NOW);
    const hits = await service.searchMemory({ text: 'release day', scope: 'all' });
    expect(hits).toHaveLength(0);
  });
});
