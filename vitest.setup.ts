// Minimal browser-global shims so the DOM-touching Zustand stores (e.g.
// language.store reads localStorage at import) can be imported under the node
// test environment without pulling in a full jsdom.
const mem = new Map<string, string>();
const localStorageShim = {
  getItem: (k: string) => (mem.has(k) ? mem.get(k)! : null),
  setItem: (k: string, v: string) => { mem.set(k, String(v)); },
  removeItem: (k: string) => { mem.delete(k); },
  clear: () => mem.clear(),
  key: (i: number) => Array.from(mem.keys())[i] ?? null,
  get length() { return mem.size; },
};
(globalThis as any).localStorage = localStorageShim;
