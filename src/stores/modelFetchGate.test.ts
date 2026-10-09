import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useModelStore } from './model.store';
import { isHolding, useInstallGateStore } from './installGate.store';

beforeEach(() => {
  localStorage.clear();
  (globalThis as any).window = {
    electronAPI: {
      provider: { list: vi.fn(async () => [{ id: 'p1', enabled: true }]) },
      model: { list: vi.fn(async () => []) },
      favorite: { list: vi.fn(async () => []) },
      recent: { list: vi.fn(async () => []) },
    },
  };
  useInstallGateStore.getState().reset();
});

// Regression: routine model listing is not an install — it must never raise
// the "model paused" pill or block sending on every app launch.
describe('model listing stays out of the install gate', () => {
  it('fetchAllModels neither holds nor leaves jobs behind', async () => {
    await useModelStore.getState().fetchAllModels();
    expect(isHolding(useInstallGateStore.getState().jobs)).toBe(false);
    expect(Object.keys(useInstallGateStore.getState().jobs)).toHaveLength(0);
  });

  it('fetchModels neither holds nor leaves jobs behind', async () => {
    await useModelStore.getState().fetchModels('p1');
    expect(isHolding(useInstallGateStore.getState().jobs)).toBe(false);
    expect(Object.keys(useInstallGateStore.getState().jobs)).toHaveLength(0);
  });
});
