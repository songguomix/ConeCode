import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { emptyState } from '../core/memory/v2/storage/interface';
import { useMemoryV2Store } from './memoryV2.store';
import { useModelStore } from './model.store';
import type { AIModel } from '../types';

const NOW = 1_800_000_000_000;
const ROOT = '/workspace/dream';
const MODEL = { id: 'test-model', providerId: 'test-provider', maxOutputTokens: 8192 } as AIModel;
const completed = [
  { role: 'user', content: 'How do I run the checks?', createdAt: NOW - 1_000_000 },
  { role: 'assistant', content: 'Use pnpm test.', createdAt: NOW - 900_000 },
];
const idleChat = (id: string, rootPath = ROOT) => ({ id, rootPath, updatedAt: NOW - 900_000, title: id });

const objects = new Map<string, string>();
const conversations = vi.fn<() => Promise<ReturnType<typeof idleChat>[]>>();
const messages = vi.fn<(id: string) => Promise<typeof completed>>();
const stream = vi.fn(async () => ({ choices: [{ message: { content: '{"files":[]}' }, finish_reason: 'stop' }] }));

beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(NOW);
  localStorage.clear();
  objects.clear();
  conversations.mockReset().mockResolvedValue([]);
  messages.mockReset().mockResolvedValue(completed);
  stream.mockClear();
  vi.spyOn(useModelStore.getState(), 'getSelectedModel').mockReturnValue(MODEL);
  vi.stubGlobal('window', { electronAPI: {
    conversation: { list: conversations },
    message: { list: messages },
    chat: { stream },
    memory2: {
      deviceId: async () => 'test-device',
      projectId: async (root: string) => root === ROOT ? 'test-project' : 'other-project',
      load: async () => emptyState(),
      save: async () => true,
      putObject: async (key: string, value: string) => { objects.set(key, value); return true; },
      getObject: async (key: string) => objects.get(key) ?? null,
      legacySnapshot: async () => ({ entries: [], files: [] }),
      setRoot: async () => true,
    },
  } });
  await useMemoryV2Store.getState().init(ROOT);
  await useMemoryV2Store.getState().setProject(ROOT);
});

afterEach(() => {
  useMemoryV2Store.getState().setDreamAuto(false);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('Dream run lifecycle', () => {
  it('finds short idle chats in the current workspace after newer unrelated chats', async () => {
    conversations.mockResolvedValue([
      ...Array.from({ length: 30 }, (_, i) => idleChat(`other-${i}`, '/workspace/other')),
      idleChat('still-active'),
      idleChat('eligible'),
    ]);
    messages.mockImplementation(async (id) => id === 'still-active'
      ? [...completed, { role: 'user', content: 'Keep going', createdAt: NOW - 1000 }]
      : completed);

    const report = await useMemoryV2Store.getState().runDream();

    expect(report?.sessions).toEqual([{ id: 'eligible', title: 'eligible', status: 'skipped', files: [] }]);
    expect(messages.mock.calls).toEqual([['still-active'], ['eligible']]);
    expect(stream).toHaveBeenCalledTimes(1);
  });

  it('reports a failure to read history instead of an empty successful run', async () => {
    conversations.mockRejectedValue(new Error('History read failed'));

    expect(await useMemoryV2Store.getState().runDream()).toBeNull();
    expect(useMemoryV2Store.getState().dreamError).toBe('History read failed');
    expect(localStorage.getItem('memoryDreamLastAt')).toBeNull();
    expect(stream).not.toHaveBeenCalled();
  });

  it('keeps an in-flight run scoped to its original project', async () => {
    let release!: (chats: ReturnType<typeof idleChat>[]) => void;
    conversations.mockReturnValue(new Promise((resolve) => { release = resolve; }));
    const run = useMemoryV2Store.getState().runDream();
    await useMemoryV2Store.getState().setProject('/workspace/other');
    release([idleChat('eligible')]);

    const report = await run;
    expect(report?.scope).toBe('test-project');
    expect(report?.sessions).toHaveLength(1);
    expect(objects.has('dream/test-project/last-report.json')).toBe(true);
    expect(objects.has('dream/other-project/last-report.json')).toBe(false);
    expect(useMemoryV2Store.getState().lastDream).toBeNull();
  });

  it('cancels the pending auto run when the user disables the schedule', async () => {
    useMemoryV2Store.getState().setDreamAuto(true);
    await vi.advanceTimersByTimeAsync(1_000);
    useMemoryV2Store.getState().setDreamAuto(false);
    await vi.advanceTimersByTimeAsync(3_600_000);

    expect(conversations).not.toHaveBeenCalled();
  });
});
