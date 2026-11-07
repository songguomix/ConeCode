// Visual harness for the Memory 2.0 panel. Uses a fake Electron bridge so the
// real store, service, retrieval and mutation paths run in the browser without
// Electron — no static mock data in the component itself.
//   ?locale=zh|zhHant|ja  — check the other translations
import React from 'react';
import ReactDOM from 'react-dom/client';
import '../src/index.css';
import MemoryPanel from '../src/components/memory/MemoryPanel';
import { useWorkspaceStore } from '../src/stores/workspace.store';
import { useLanguageStore, type Locale } from '../src/stores/language.store';
import { useMemoryV2Store } from '../src/stores/memoryV2.store';
import { createRecord, emptyState } from '../src/core/memory/v2';

const ROOT = '/Users/dev/conecode';
const PROJECT = 'proj-preview';

const now = Date.now();
const state = emptyState();
state.cloud.enabled = false;
state.records = [
  createRecord({
    content: 'Always run the test suite and report the real output before calling a task done.',
    type: 'constraint', layer: 'global', status: 'confirmed', origin: 'user', importance: 0.95,
    why: 'a task was once reported done without running the tests',
    tags: ['workflow', 'tests'],
  }, { id: 'preview-1', deviceId: 'preview', now: now - 86_400_000 }),
  createRecord({
    content: 'Pure logic lives in src/core so it can be unit-tested; anything touching the OS belongs in electron/.',
    type: 'architecture', layer: 'project', projectId: PROJECT, status: 'confirmed', origin: 'user',
    importance: 0.88, tags: ['architecture', 'testing'],
    why: 'this split is what lets the preview engine be tested without Electron',
  }, { id: 'preview-2', deviceId: 'preview', now: now - 3 * 86_400_000 }),
  createRecord({
    content: 'The preview dev server reload race was fixed by debouncing the file watcher for 80ms.',
    type: 'success_experience', layer: 'episodic', projectId: PROJECT, status: 'inferred', origin: 'extracted',
    importance: 0.72, confidence: 0.7, tags: ['preview', 'bug', 'lesson'],
    why: 'the initial reload test timed out until the watcher debounce was added',
  }, { id: 'preview-3', deviceId: 'preview', now: now - 2 * 86_400_000 }),
  createRecord({
    content: 'When a memory conflicts with a user-confirmed fact, keep both versions and mark the new one pending.',
    type: 'reusable_knowledge', layer: 'semantic', projectId: PROJECT, status: 'confirmed', origin: 'user',
    importance: 0.9, tags: ['memory', 'conflict'],
    why: 'silent overwrites destroyed an earlier architecture decision in testing',
  }, { id: 'preview-4', deviceId: 'preview', now: now - 7 * 86_400_000 }),
  createRecord({
    content: 'Currently migrating the old flat memory.json into the layered model.',
    type: 'progress', layer: 'working', projectId: PROJECT, status: 'confirmed', origin: 'tool',
    importance: 0.4, tags: ['working', 'current-task'],
  }, { id: 'preview-5', deviceId: 'preview', now: now - 3_600_000 }),
  createRecord({
    content: 'A legacy note that could not be classified with confidence.',
    type: 'project_fact', layer: 'project', projectId: PROJECT, status: 'pending', origin: 'migration',
    importance: 0.5, needsTriage: true, tags: ['migrated', 'needs-triage'],
  }, { id: 'preview-6', deviceId: 'preview', now: now - 9 * 86_400_000 }),
  createRecord({
    content: 'ANOTHER PROJECT — must not appear in this workspace.',
    type: 'project_fact', layer: 'project', projectId: 'proj-other', status: 'confirmed', origin: 'user',
    importance: 0.9,
  }, { id: 'preview-7', deviceId: 'preview', now }),
];
// A visible version history for the architecture memory.
state.records[1].version = 3;
state.records[1].history = [
  {
    version: 1, title: 'Layering', content: 'Logic lives in src/core.', type: 'architecture',
    layer: 'project', status: 'inferred', importance: 0.6, confidence: 0.6, tags: ['architecture'],
    relatedMemoryIds: [], at: now - 5 * 86_400_000, deviceId: 'preview', reason: 'initial extraction',
  },
  {
    version: 2, title: 'Layering', content: 'Pure logic lives in src/core so it can be tested.', type: 'architecture',
    layer: 'project', status: 'inferred', importance: 0.75, confidence: 0.7, tags: ['architecture', 'testing'],
    relatedMemoryIds: [], at: now - 4 * 86_400_000, deviceId: 'preview', reason: 'reinforced',
  },
];

let saved = state;
const api = {
  memory: { list: async () => [], save: async () => true },
  memory2: {
    setRoot: async () => true,
    load: async () => saved,
    save: async (next: any) => { saved = next; return true; },
    backup: async () => ({ ok: true, path: 'preview-memory2.backup.json' }),
    restore: async () => ({ ok: true, state: saved }),
    putObject: async () => true,
    getObject: async () => null,
    deviceId: async () => 'preview-device',
    legacySnapshot: async () => ({ entries: [], files: [] }),
    projectId: async () => PROJECT,
  },
  memoryDrive: {
    status: async () => ({ configured: true, connected: true, email: 'preview@gmail.com', clientId: 'preview-client-id.apps.googleusercontent.com', clientIdSet: true, source: 'env' }),
    configure: async () => ({ configured: true, connected: true, email: 'preview@gmail.com', clientIdSet: true, source: 'saved' }),
    connect: async () => ({ ok: true, status: { configured: true, connected: true, email: 'preview@gmail.com', clientId: 'preview-client-id.apps.googleusercontent.com', clientIdSet: true, source: 'env' } }),
    disconnect: async () => true,
    health: async () => ({ ok: true, kind: 'cloud', configured: true, message: 'Google Drive · preview@gmail.com' }),
    search: async () => [],
    remoteChanges: async (_tenant: string, since: number) => ({ changes: [], cursor: since }),
    pushChanges: async () => ({ ok: true, acceptedChangeIds: [], cursor: 0, conflicts: [] }),
    backup: async () => 'conecode-memory2-backup-preview.json',
    restore: async () => true,
    restoreSnapshot: async () => null,
    putObject: async () => true,
    getObject: async () => null,
    usage: async () => ({ records: 7, changes: 9, objects: 1, bytes: 4096, devices: [], accountEmail: 'preview@gmail.com', quotaUsed: 123456, quotaLimit: 15 * 1024 * 1024 * 1024 }),
    devices: async () => [{ deviceId: 'preview-device', lastSeenAt: Date.now() }],
    revokeDevice: async () => true,
    deleteTenantData: async () => true,
  },
};
(window as any).electronAPI = api;

useWorkspaceStore.setState({ rootPath: ROOT });
const locale = (new URLSearchParams(location.search).get('locale') as Locale) || 'en';
useLanguageStore.setState({ locale });
// The panel itself calls init(); this keeps StrictMode's double mount harmless.
void useMemoryV2Store.getState().init(ROOT);

function Harness() {
  const { t } = useLanguageStore();
  return (
    <div className="min-h-screen bg-[var(--bg-0)] p-4 sm:p-8">
      <div className="max-w-[760px] mx-auto"><MemoryPanel t={t} /></div>
    </div>
  );
}
ReactDOM.createRoot(document.getElementById('root')!).render(<Harness />);
