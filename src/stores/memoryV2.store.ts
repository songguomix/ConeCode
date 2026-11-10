import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import {
  MemoryService, LocalStorageProvider, CompositeStorageProvider, retryDelayMs,
  type Memory2Bridge, type CloudConfig, type Memory2State, type MemoryRecord,
  type MemoryQuery, type SearchHit, type StorageHealth, type SyncReport,
  type MemoryStats, type MemoryVersion, type RelationKind, type MemoryPatch,
  type ExtractionResult, type MigrationReport, type SecuritySummary,
  type NewMemoryInput, type CloudUsage, type GoogleDriveStatus,
  GoogleDriveStorageProvider, type GoogleDriveBridge, CloudStorageProvider,
} from '../core/memory/v2';
import { useModelStore } from './model.store';
import {
  loadWikiContext,
  loadWikiIndex,
  parseWikiFile,
  readLastDream,
  runDream as runDreamPass,
  sanitizeSlug,
  wikiKey,
} from '../core/memory/v2/dream';
import type { DreamReport, DreamSession, DreamStorage, WikiFile, WikiIndexEntry } from '../core/memory/v2/dream';

// The single place the rest of the app talks to Memory 2.0.
// When the Electron bridge is absent (unit tests, preview harness) the store
// stays INACTIVE and the legacy memory system keeps serving prompts. That is a
// deliberate compatibility cutover, not a stub: no existing test or RSI flow
// changes behaviour.

let service: MemoryService | null = null;
let autoSyncTimer: ReturnType<typeof setTimeout> | null = null;
let failedAttempts = 0;
let migrationInFlight = false;
let initPromise: Promise<void> | null = null;
const endedSessions = new Set<string>();

interface MemoryV2State {
  active: boolean;
  initialized: boolean;
  durable: boolean;
  busy: boolean;
  error: string | null;
  records: MemoryRecord[];
  stats: MemoryStats | null;
  settings: Memory2State['settings'] | null;
  syncStatus: ReturnType<MemoryService['getSyncStatus']> | null;
  conflicts: ReturnType<MemoryService['getConflicts']>;
  hits: SearchHit[];
  contextBlock: string;
  wikiContext: string;
  wikiEntries: WikiIndexEntry[];
  wikiSelected: WikiFile | null;
  wikiLoading: boolean;
  wikiError: string | null;
  dreaming: boolean;
  dreamError: string | null;
  lastDream: DreamReport | null;
  dreamAuto: boolean;
  cloudHealth: StorageHealth | null;
  cloudConfig: CloudConfig | null;
  security: SecuritySummary | null;
  lastSync: SyncReport | null;
  lastExtraction: ExtractionResult | null;
  migration: MigrationReport | null;
  cloudUsage: CloudUsage | null;
  devices: { deviceId: string; lastSeenAt: number }[];
  driveStatus: GoogleDriveStatus | null;
  selectedId: string | null;
  rootPath: string | null;
  projectId: string | null;

