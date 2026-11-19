import { afterEach, expect, it, vi } from 'vitest';
import type { MarketSnapshot, PluginDetail } from '../core/dsh-market/types';
import { useDshMarketStore } from './dshMarket.store';

afterEach(() => {
  useDshMarketStore.getState().clearSelection();
  useDshMarketStore.setState(useDshMarketStore.getInitialState());
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


it('keeps the latest catalog response when overlapping requests finish out of order', async () => {
  const pending: Array<(snapshot: MarketSnapshot) => void> = [];
  vi.stubGlobal('window', { electronAPI: { dshMarket: {
    snapshot: () => new Promise<MarketSnapshot>((resolve) => pending.push(resolve)),
  } } });
  const { refresh } = useDshMarketStore.getState();
  const first = refresh();
  const second = refresh();
  const newest = { catalog: { page: 1, total: 2 } } as MarketSnapshot;
  pending[1](newest);
  await second;
  pending[0]({ catalog: { page: 3, total: 100 } } as MarketSnapshot);
  await first;
  expect(useDshMarketStore.getState()).toMatchObject({ page: 1, snapshot: newest, loading: false });
});

it('preserves the selected row across both invocation bridges', async () => {
  const invokeTool = vi.fn().mockResolvedValue({ ok: true, rendered: '' });
  const invokeCommand = vi.fn().mockResolvedValue({ ok: true, rendered: 'second greeting' });
  vi.stubGlobal('window', { electronAPI: { dshMarket: { invokeTool, invokeCommand } } });
  useDshMarketStore.setState({ snapshot: { profile: { id: 'default' } } as MarketSnapshot });
  const store = useDshMarketStore.getState();
  expect(await store.invokeTool('bundle', 'same', { name: 'GUI' }, 'first')).toBe('');
  expect(await store.invokeCommand('bundle', 'same', 'GUI', 'second')).toBe('second greeting');
  expect(invokeTool).toHaveBeenCalledWith('default', 'bundle', 'same', { name: 'GUI' }, 'first');
  expect(invokeCommand).toHaveBeenCalledWith('default', 'bundle', 'same', 'GUI', 'second');
});

it('opens the selected Web version once and surfaces official host launch errors', async () => {
  let fail!: (error: Error) => void;
  const openDshWeb = vi.fn(() => new Promise<void>((_, reject) => { fail = reject; }));
  vi.stubGlobal('window', { electronAPI: { dshMarket: { openDshWeb } } });
  useDshMarketStore.setState({ snapshot: { profile: { id: 'work' } } as MarketSnapshot });
  const open = useDshMarketStore.getState().openDshWeb;
  const first = open('dsh-theme', '1.0.1');
  await open();
  expect(openDshWeb).toHaveBeenCalledOnce();
  expect(openDshWeb).toHaveBeenCalledWith('work', 'dsh-theme', '1.0.1');
  expect(useDshMarketStore.getState().webBusy).toBe(true);
  fail(new Error('DSH CLI unavailable'));
  await first;
  expect(useDshMarketStore.getState()).toMatchObject({ error: 'DSH CLI unavailable', webBusy: false });
});
