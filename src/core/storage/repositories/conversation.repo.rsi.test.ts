import { beforeEach, describe, expect, it, vi } from 'vitest';

const disk = vi.hoisted(() => ({
  conversations: [] as any[],
  messages: [] as any[],
}));

vi.mock('../database', () => ({
  readJSON: (file: string, _default: unknown) =>
    structuredClone(file === 'conversations.json' ? disk.conversations : disk.messages),
  writeJSON: vi.fn((file: string, data: any[]) => {
    if (file === 'conversations.json') disk.conversations = structuredClone(data);
    else disk.messages = structuredClone(data);
  }),
}));

import { conversationRepo } from './conversation.repo';

// The RSI metadata travels with the persisted conversation record so a
// dedicated RSI session survives restarts with its own direction and runs.

beforeEach(() => {
  vi.clearAllMocks();
  disk.conversations = [];
  disk.messages = [];
});

describe('conversationRepo persists RSI conversation metadata', () => {
  it('stores agentMode and the full rsi state on create', () => {
    const conv = conversationRepo.create({
      title: 'RSI session',
      agentMode: 'rsi',
      isChatMode: false,
      rsi: {
        status: 'idle',
        directionConfig: { objective: 'Cut test time', priorities: '', metrics: '', scope: '', constraints: '' },
        runs: [{ id: 'run-1', status: 'completed', iteration: 3, result: null, createdAt: 1, updatedAt: 2 }],
      },
    });

    const stored = conversationRepo.findById(conv.id);
    expect(stored?.agentMode).toBe('rsi');
    expect(stored?.rsi?.directionConfig.objective).toBe('Cut test time');
    expect(stored?.rsi?.runs).toHaveLength(1);
    expect(stored?.rsi?.runs[0].iteration).toBe(3);
  });

  it('keeps legacy conversations untouched (no rsi field invented)', () => {
    const conv = conversationRepo.create({ title: 'Old chat' });
    const stored = conversationRepo.findById(conv.id);
    expect(stored?.agentMode).toBeUndefined();
    expect(stored?.rsi).toBeUndefined();
  });

  it('persists direction and run updates without cross-contaminating other records', () => {
    const a = conversationRepo.create({ title: 'A', agentMode: 'rsi', rsi: { status: 'idle', directionConfig: { objective: '', priorities: '', metrics: '', scope: '', constraints: '' }, runs: [] } });
    const b = conversationRepo.create({ title: 'B', agentMode: 'rsi', rsi: { status: 'idle', directionConfig: { objective: '', priorities: '', metrics: '', scope: '', constraints: '' }, runs: [] } });

    conversationRepo.update(a.id, {
      rsi: {
        status: 'running',
        directionConfig: { objective: 'only A', priorities: '', metrics: '', scope: '', constraints: '' },
        runs: [{ id: 'run-a', status: 'running', iteration: 0, result: null, createdAt: 1, updatedAt: 1 }],
      },
    });

    const storedA = conversationRepo.findById(a.id);
    const storedB = conversationRepo.findById(b.id);
    expect(storedA?.rsi?.directionConfig.objective).toBe('only A');
    expect(storedA?.rsi?.status).toBe('running');
    expect(storedB?.rsi?.directionConfig.objective).toBe('');
    expect(storedB?.rsi?.runs).toHaveLength(0);
  });
});