  init: (rootPath?: string | null) => Promise<void>;
  refresh: () => void;
  refreshHealth: () => Promise<void>;
  setProject: (rootPath: string | null) => Promise<void>;
  beginTask: (taskText: string, sessionId?: string) => Promise<string>;
  runDream: () => Promise<DreamReport | null>;
  setDreamAuto: (enabled: boolean) => void;
  refreshWikiContext: (taskText?: string) => Promise<void>;
  loadWikiEntries: () => Promise<void>;
  openWikiEntry: (slug: string) => Promise<void>;
  endTask: (opts: {
    messages: { role: string; content: string }[];
    sessionId?: string;
    taskText?: string;
    failed?: boolean;
    event?: any;
  }) => Promise<ExtractionResult | null>;
  /** Extract once when a conversation is left/deleted, then never re-run for the same session. */
  endSession: (sessionId: string, messages: { role: string; content: string }[]) => Promise<void>;
  recordFailure: (opts: { task: string; reason: string; resolution?: string; sessionId?: string }) => Promise<void>;
  search: (query: MemoryQuery) => Promise<SearchHit[]>;
  saveMemory: (input: NewMemoryInput) => Promise<MemoryRecord | null>;
  updateMemory: (id: string, patch: MemoryPatch, reason?: string) => Promise<void>;
  deleteMemory: (id: string, force?: boolean) => Promise<void>;
  archiveMemory: (id: string, force?: boolean) => Promise<void>;
  undo: (id: string, force?: boolean) => Promise<void>;
  restoreVersion: (id: string, version: number, force?: boolean) => Promise<void>;
  promoteWorkingMemory: (id: string) => Promise<void>;
  relate: (a: string, b: string, kind?: RelationKind) => Promise<void>;
  unrelate: (a: string, b: string) => Promise<void>;
  merge: (a: string, b: string, force?: boolean) => Promise<void>;
  history: (id: string) => MemoryVersion[];
  select: (id: string | null) => void;
  updateSettings: (patch: Partial<Memory2State['settings']>) => Promise<void>;
  configureCloud: (config: Partial<CloudConfig>) => Promise<StorageHealth>;
  testConnection: () => Promise<StorageHealth>;
  syncNow: () => Promise<SyncReport | null>;
  resolveConflict: (id: string, resolution: 'keep_local' | 'keep_remote' | 'merge') => Promise<void>;
  runMigration: (force?: boolean) => Promise<{ ok: boolean; reason?: string; report?: MigrationReport | null }>;
  backup: () => Promise<string | null>;
  restore: () => Promise<boolean>;
  exportMarkdown: () => Promise<string | null>;
  refreshCloudUsage: () => Promise<CloudUsage | null>;
  refreshDevices: () => Promise<void>;
  revokeDevice: (deviceId: string) => Promise<boolean>;
  cloudBackup: () => Promise<string | null>;
  cloudRestore: () => Promise<boolean>;
  deleteCloudData: () => Promise<boolean>;
  refreshDriveStatus: () => Promise<GoogleDriveStatus | null>;
  configureDrive: (opts: { clientId?: string; clientSecret?: string }) => Promise<GoogleDriveStatus | null>;
  connectDrive: (opts?: { clientId?: string; clientSecret?: string }) => Promise<{ ok: boolean; error?: string; status?: GoogleDriveStatus }>;
  disconnectDrive: () => Promise<boolean>;
}

function bridge(): Memory2Bridge | null {
  const api = (globalThis as any).window?.electronAPI?.memory2;
  if (!api) return null;
  return {
    load: async () => {
      const loaded = await api.load();
      // A null result means the main process caught a read failure. Surface it
      // so the local provider can fall back instead of presenting an empty store.
      if (!loaded) throw new Error('Memory 2.0 store could not be loaded');
      return loaded;
    },
    save: async (state: Memory2State) => api.save(state),
    backup: async () => api.backup(),
    restore: async () => api.restore(),
    putObject: async (key, content) => api.putObject(key, content),
    getObject: async (key) => api.getObject(key),
    deviceId: async () => api.deviceId(),
    legacySnapshot: async () => api.legacySnapshot(),
    projectId: async (rootPath) => api.projectId(rootPath),
  } as Memory2Bridge;
}

function driveBridge(): GoogleDriveBridge | null {
  const api = (globalThis as any).window?.electronAPI?.memoryDrive;
  if (!api) return null;
  return {
    status: () => api.status(),
    configure: (opts) => api.configure(opts),
    connect: (opts) => api.connect(opts),
    disconnect: () => api.disconnect(),
    health: () => api.health(),
    search: (tenantId, query) => api.search(tenantId, query),
    remoteChanges: (tenantId, since, limit) => api.remoteChanges(tenantId, since, limit),
    pushChanges: (tenantId, changes) => api.pushChanges(tenantId, changes),
    backup: (tenantId) => api.backup(tenantId),
    restore: (tenantId) => api.restore(tenantId),
    restoreSnapshot: (tenantId) => api.restoreSnapshot(tenantId),
    putObject: (tenantId, key, content) => api.putObject(tenantId, key, content),
    getObject: (tenantId, key) => api.getObject(tenantId, key),
    usage: (tenantId) => api.usage(tenantId),
    devices: (tenantId) => api.devices(tenantId),
    revokeDevice: (tenantId, deviceId) => api.revokeDevice(tenantId, deviceId),
    deleteTenantData: (tenantId) => api.deleteTenantData(tenantId),
  };
}

