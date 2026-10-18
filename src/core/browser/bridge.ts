const unsubscribe = () => {};

/** Install before stores import: browser previews have no Electron preload. */
export function installBrowserBridge(target: { electronAPI?: unknown }): void {
  if (target.electronAPI) return;
  const emptyList = async () => [];
  const unavailable = async () => { throw new Error('This action requires the ConeCode desktop app.'); };
  const readers: Record<string, Record<string, unknown>> = {
    provider: { list: emptyList },
    model: { list: emptyList },
    conversation: { list: emptyList },
    message: { list: emptyList },
    favorite: { list: emptyList },
    recent: { list: emptyList },
    memory: { list: emptyList },
    settings: { get: async () => null },
    skill: { list: async () => ({ global: [], project: [] }) },
    power: { setPreventSleep: async () => false },
    notification: { show: async () => false },
    screenshot: { setShortcut: async () => ({ ok: false, error: 'Requires desktop app' }) },
    app: { getVersion: async () => 'Browser preview' },
  };
  // Unknown desktop operations reject rather than pretending writes succeeded.
  const namespaces = new Map<string, object>();
  target.electronAPI = new Proxy({}, {
    get: (_, namespace: string) => {
      // Optional native integrations must stay absent so feature guards work.
      if (['remote', 'preview', 'browser'].includes(namespace)) return undefined;
      if (!namespaces.has(namespace)) {
        namespaces.set(namespace, new Proxy(readers[namespace] || {}, {
          get: (methods, method: string) => methods[method]
            ?? (method.startsWith('on') ? () => unsubscribe : unavailable),
        }));
      }
      return namespaces.get(namespace);
    },
  });
}

if (typeof window !== 'undefined') installBrowserBridge(window);
