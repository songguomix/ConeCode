import { afterEach, expect, it, vi } from 'vitest';
import type { PluginDetail } from '../core/dsh-market/types';
import { useDshMarketStore } from './dshMarket.store';

afterEach(() => {
  useDshMarketStore.getState().clearSelection();
  vi.unstubAllGlobals();
});

it('keeps the latest plugin detail selected when requests finish out of order', async () => {
  const pending = new Map<string, (detail: PluginDetail) => void>();
  vi.stubGlobal('window', { electronAPI: { dshMarket: {
    detail: (id: string) => new Promise<PluginDetail>((resolve) => pending.set(id, resolve)),
  } } });
  const store = useDshMarketStore.getState();
  const first = store.selectPlugin('first');
  const second = store.selectPlugin('second');
  const selected = { plugin: { name: 'second' } } as PluginDetail;
  pending.get('second')!(selected);
  await second;
  pending.get('first')!({ plugin: { name: 'first' } } as PluginDetail);
  await first;
  expect(useDshMarketStore.getState().detail).toBe(selected);

  const closing = store.selectPlugin('first');
  store.clearSelection();
  pending.get('first')!({ plugin: { name: 'first' } } as PluginDetail);
  await closing;
  expect(useDshMarketStore.getState()).toMatchObject({ detail: null, detailLoading: false, selectedPluginId: null });
});