// The extractor uses the same provider adapters as a normal chat turn.
function extractText(result: any): string {
  if (!result || typeof result !== 'object') return '';
  const msg = result.choices?.[0]?.message;
  if (typeof msg?.content === 'string' && msg.content.trim()) return msg.content;
  if (typeof msg?.reasoning_content === 'string' && msg.reasoning_content.trim()) return msg.reasoning_content;
  if (typeof result?.reasoning_content === 'string' && result.reasoning_content.trim()) return result.reasoning_content;
  if (Array.isArray(result.content)) return result.content.map((b: any) => typeof b?.text === 'string' ? b.text : '').join('');
  const parts = result.candidates?.[0]?.content?.parts;
  if (Array.isArray(parts)) return parts.map((p: any) => typeof p?.text === 'string' ? p.text : '').join('');
  return '';
}

async function llm(req: { system: string; user: string }): Promise<string> {
  const model = useModelStore.getState().getSelectedModel();
  if (!model) return '';
  const result = await (globalThis as any).window.electronAPI.chat.stream({
    providerId: model.providerId,
    modelId: model.id,
    silent: true,
    maxTokens: 900,
    messages: [{ role: 'system', content: req.system }, { role: 'user', content: req.user }],
  });
  return extractText(result);
}

function dreamStorage(): DreamStorage {
  const api = (globalThis as any).window?.electronAPI?.memory2;
  if (!api?.putObject || !api?.getObject) throw new Error('Memory 2.0 object storage is unavailable.');
  return {
    putObject: async (key, content) => Boolean(await api.putObject(key, content)),
    getObject: async (key) => (await api.getObject(key)) ?? null,
    ...(api.listObjects
      ? {
          listObjects: async (prefix: string) => {
            const keys = await api.listObjects(prefix);
            return Array.isArray(keys) ? keys.filter((key): key is string => typeof key === 'string') : [];
          },
        }
      : {}),
    ...(api.deleteObject
      ? { deleteObject: async (key: string) => Boolean(await api.deleteObject(key)) }
      : {}),
  };
}

async function dreamLlm(req: { system: string; user: string; maxTokens?: number }): Promise<string> {
  const model = useModelStore.getState().getSelectedModel();
  if (!model) return '';
  const result = await (globalThis as any).window.electronAPI.chat.stream({
    providerId: model.providerId,
    modelId: model.id,
    silent: true,
    maxTokens: Math.min(Math.max(req.maxTokens ?? 4000, 500), 6000),
    messages: [
      { role: 'system', content: req.system },
      { role: 'user', content: req.user },
    ],
  });
  return extractText(result);
}

/**
 * Exports finished conversations as dream transcripts. The active session is
 * skipped by only taking conversations idle for at least the dream idle window.
 */
async function collectDreamSessions(now: number, rootPath: string | null): Promise<DreamSession[]> {
  const api = (globalThis as any).window?.electronAPI;
  if (!api?.conversation?.list || !api?.message?.list) return [];
  const conversations = await api.conversation.list().catch(() => []);
  if (!Array.isArray(conversations)) return [];
  const sessions: DreamSession[] = [];
  for (const conversation of conversations.slice(0, 30)) {
    const id = typeof conversation?.id === 'string' ? conversation.id : '';
    const updatedAt = Number(conversation?.updatedAt) || 0;
    if (!id || !updatedAt || now - updatedAt < 10 * 60_000) continue;
    // Keep every project's notes isolated: only sessions from this workspace.
    const conversationRoot = typeof conversation?.rootPath === 'string' ? conversation.rootPath : null;
    if (rootPath ? conversationRoot !== rootPath : conversationRoot !== null) continue;
    const rows = await api.message.list(id).catch(() => []);
    if (!Array.isArray(rows) || rows.length < 4) continue;
    sessions.push({
      id,
      title: typeof conversation.title === 'string' ? conversation.title : '',
      updatedAt,
      messages: rows.map((message: any) => ({
        role: message?.role === 'assistant' || message?.role === 'tool' || message?.role === 'system' ? message.role : 'user',
        content: typeof message?.content === 'string' ? message.content : '',
        toolName: typeof message?.toolName === 'string' ? message.toolName : undefined,
        toolCalls: Array.isArray(message?.toolCalls)
          ? message.toolCalls
              .map((call: any) => {
                if (typeof call === 'string') return call;
                if (!call || typeof call !== 'object') return '';
                const name = typeof call.name === 'string' ? call.name : '';
                if (!name) return '';
                let args = '';
                try {
                  if (call.arguments && typeof call.arguments === 'object') {
                    args = JSON.stringify(call.arguments);
                  }
                } catch {
                  args = '';
                }
                return `${name}(${args.slice(0, 300)})`;
              })
              .filter(Boolean)
              .slice(0, 10)
          : undefined,
        createdAt: typeof message?.createdAt === 'number' ? message.createdAt : undefined,
      })),
    });
    if (sessions.length >= 12) break;
  }
  return sessions;
}

let dreamTimer: ReturnType<typeof setInterval> | null = null;

function scheduleAutoDream(get: () => MemoryV2State) {
  if (dreamTimer) {
    clearInterval(dreamTimer);
    dreamTimer = null;
  }
  if (!get().dreamAuto || typeof window === 'undefined') return;
  const tick = () => {
    if (!get().active || get().dreaming) return;
    let last = 0;
    try {
      last = Number(localStorage.getItem('memoryDreamLastAt') ?? 0);
    } catch {
      last = 0;
    }
    if (Date.now() - last < 24 * 3_600_000) return;
    void get().runDream();
  };
  dreamTimer = setInterval(tick, 60 * 60_000);
  setTimeout(tick, 90_000);
}

/**
 * Auto-sync uses a recursive timer, not setInterval: a failed attempt backs off
 * exponentially (1s → 2s → … capped at 5min) and the next attempt is scheduled
 * only after the previous one finished. That prevents overlapping syncs and
 * gives offline edits a real retry path.
 */
function scheduleAutoSync(get: () => MemoryV2State, set: (partial: Partial<MemoryV2State>) => void) {
  if (autoSyncTimer) { clearTimeout(autoSyncTimer); autoSyncTimer = null; }
  if (!service) return;
  const cfg = service.getCloudConfig();
  if (!cfg.enabled || !cfg.autoSync || !cfg.baseUrl) return;

  const tick = async () => {
    autoSyncTimer = null;
    if (!service) return;
    if (!get().busy && !service.getSyncStatus().inFlight) {
      try {
        const { report } = await service.syncMemory('auto');
        failedAttempts = report.ok ? 0 : failedAttempts + 1;
        set({ lastSync: report, syncStatus: service.getSyncStatus() });
        get().refresh();
      } catch {
        failedAttempts += 1;
      }
    }
    scheduleAutoSync(get, set);
  };
  const delay = failedAttempts > 0
    ? retryDelayMs(failedAttempts)
    : Math.max(15_000, cfg.syncIntervalMs);
  autoSyncTimer = setTimeout(() => { void tick(); }, delay);
}

export const useMemoryV2Store = create<MemoryV2State>((set, get) => ({
  active: false,
  initialized: false,
  durable: false,
  busy: false,
  error: null,
  records: [],
  stats: null,
  settings: null,
  syncStatus: null,
  conflicts: [],
  hits: [],
  contextBlock: '',
  wikiContext: '',
  wikiEntries: [],
  wikiSelected: null,
  wikiLoading: false,
  wikiError: null,
  dreaming: false,
  dreamError: null,
  lastDream: null,
  dreamAuto: (() => {
    try {
      return localStorage.getItem('memoryDreamAuto') === '1';
    } catch {
      return false;
    }
  })(),
  cloudHealth: null,
  cloudConfig: null,
  security: null,
  lastSync: null,
  lastExtraction: null,
  migration: null,
  cloudUsage: null,
  devices: [],
  driveStatus: null,
  selectedId: null,
  rootPath: null,
  projectId: null,

  init: async (rootPath) => {
    if (get().initialized) return;
    // App startup and the first chat turn can both call init. Share one
    // in-flight promise instead of creating two services over one store.
    if (initPromise) return initPromise;
    initPromise = (async () => {
      const b = bridge();
      const local = new LocalStorageProvider(b);
      const composite = new CompositeStorageProvider(local, null);
      const deviceId = b ? await b.deviceId().catch(() => '') : 'renderer-fallback';
      service = new MemoryService({
        storage: composite,
        makeId: uuidv4,
        deviceId: deviceId || 'renderer-fallback',
        llm,
        cloudFactory: (cfg, id) => cfg.provider === 'google-drive'
          ? new GoogleDriveStorageProvider(driveBridge(), {
              tenantId: cfg.tenantId,
              encryption: cfg.encryption,
              e2ePassphrase: cfg.e2ePassphrase,
            })
          : new CloudStorageProvider({ config: cfg, deviceId: id }),
        onChange: (state) => set({ records: [...state.records], conflicts: [...state.sync.conflicts] }),
      });
      try {
        const { durable } = await service.init();
        set({ active: durable, initialized: true, durable, cloudConfig: service.getCloudConfig(), security: service.getSecuritySummary() });
        get().refresh();
        await get().setProject(rootPath ?? null);
        scheduleAutoSync(get, set);
        scheduleAutoDream(get);
        void get().refreshWikiContext();
        void get().refreshHealth();
        // First-run migration is automatic but strictly additive and verified.
        if (durable) void get().runMigration(false);
      } catch (e: any) {
        set({ active: false, initialized: true, durable: false, error: e?.message ?? String(e) });
      }
    })();
    try {
      await initPromise;
    } finally {
      initPromise = null;
    }
  },

  refresh: () => {
    if (!service) return;
    set({
      records: [...service.getState().records],
      stats: service.getStats(),
      settings: { ...service.getState().settings },
      syncStatus: service.getSyncStatus(),
      conflicts: service.getConflicts(),
      hits: service.getLastHits(),
      contextBlock: service.getTaskContextBlock(),
      cloudConfig: service.getCloudConfig(),
      security: service.getSecuritySummary(),
      migration: service.getState().migration.report ?? null,
      lastExtraction: service.getLastExtraction(),
      lastSync: service.getLastSyncReport() ?? get().lastSync,
    });
  },

  refreshHealth: async () => {
    if (!service) return;
    await service.refreshHealth();
    get().refresh();
  },

  setProject: async (rootPath) => {
    const previous = get().rootPath;
    set({ rootPath });
    if (!service) return;
    let resolved: string | undefined;
    if (rootPath && bridge()) {
      // Resolve a stable UUID that survives folder renames. A git remote makes
      // the same project shareable across devices.
      resolved = await bridge()!.projectId(rootPath).catch(() => undefined);
      await (globalThis as any).window?.electronAPI?.memory2?.setRoot?.(rootPath).catch?.(() => undefined);
    } else if (bridge()) {
      await (globalThis as any).window?.electronAPI?.memory2?.setRoot?.(null).catch?.(() => undefined);
    }
    service.setProject(rootPath, resolved);
    set({ contextBlock: '', hits: [], selectedId: null, projectId: service.getProjectId(), wikiContext: '' });
    void get().refreshWikiContext();
    // Opening a different workspace migrates that project's legacy rows (the
    // migration is idempotent and never touches the old files).
    if (previous !== rootPath && get().durable) void get().runMigration(false);
  },

  beginTask: async (taskText, sessionId) => {
    if (!service || !get().active) return '';
    try {
      if (sessionId) {
        service.setSession(sessionId);
        // New activity in a session makes it eligible for a later session-end pass.
        endedSessions.delete(sessionId);
      }
      const block = await service.beginTask(taskText);
      set({ contextBlock: block, hits: service.getLastHits() });
      await get().refreshWikiContext(taskText);
      return block;
    } catch { return ''; }
  },

  refreshWikiContext: async (taskText = '') => {
    if (!service || !get().active) {
      set({ wikiContext: '' });
      return;
    }
    try {
      const scope = get().projectId || 'default';
      const result = await loadWikiContext(dreamStorage(), scope, taskText);
      const last = await readLastDream(dreamStorage(), scope);
      set({
        wikiContext: result.block,
        wikiEntries: result.items,
        ...(last ? { lastDream: last } : {}),
      });
    } catch {
      set({ wikiContext: '' });
    }
  },

  loadWikiEntries: async () => {
    if (!service || !get().active) {
      set({ wikiEntries: [], wikiSelected: null });
      return;
    }
    set({ wikiLoading: true, wikiError: null });
    try {
      const entries = await loadWikiIndex(dreamStorage(), get().projectId || 'default');
      const selected = get().wikiSelected;
      set({
        wikiEntries: entries,
        wikiLoading: false,
        ...(selected && !entries.some((entry) => entry.slug === selected.slug) ? { wikiSelected: null } : {}),
      });
    } catch (error) {
      set({
        wikiLoading: false,
        wikiError: error instanceof Error ? error.message : String(error),
      });
    }
  },

  openWikiEntry: async (slug) => {
    if (!service || !get().active) return;
    const safe = sanitizeSlug(slug);
    if (!safe) {
      set({ wikiError: 'Invalid topic name.' });
      return;
    }
    try {
      const raw = await dreamStorage().getObject(wikiKey(get().projectId || 'default', safe));
      const file = parseWikiFile(raw);
      set({
        wikiSelected: file,
        wikiError: file ? null : 'Topic not found.',
        wikiLoading: false,
      });
    } catch (error) {
      set({ wikiError: error instanceof Error ? error.message : String(error) });
    }
  },

  runDream: async () => {
    if (!service || !get().active) {
      set({ dreamError: 'Memory 2.0 is not active.' });
      return null;
    }
    if (get().dreaming) return null;
    if (!useModelStore.getState().getSelectedModel()) {
      set({ dreamError: 'Select a model before running a dream.' });
      return null;
    }
    set({ dreaming: true, dreamError: null });
    try {
      const now = Date.now();
      const sessions = await collectDreamSessions(now, get().rootPath);
      const scope = get().projectId || 'default';
      const report = await runDreamPass(dreamStorage(), dreamLlm, { scope, sessions, now });
      try {
        localStorage.setItem('memoryDreamLastAt', String(now));
      } catch {
        // Non-fatal: auto-dream will simply try again next hour.
      }
      set({ dreaming: false, lastDream: report });
      await get().refreshWikiContext();
      return report;
    } catch (error) {
      set({
        dreaming: false,
        dreamError: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  },

  setDreamAuto: (enabled) => {
    try {
      localStorage.setItem('memoryDreamAuto', enabled ? '1' : '0');
    } catch {
      // Non-fatal: applies for this session only.
    }
    set({ dreamAuto: enabled });
    scheduleAutoDream(get);
  },

  endTask: async (opts) => {
    if (!service || !get().active) return null;
    try {
      const result = await service.endTask(opts);
      set({ lastExtraction: result });
      get().refresh();
      return result;
    } catch { return null; }
  },

  endSession: async (sessionId, messages) => {
    if (!service || !get().active || !sessionId || endedSessions.has(sessionId)) return;
    endedSessions.add(sessionId);
    try {
      const result = await service.endTask({
        messages,
        sessionId,
        event: 'session_end',
      });
      set({ lastExtraction: result });
      get().refresh();
    } catch {
      // Memory is an enhancement; a failed session-end extraction is invisible.
    }
  },

  recordFailure: async (opts) => {
    if (!service || !get().active) return;
    try { await service.recordFailure(opts); get().refresh(); } catch { /* never break the turn */ }
  },

  search: async (query) => service ? service.searchMemory(query) : [],
  history: (id) => service ? service.getMemoryHistory(id) : [],
  select: (id) => set({ selectedId: id }),

  saveMemory: async (input) => {
    if (!service) return null;
    set({ busy: true, error: null });
    try { const record = await service.saveMemory(input); get().refresh(); return record; }
    catch (e: any) { set({ error: e?.message ?? String(e) }); return null; }
    finally { set({ busy: false }); }
  },

  updateMemory: async (id, patch, reason) => {
    if (!service) return;
    set({ busy: true, error: null });
    try { await service.updateMemory(id, patch, reason); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
    finally { set({ busy: false }); }
  },

  deleteMemory: async (id, force) => {
    if (!service) return;
    set({ busy: true, error: null });
    try { await service.deleteMemory(id, force); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
    finally { set({ busy: false }); }
  },

  archiveMemory: async (id, force) => {
    if (!service) return;
    set({ busy: true, error: null });
    try { await service.archiveMemory(id, force); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
    finally { set({ busy: false }); }
  },

  undo: async (id, force) => {
    if (!service) return;
    try { await service.undo(id, force); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  restoreVersion: async (id, version, force) => {
    if (!service) return;
    try { await service.restoreVersion(id, version, force); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  promoteWorkingMemory: async (id) => {
    if (!service) return;
    try { await service.promoteWorkingMemory(id); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  relate: async (a, b, kind) => {
    if (!service) return;
    try { await service.relateMemory(a, b, kind); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  unrelate: async (a, b) => {
    if (!service) return;
    try { await service.unrelateMemory(a, b); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  merge: async (a, b, force) => {
    if (!service) return;
    try { await service.mergeTwo(a, b, force); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  updateSettings: async (patch) => {
    if (!service) return;
    try { await service.updateSettings(patch); get().refresh(); }
    catch (e: any) { set({ error: e?.message ?? String(e) }); }
  },

  configureCloud: async (config) => {
    if (!service) return { ok: false, kind: 'cloud', configured: false, message: 'Memory 2.0 is not initialised' };
    const { health } = await service.configureCloud(config);
    failedAttempts = 0;
    set({ cloudHealth: health, cloudConfig: service.getCloudConfig(), security: service.getSecuritySummary() });
    get().refresh();
    scheduleAutoSync(get, set);
    return health;
  },

  testConnection: async () => {
    if (!service) return { ok: false, kind: 'cloud', configured: false, message: 'Memory 2.0 is not initialised' };
    const health = await service.testConnection();
    set({ cloudHealth: health });
    return health;
  },

  syncNow: async () => {
    if (!service) return null;
    set({ busy: true });
    try {
      const { report } = await service.syncMemory('manual');
      failedAttempts = report.ok ? 0 : failedAttempts + 1;
      set({ lastSync: report });
      get().refresh();
      scheduleAutoSync(get, set);
      return report;
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
      return null;
    } finally { set({ busy: false }); }
  },

  resolveConflict: async (id, resolution) => {
    if (!service) return;
    await service.resolveConflict(id, resolution);
    get().refresh();
  },

  runMigration: async (force = false) => {
    if (!service) return { ok: false, reason: 'Memory 2.0 is not initialised' };
    if (migrationInFlight) return { ok: false, reason: 'migration already in progress' };
    migrationInFlight = true;
    try {
      const result = await service.runMigration({ force });
      get().refresh();
      return result;
    } catch (e: any) {
      return { ok: false, reason: e?.message ?? String(e) };
    } finally {
      migrationInFlight = false;
    }
  },

  backup: async () => service ? service.backup() : null,
  restore: async () => {
    if (!service) return false;
    const ok = await service.restore();
    get().refresh();
    return ok;
  },
  exportMarkdown: async () => service ? service.exportMarkdown() : null,

  refreshCloudUsage: async () => {
    if (!service) return null;
    const usage = await service.getCloudUsage();
    set({ cloudUsage: usage });
    return usage;
  },

  refreshDevices: async () => {
    if (!service) return;
    const devices = await service.getCloudDevices();
    set({ devices });
  },

  revokeDevice: async (deviceId) => {
    if (!service) return false;
    const ok = await service.revokeCloudDevice(deviceId);
    if (ok) await get().refreshDevices();
    return ok;
  },

  cloudBackup: async () => service ? service.cloudBackup() : null,
  cloudRestore: async () => {
    if (!service) return false;
    const ok = await service.cloudRestore();
    if (ok) {
      // The cloud restored its own copy; pull the new change feed into local.
      await get().syncNow();
      get().refresh();
    }
    return ok;
  },
  deleteCloudData: async () => {
    if (!service) return false;
    const ok = await service.deleteCloudData();
    if (ok) {
      set({ cloudUsage: null, devices: [] });
      await get().refreshHealth();
    }
    return ok;
  },

  refreshDriveStatus: async () => {
    const bridge = driveBridge();
    if (!bridge) { set({ driveStatus: null }); return null; }
    try {
      const status = await bridge.status();
      set({ driveStatus: status });
      return status;
    } catch (e: any) {
      set({ driveStatus: { configured: false, connected: false, clientIdSet: false, source: 'none', error: e?.message ?? String(e) } });
      return get().driveStatus;
    }
  },

  configureDrive: async (opts) => {
    const bridge = driveBridge();
    if (!bridge) return null;
    try {
      const status = await bridge.configure(opts);
      set({ driveStatus: status });
      return status;
    } catch (e: any) {
      set({ error: e?.message ?? String(e) });
      return null;
    }
  },

  connectDrive: async (opts) => {
    const bridge = driveBridge();
    if (!bridge) return { ok: false, error: 'Google Drive is only available in the desktop app' };
    try {
      const result = await bridge.connect(opts);
      if (result.status) set({ driveStatus: result.status });
      else await get().refreshDriveStatus();
      if (result.ok) {
        // Connecting is one click: enable Drive as the active cloud provider.
        const clientId = opts?.clientId || get().cloudConfig?.googleClientId || get().driveStatus?.clientId || '';
        await get().configureCloud({
          enabled: true,
          provider: 'google-drive',
          ...(clientId ? { googleClientId: clientId } : {}),
        });
      }
      return result;
    } catch (e: any) {
      return { ok: false, error: e?.message ?? String(e) };
    }
  },

  disconnectDrive: async () => {
    const bridge = driveBridge();
    if (!bridge) return false;
    const ok = await bridge.disconnect();
    await get().refreshDriveStatus();
    if (ok) await get().configureCloud({ enabled: false });
    return ok;
  },
}));

/** Is Memory 2.0 serving prompts? Used by the chat store's compatibility cutover. */
export function isMemoryV2Active(): boolean {
  return useMemoryV2Store.getState().active;
}

/** The block computed at task start, injected into the system prompt. */
export function memoryV2ContextBlock(): string {
  const state = useMemoryV2Store.getState();
  if (!state.active) return '';
  return [state.contextBlock, state.wikiContext].filter(Boolean).join('\n\n');
}
