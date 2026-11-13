import { useEffect, useMemo, useState } from 'react';
import {
  FiActivity, FiAlertCircle, FiArchive, FiArrowRight, FiCheck, FiChevronRight,
  FiCloud, FiCloudOff, FiCpu, FiDatabase, FiDownload, FiEdit3, FiFileText,
  FiBookOpen, FiHardDrive, FiClock, FiLink, FiLoader, FiMoon, FiPlus, FiRefreshCw, FiSearch,
  FiServer, FiSettings, FiShield, FiTag, FiTrash2, FiUpload, FiX, FiZap,
} from 'react-icons/fi';
import { useMemoryV2Store } from '../../stores/memoryV2.store';
import { useModelStore } from '../../stores/model.store';
import { useChatStore, useWorkspaceStore } from '../../stores';
import type {
  CloudConfig, MemoryLayer, MemoryQuery, MemoryRecord, MemoryStatus,
  MemoryType, NewMemoryInput, RelationKind,
} from '../../core/memory/v2';
import { securitySummary } from '../../core/memory/v2/security';
import LegacyMemoryPanel from './MemoryPanelLegacy';

type T = (key: string) => string;
type Tab = 'overview' | 'explorer' | 'search' | 'wiki' | 'cloud';

const LAYERS: MemoryLayer[] = ['global', 'project', 'episodic', 'semantic', 'working'];
const TYPES: MemoryType[] = [
  'user_fact', 'project_fact', 'architecture', 'technical_decision', 'decision_reason',
  'constraint', 'task_result', 'progress', 'todo', 'success_experience',
  'failure_experience', 'known_bug', 'reusable_knowledge',
];
const STATUSES: MemoryStatus[] = ['confirmed', 'inferred', 'pending', 'superseded', 'archived'];
const RELATION_KINDS: RelationKind[] = ['related', 'supersedes', 'derived_from', 'caused_by', 'solves', 'part_of', 'conflicts_with'];

const LAYER_ICON: Record<MemoryLayer, JSX.Element> = {
  global: <FiCpu size={12} />,
  project: <FiDatabase size={12} />,
  episodic: <FiActivity size={12} />,
  semantic: <FiZap size={12} />,
  working: <FiLoader size={12} />,
};

const STATUS_TONE: Record<MemoryStatus, string> = {
  confirmed: 'text-[var(--success)] border-[color-mix(in_srgb,var(--success)_35%,transparent)] bg-[color-mix(in_srgb,var(--success)_10%,transparent)]',
  inferred: 'text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_35%,transparent)] bg-[color-mix(in_srgb,var(--warning)_10%,transparent)]',
  pending: 'text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_35%,transparent)] bg-[var(--accent-soft)]',
  superseded: 'text-[var(--text-muted)] border-[var(--border)] bg-[var(--bg-1)]',
  archived: 'text-[var(--text-muted)] border-[var(--border)] bg-[var(--bg-1)]',
};

function fmtTime(ts: number | null | undefined): string {
  if (!ts) return '—';
  try {
    return new Date(ts).toLocaleString(undefined, {
      month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit',
    });
  } catch { return '—'; }
}

function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let value = n;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) { value /= 1024; i++; }
  return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

function pct(n: number): string {
  return `${Math.round(Math.max(0, Math.min(1, n)) * 100)}%`;
}

function isVisible(record: MemoryRecord, projectId: string | null): boolean {
  if (record.layer === 'global') return true;
  return !!projectId && record.projectId === projectId;
}

function Chip({ children, className = '' }: { children: React.ReactNode; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-1 rounded-full border px-1.5 py-0.5 text-[10px] font-medium ${className || 'border-[var(--border)] bg-[var(--bg-1)] text-[var(--text-muted)]'}`}>
      {children}
    </span>
  );
}

function Stat({ label, value, hint, tone = 'text-[var(--text-primary)]' }: {
  label: string; value: string | number; hint?: string; tone?: string;
}) {
  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] px-3 py-2.5 min-w-0">
      <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] truncate">{label}</div>
      <div className={`mt-0.5 text-lg font-semibold tabular-nums ${tone}`}>{value}</div>
      {hint && <div className="text-[10px] text-[var(--text-muted)] truncate">{hint}</div>}
    </div>
  );
}

function HealthDot({ ok, configured }: { ok: boolean; configured: boolean }) {
  return (
    <span className={`inline-block h-2 w-2 rounded-full ${ok ? 'bg-[var(--success)]' : configured ? 'bg-[var(--warning)]' : 'bg-[var(--text-muted)]'}`} />
  );
}

export default function MemoryPanel({ t }: { t: T }) {
  const initialized = useMemoryV2Store((s) => s.initialized);
  const active = useMemoryV2Store((s) => s.active);
  const init = useMemoryV2Store((s) => s.init);
  const rootPath = useWorkspaceStore((s) => s.rootPath);

  useEffect(() => {
    if (!initialized) void init(rootPath);
  }, [initialized, init, rootPath]);

  if (!initialized) {
    return (
      <div className="flex items-center gap-2 px-3 py-6 text-xs text-[var(--text-muted)]">
        <FiLoader size={14} className="animate-spin" /> {t('memoryLoading')}
      </div>
    );
  }

  // No Electron bridge / durable store: keep the proven legacy memory panel
  // instead of showing a Memory 2.0 shell that cannot persist anything.
  if (!active) return <LegacyMemoryPanel t={t} />;
  return <MemoryV2Panel t={t} />;
}

function MemoryV2Panel({ t }: { t: T }) {
  const records = useMemoryV2Store((s) => s.records);
  const stats = useMemoryV2Store((s) => s.stats);
  const settings = useMemoryV2Store((s) => s.settings);
  const syncStatus = useMemoryV2Store((s) => s.syncStatus);
  const conflicts = useMemoryV2Store((s) => s.conflicts);
  const cloudConfig = useMemoryV2Store((s) => s.cloudConfig);
  const security = useMemoryV2Store((s) => s.security);
  const cloudHealth = useMemoryV2Store((s) => s.cloudHealth);
  const lastSync = useMemoryV2Store((s) => s.lastSync);
  const migration = useMemoryV2Store((s) => s.migration);
  const cloudUsage = useMemoryV2Store((s) => s.cloudUsage);
  const devices = useMemoryV2Store((s) => s.devices);
  const projectId = useMemoryV2Store((s) => s.projectId);
  const selectedId = useMemoryV2Store((s) => s.selectedId);
  const select = useMemoryV2Store((s) => s.select);
  const updateSettings = useMemoryV2Store((s) => s.updateSettings);
  const refreshHealth = useMemoryV2Store((s) => s.refreshHealth);
  const error = useMemoryV2Store((s) => s.error);
  const wikiEntries = useMemoryV2Store((s) => s.wikiEntries);
  const busy = useMemoryV2Store((s) => s.busy);
  const [tab, setTab] = useState<Tab>('overview');

  useEffect(() => { void refreshHealth(); }, [refreshHealth]);

  const visible = useMemo(() => records.filter((r) => isVisible(r, projectId)), [records, projectId]);
  const activeRecords = useMemo(() => visible.filter((r) => r.deletedAt === null && r.status !== 'archived'), [visible]);
  const selected = useMemo(() => visible.find((r) => r.id === selectedId) ?? null, [visible, selectedId]);

  const openRecord = (id: string) => {
    select(id);
    setTab('explorer');
  };

  const tabs: { id: Tab; label: string; icon: JSX.Element; badge?: number }[] = [
    { id: 'overview', label: t('memoryTabOverview'), icon: <FiActivity size={12} /> },
    { id: 'explorer', label: t('memoryTabExplorer'), icon: <FiDatabase size={12} />, badge: activeRecords.length },
    { id: 'search', label: t('memoryTabSearch'), icon: <FiSearch size={12} /> },
    { id: 'wiki', label: t('memoryWikiTab'), icon: <FiBookOpen size={12} />, badge: wikiEntries.length || undefined },
    { id: 'cloud', label: t('memoryTabCloud'), icon: <FiCloud size={12} />, badge: conflicts.length || undefined },
  ];

  return (
    <div className="min-w-0 space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2 pb-2 border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)]">
        <div className="flex items-center gap-2 min-w-0">
          <span className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_25%,transparent)] flex items-center justify-center shrink-0">
            <FiCpu size={14} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="text-sm font-semibold text-[var(--text-primary)]">Memory 2.0</span>
            </div>
            <div className="text-[10px] text-[var(--text-muted)] truncate">
              {t('memoryV2Subtitle')} · {activeRecords.length} {t('memoryRecords')}
            </div>
          </div>
        </div>
        <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer shrink-0">
          <input
            type="checkbox"
            checked={settings?.enabled !== false}
            onChange={(e) => void updateSettings({ enabled: e.target.checked })}
            className="accent-[var(--accent)] rounded"
          />
          {t('memoryEnabled')}
        </label>
      </div>

      {error && (
        <div className="flex items-start gap-2 rounded-xl border border-[color-mix(in_srgb,var(--error)_35%,transparent)] bg-[color-mix(in_srgb,var(--error)_8%,transparent)] px-3 py-2 text-[11px] text-[var(--error)]">
          <FiAlertCircle size={13} className="mt-0.5 shrink-0" />
          <span className="min-w-0 [overflow-wrap:anywhere]">{error}</span>
        </div>
      )}

      <div className="flex items-center gap-1 overflow-x-auto pb-0.5">
        {tabs.map((item) => (
          <button
            key={item.id}
            onClick={() => setTab(item.id)}
            className={`shrink-0 inline-flex items-center gap-1.5 rounded-lg px-2.5 py-1.5 text-[11px] font-medium transition-colors cursor-pointer ${
              tab === item.id
                ? 'bg-[var(--bg-2)] text-[var(--text-primary)] border border-[var(--border)] shadow-2xs'
                : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-1)] border border-transparent'
            }`}
          >
            {item.icon}
            {item.label}
            {item.badge ? (
              <span className="rounded-full bg-[var(--accent-soft)] text-[var(--accent)] px-1.5 py-0 text-[9px] font-mono">{item.badge}</span>
            ) : null}
          </button>
        ))}
      </div>

      {tab === 'overview' && (
        <div className="space-y-3">
          <DreamCard t={t} onOpenWiki={() => setTab('wiki')} />
          <OverviewTab
            t={t}
            records={visible}
            activeRecords={activeRecords}
            stats={stats}
            settings={settings}
            syncStatus={syncStatus}
            cloudHealth={cloudHealth}
            cloudConfig={cloudConfig}
            lastSync={lastSync}
            migration={migration}
            onOpen={openRecord}
            onTab={setTab}
            />
        </div>
      )}
      {tab === 'explorer' && (
        <ExplorerTab
          t={t}
          records={visible}
          projectId={projectId}
          selected={selected}
          busy={busy}
          onSelect={select}
        />
      )}
      {tab === 'search' && (
        <SearchTab t={t} projectId={projectId} cloudConfigured={!!cloudConfig?.enabled} onOpen={openRecord} />
      )}
      {tab === 'wiki' && <WikiTab t={t} />}
      {tab === 'cloud' && (
        <CloudTab
          t={t}
          config={cloudConfig}
          security={security}
          health={cloudHealth}
          syncStatus={syncStatus}
          lastSync={lastSync}
          conflicts={conflicts}
          usage={cloudUsage}
          devices={devices}
          busy={busy}
          migration={migration}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dream wiki browser (read-only)
function WikiTab({ t }: { t: T }) {
  const entries = useMemoryV2Store((s) => s.wikiEntries);
  const selected = useMemoryV2Store((s) => s.wikiSelected);
  const loading = useMemoryV2Store((s) => s.wikiLoading);
  const error = useMemoryV2Store((s) => s.wikiError);
  const load = useMemoryV2Store((s) => s.loadWikiEntries);
  const open = useMemoryV2Store((s) => s.openWikiEntry);

  useEffect(() => {
    void load();
  }, [load]);

  return (
    <div className="space-y-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
            {t('memoryWikiTitle')}
          </h4>
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">{t('memoryWikiReadonly')}</p>
        </div>
        <button
          onClick={() => void load()}
          disabled={loading}
          aria-label={t('memoryWikiTitle')}
          className="shrink-0 inline-flex items-center justify-center rounded-lg bg-[var(--bg-2)] border border-[var(--border)] p-1.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer"
        >
          <FiRefreshCw size={11} className={loading ? 'animate-spin' : ''} />
        </button>
      </div>
      {error && <p className="text-[10px] text-[var(--error)] [overflow-wrap:anywhere]">{error}</p>}
      {loading && entries.length === 0 ? (
        <p className="text-[11px] text-[var(--text-muted)]">{t('memoryWikiLoading')}</p>
      ) : entries.length === 0 ? (
        <p className="text-[11px] text-[var(--text-muted)]">{t('memoryWikiEmpty')}</p>
      ) : (
        <div className="grid gap-2">
          <ul className="max-h-48 overflow-y-auto rounded-xl border border-[var(--border)] divide-y divide-[var(--border)]">
            {entries.map((entry) => (
              <li key={entry.slug}>
                <button
                  onClick={() => void open(entry.slug)}
                  aria-pressed={selected?.slug === entry.slug}
                  className={`w-full text-left px-2.5 py-1.5 transition-colors cursor-pointer ${
                    selected?.slug === entry.slug ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-2)]'
                  }`}
                >
                  <span className="block truncate text-[11.5px] text-[var(--text-primary)]">{entry.name}</span>
                  <span className="block text-[10px] text-[var(--text-muted)] truncate">
                    {entry.domain} · {entry.description}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-3 max-h-64 overflow-y-auto">
            {selected ? (
              <>
                <h5 className="text-[12px] font-semibold text-[var(--text-primary)] break-words [overflow-wrap:anywhere]">
                  {selected.name}
                </h5>
                <p className="text-[10px] text-[var(--text-muted)] mb-2">
                  {selected.domain} · {t('memoryWikiUpdated')}{' '}
                  {selected.updated ? new Date(selected.updated).toLocaleDateString() : '—'}
                </p>
                <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">
                  {selected.body}
                </p>
              </>
            ) : (
              <p className="text-[11px] text-[var(--text-muted)]">{t('memoryWikiSelect')}</p>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Dream
function DreamCard({ t, onOpenWiki }: { t: T; onOpenWiki?: () => void }) {
  const active = useMemoryV2Store((s) => s.active);
  const dreaming = useMemoryV2Store((s) => s.dreaming);
  const dreamError = useMemoryV2Store((s) => s.dreamError);
  const dreamAuto = useMemoryV2Store((s) => s.dreamAuto);
  const lastDream = useMemoryV2Store((s) => s.lastDream);
  const runDream = useMemoryV2Store((s) => s.runDream);
  const setDreamAuto = useMemoryV2Store((s) => s.setDreamAuto);
  const wikiEntries = useMemoryV2Store((s) => s.wikiEntries);
  const selectedModelId = useModelStore((s) => s.selectedModelId);
  const models = useModelStore((s) => s.models);
  const hasModel = Boolean(models.size > 0 && selectedModelId && useModelStore.getState().getSelectedModel());

  const analyzed = lastDream?.sessions.filter((session) => session.status === 'analyzed').length ?? 0;
  const failed = lastDream?.sessions.filter((session) => session.status === 'failed') ?? [];
  const otherWarnings = lastDream?.warnings.filter((warning) => !warning.startsWith('analyzer:')) ?? [];
  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5 mb-1">
            <FiMoon size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">
              {t('memoryDreamTitle')}
            </h4>
          </div>
          <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">{t('memoryDreamHint')}</p>
        </div>
        <button
          onClick={() => void runDream()}
          disabled={!active || !hasModel || dreaming}
          className="shrink-0 inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer"
        >
          {dreaming ? <FiLoader size={10} className="animate-spin" /> : <FiRefreshCw size={10} />}
          {dreaming ? t('memoryDreamRunning') : t('memoryDreamRun')}
        </button>
      </div>
      <label className="mt-2 flex items-center gap-1.5 text-[10px] text-[var(--text-muted)] cursor-pointer">
        <input
          type="checkbox"
          checked={dreamAuto}
          onChange={(event) => setDreamAuto(event.target.checked)}
          className="accent-[var(--accent)]"
        />
        {t('memoryDreamAuto')}
      </label>
      {onOpenWiki && wikiEntries.length > 0 && (
        <button
          onClick={onOpenWiki}
          className="mt-1 inline-flex items-center gap-1 text-[10px] text-[var(--accent)] hover:underline cursor-pointer"
        >
          <FiBookOpen size={10} /> {t('memoryWikiOpen')} ({wikiEntries.length})
        </button>
      )}
      {!hasModel && (
        <p className="mt-1 text-[10px] text-[var(--text-muted)]">{t('memoryDreamNeedModel')}</p>
      )}
      {dreamError && (
        <p className="mt-1 text-[10px] text-[var(--error)] [overflow-wrap:anywhere]">
          {t('memoryDreamError')}: {dreamError}
        </p>
      )}
      {lastDream ? (
        <div className="mt-2 space-y-0.5 text-[10px] leading-relaxed text-[var(--text-muted)]">
          <p>
            {t('memoryDreamLast')}: {new Date(lastDream.startedAt).toLocaleString()} · {analyzed}{' '}
            {t('memoryDreamSessions')} · {lastDream.changedFiles.length} {t('memoryDreamFiles')} ·{' '}
            {lastDream.indexEntries} {t('memoryDreamTopics')} · {lastDream.merged.length} {t('memoryDreamMerged')}
            {lastDream.prunedHistory > 0 ? ` · ${lastDream.prunedHistory} ${t('memoryDreamPruned')}` : ''}
          </p>
          {lastDream.sessions.length === 0 && <p>{t('memoryDreamNoSessions')}</p>}
          {lastDream.sessions.length > 0 && analyzed === 0 && failed.length === 0 && (
            <p>{t('memoryDreamNoFindings')}</p>
          )}
          {failed.length > 0 && (
            <p className={`[overflow-wrap:anywhere] ${failed.length === lastDream.sessions.length ? 'text-[var(--error)]' : 'text-[var(--warning)]'}`}>
              {t('memoryDreamFailedSessions')}: {failed.length}/{lastDream.sessions.length}
              {failed[0].error ? ` · ${failed[0].error}` : ''}
            </p>
          )}
          {otherWarnings.length > 0 && (
            <p className="text-[var(--warning)] [overflow-wrap:anywhere]">
              {t('memoryDreamWarnings')}: {otherWarnings.slice(0, 2).join('; ')}
            </p>
          )}
          <p>{t('memoryDreamReadonly')}</p>
        </div>
      ) : (
        <p className="mt-2 text-[10px] text-[var(--text-muted)]">{t('memoryDreamEmpty')}</p>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Overview
// ---------------------------------------------------------------------------

function OverviewTab({ t, records, activeRecords, stats, settings, syncStatus, cloudHealth, cloudConfig, lastSync, migration, onOpen, onTab }: {
  t: T;
  records: MemoryRecord[];
  activeRecords: MemoryRecord[];
  stats: ReturnType<typeof useMemoryV2Store.getState>['stats'];
  settings: ReturnType<typeof useMemoryV2Store.getState>['settings'];
  syncStatus: ReturnType<typeof useMemoryV2Store.getState>['syncStatus'];
  cloudHealth: ReturnType<typeof useMemoryV2Store.getState>['cloudHealth'];
  cloudConfig: CloudConfig | null;
  lastSync: ReturnType<typeof useMemoryV2Store.getState>['lastSync'];
  migration: ReturnType<typeof useMemoryV2Store.getState>['migration'];
  onOpen: (id: string) => void;
  onTab: (tab: Tab) => void;
}) {
  const updateSettings = useMemoryV2Store((s) => s.updateSettings);
  const runMigration = useMemoryV2Store((s) => s.runMigration);
  const backup = useMemoryV2Store((s) => s.backup);
  const restore = useMemoryV2Store((s) => s.restore);
  const exportMarkdown = useMemoryV2Store((s) => s.exportMarkdown);
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState('');
  const [migrating, setMigrating] = useState(false);

  const counts = useMemo(() => {
    const byLayer = Object.fromEntries(LAYERS.map((layer) => [layer, 0])) as Record<MemoryLayer, number>;
    for (const r of activeRecords) byLayer[r.layer] = (byLayer[r.layer] ?? 0) + 1;
    return byLayer;
  }, [activeRecords]);
  const recent = useMemo(() => [...activeRecords].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, 6), [activeRecords]);
  const cloudOk = !!cloudHealth?.ok && !!cloudHealth.configured;

  const doBackup = async () => {
    setWorking('backup');
    try {
      const path = await backup();
      setNotice(path ? `${t('memoryCloudBackupDone')}: ${path}` : t('memoryCloudBackupFailed'));
    } finally { setWorking(''); }
  };
  const doRestore = async () => {
    setWorking('restore');
    try {
      const ok = await restore();
      setNotice(ok ? t('memoryCloudRestoreDone') : t('memoryCloudRestoreFailed'));
    } finally { setWorking(''); }
  };
  const doExport = async () => {
    setWorking('export');
    try {
      const md = await exportMarkdown();
      setNotice(md ? `${t('memoryCloudExportDone')} (${fmtBytes(new Blob([md]).size)})` : t('memoryCloudExportFailed'));
    } finally { setWorking(''); }
  };
  const doMigrate = async () => {
    setMigrating(true);
    try {
      const result = await runMigration(false);
      setNotice(result.ok
        ? `${t('memoryMigrationDone')}: ${result.report?.imported ?? 0} ${t('memoryRecords')}`
        : `${t('memoryMigrationFailed')}: ${result.reason ?? ''}`);
    } finally { setMigrating(false); }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat label={t('memoryOverviewActive')} value={activeRecords.length} hint={t('memoryOverviewTotalHint')} />
        <Stat label={t('memoryOverviewTotal')} value={records.length} hint={`${records.filter((r) => r.deletedAt !== null).length} ${t('memoryDeleted')}`} />
        <Stat label={t('memoryOverviewTriage')} value={stats?.needsTriage ?? 0} tone={stats?.needsTriage ? 'text-[var(--warning)]' : undefined} />
        <Stat label={t('memoryOverviewConflicts')} value={syncStatus?.conflicts ?? 0} tone={syncStatus?.conflicts ? 'text-[var(--error)]' : undefined} />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <FiDatabase size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{t('memoryOverviewLayers')}</h4>
          </div>
          <div className="space-y-1.5">
            {LAYERS.map((layer) => {
              const value = counts[layer] ?? 0;
              const max = Math.max(1, ...Object.values(counts));
              return (
                <button
                  key={layer}
                  onClick={() => onTab('explorer')}
                  className="w-full flex items-center gap-2 text-left cursor-pointer group"
                >
                  <span className="w-16 shrink-0 text-[10px] text-[var(--text-muted)] group-hover:text-[var(--text-secondary)]">{t(`memoryLayer_${layer}`)}</span>
                  <span className="flex-1 h-1.5 rounded-full bg-[var(--bg-2)] overflow-hidden">
                    <span
                      className="block h-full rounded-full bg-[var(--accent)] transition-all"
                      style={{ width: `${Math.round((value / max) * 100)}%`, opacity: value ? 0.75 : 0 }}
                    />
                  </span>
                  <span className="w-6 text-right text-[10px] font-mono text-[var(--text-secondary)]">{value}</span>
                </button>
              );
            })}
          </div>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <FiHardDrive size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{t('memoryOverviewStorage')}</h4>
          </div>
          <div className="space-y-2 text-[11px]">
            <div className="flex items-center gap-2">
              <HealthDot ok={!!stats?.localHealthy} configured />
              <span className="text-[var(--text-secondary)]">{t('memoryOverviewLocal')}</span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)]">{stats?.localHealthy ? t('memoryOverviewHealthy') : t('memoryOverviewUnavailable')}</span>
            </div>
            <div className="flex items-center gap-2">
              <HealthDot ok={cloudOk} configured={!!cloudConfig?.enabled} />
              <span className="text-[var(--text-secondary)]">{t('memoryOverviewCloud')}</span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)] truncate max-w-[55%] text-right">
                {cloudOk ? (cloudHealth?.message || t('memoryOverviewConnected')) : cloudConfig?.enabled ? (cloudHealth?.message || t('memoryOverviewDisconnected')) : t('memoryOverviewNotConfigured')}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <FiRefreshCw size={11} className="text-[var(--text-muted)]" />
              <span className="text-[var(--text-secondary)]">{t('memoryOverviewLastSync')}</span>
              <span className="ml-auto text-[10px] text-[var(--text-muted)]">{fmtTime(syncStatus?.lastSyncAt ?? lastSync?.at ?? null)}</span>
            </div>
            <div className="flex items-center gap-2">
              <FiUpload size={11} className="text-[var(--text-muted)]" />
              <span className="text-[var(--text-secondary)]">{t('memoryCloudPending')}</span>
              <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)]">{syncStatus?.pending ?? 0}</span>
            </div>
            <button onClick={() => onTab('cloud')} className="mt-1 inline-flex items-center gap-1 text-[11px] font-medium text-[var(--accent)] hover:underline cursor-pointer">
              {t('memoryTabCloud')} <FiArrowRight size={11} />
            </button>
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
        <div className="flex items-center justify-between gap-2 mb-2">
          <div className="flex items-center gap-1.5">
            <FiClock size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{t('memoryOverviewRecent')}</h4>
          </div>
          <button onClick={() => onTab('explorer')} className="text-[10px] text-[var(--accent)] hover:underline cursor-pointer">{t('memoryViewAll')}</button>
        </div>
        {recent.length ? (
          <ul className="space-y-1">
            {recent.map((record) => (
              <li key={record.id}>
                <button onClick={() => onOpen(record.id)} className="w-full flex items-center gap-2 rounded-lg px-2 py-1.5 text-left hover:bg-[var(--bg-2)] transition-colors cursor-pointer">
                  <span className="text-[var(--accent)] shrink-0">{LAYER_ICON[record.layer]}</span>
                  <span className="min-w-0 flex-1 truncate text-[11px] text-[var(--text-primary)]">{record.title}</span>
                  <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{fmtTime(record.updatedAt)}</span>
                </button>
              </li>
            ))}
          </ul>
        ) : <p className="text-[11px] text-[var(--text-muted)]">{t('memoryExplorerEmpty')}</p>}
      </section>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <FiSettings size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{t('memorySettings')}</h4>
          </div>
          <div className="space-y-2 text-[11px]">
            <label className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">{t('memoryAutoExtract')}</span>
              <input
                type="checkbox"
                checked={settings?.autoExtract !== false}
                onChange={(e) => void updateSettings({ autoExtract: e.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">{t('memoryTrackWorking')}</span>
              <input
                type="checkbox"
                checked={settings?.trackWorkingMemory !== false}
                onChange={(e) => void updateSettings({ trackWorkingMemory: e.target.checked })}
                className="accent-[var(--accent)]"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">{t('memoryMaxContext')}</span>
              <input
                type="number"
                min={1000}
                max={20000}
                step={500}
                defaultValue={settings?.maxContextChars ?? 6000}
                onBlur={(e) => {
                  const value = Number(e.target.value);
                  if (Number.isFinite(value) && value >= 1000) void updateSettings({ maxContextChars: Math.min(20000, value) });
                }}
                className="w-20 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-right font-mono text-[11px] outline-none focus:border-[var(--accent)]"
              />
            </label>
            <label className="flex items-center justify-between gap-2">
              <span className="text-[var(--text-secondary)]">{t('memoryWorkingTTL')}</span>
              <input
                type="number"
                min={1}
                max={720}
                defaultValue={Math.round((settings?.workingMemoryTTL ?? 86_400_000) / 3_600_000)}
                onBlur={(e) => {
                  const hours = Number(e.target.value);
                  if (Number.isFinite(hours) && hours >= 1) void updateSettings({ workingMemoryTTL: Math.round(hours * 3_600_000) });
                }}
                className="w-20 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-right font-mono text-[11px] outline-none focus:border-[var(--accent)]"
              />
            </label>
          </div>
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-1.5 mb-2">
            <FiArchive size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold text-[var(--text-secondary)] uppercase tracking-wider">{t('memoryOverviewMigration')}</h4>
          </div>
          {migration ? (
            <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
              {t('memoryMigrationImported')}: <span className="font-mono text-[var(--text-secondary)]">{migration.imported}</span>
              {' · '}{t('memoryMigrationDuplicates')}: <span className="font-mono">{migration.skippedDuplicates}</span>
              {' · '}{t('memoryMigrationOtherProject')}: <span className="font-mono">{migration.skippedOtherProject}</span>
              {' · '}{t('memoryMigrationTriage')}: <span className="font-mono">{migration.needsTriage}</span>
              <br />{migration.verified ? t('memoryMigrationVerified') : t('memoryMigrationUnverified')} · {fmtTime(migration.at)}
            </p>
          ) : (
            <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">{t('memoryMigrationNotRun')}</p>
          )}
          <div className="mt-2 flex flex-wrap gap-1.5">
            <button onClick={() => void doMigrate()} disabled={migrating} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer">
              {migrating ? <FiLoader size={10} className="animate-spin" /> : <FiRefreshCw size={10} />} {t('memoryMigrationRun')}
            </button>
            <button onClick={() => void doBackup()} disabled={working === 'backup'} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer">
              {working === 'backup' ? <FiLoader size={10} className="animate-spin" /> : <FiDownload size={10} />} {t('memoryCloudBackupLocal')}
            </button>
            <button onClick={() => void doRestore()} disabled={working === 'restore'} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer">
              {working === 'restore' ? <FiLoader size={10} className="animate-spin" /> : <FiUpload size={10} />} {t('memoryCloudRestoreLocal')}
            </button>
            <button onClick={() => void doExport()} disabled={working === 'export'} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer">
              {working === 'export' ? <FiLoader size={10} className="animate-spin" /> : <FiFileText size={10} />} {t('memoryCloudExport')}
            </button>
          </div>
        </section>
      </div>

      {notice && (
        <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] px-3 py-2 text-[10px] text-[var(--text-secondary)] [overflow-wrap:anywhere]">
          {notice}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Explorer
// ---------------------------------------------------------------------------

function ExplorerTab({ t, records, projectId, selected, busy, onSelect }: {
  t: T;
  records: MemoryRecord[];
  projectId: string | null;
  selected: MemoryRecord | null;
  busy: boolean;
  onSelect: (id: string | null) => void;
}) {
  const [scope, setScope] = useState<'all' | 'global' | 'project'>('all');
  const [layer, setLayer] = useState<'all' | MemoryLayer>('all');
  const [status, setStatus] = useState<'active' | 'all' | MemoryStatus>('active');
  const [range, setRange] = useState<'all' | '7' | '30' | '90'>('all');
  const [tag, setTag] = useState('');
  const [triageOnly, setTriageOnly] = useState(false);
  const [creating, setCreating] = useState(false);

  const tags = useMemo(() => {
    const set = new Set<string>();
    for (const r of records) for (const value of r.tags) set.add(value);
    return [...set].sort().slice(0, 40);
  }, [records]);

  const filtered = useMemo(() => {
    const cutoff = range === 'all' ? 0 : Date.now() - Number(range) * 86_400_000;
    return records
      .filter((r) => {
        if (scope === 'global' && r.layer !== 'global') return false;
        if (scope === 'project' && r.layer === 'global') return false;
        if (status === 'active' && (r.deletedAt !== null || r.status === 'archived' || r.status === 'superseded')) return false;
        if (status !== 'active' && status !== 'all' && r.status !== status) return false;
        if (layer !== 'all' && r.layer !== layer) return false;
        if (tag && !r.tags.includes(tag)) return false;
        if (triageOnly && !r.needsTriage) return false;
        if (cutoff && r.updatedAt < cutoff) return false;
        return true;
      })
      .sort((a, b) => b.importance - a.importance || b.updatedAt - a.updatedAt);
  }, [records, scope, layer, status, range, tag, triageOnly]);

  const selectedVisible = selected && filtered.some((r) => r.id === selected.id) ? selected : null;

  return (
    <div className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-1.5">
        <select value={scope} onChange={(e) => setScope(e.target.value as any)} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]">
          <option value="all">{t('memoryFilterAllScopes')}</option>
          <option value="global">{t('memoryFilterGlobalOnly')}</option>
          <option value="project">{t('memoryFilterCurrentProject')}</option>
        </select>
        <select value={layer} onChange={(e) => setLayer(e.target.value as any)} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]">
          <option value="all">{t('memoryFilterAllLayers')}</option>
          {LAYERS.map((value) => <option key={value} value={value}>{t(`memoryLayer_${value}`)}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as any)} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]">
          <option value="active">{t('memoryFilterActive')}</option>
          <option value="all">{t('memoryFilterAllStatuses')}</option>
          {STATUSES.map((value) => <option key={value} value={value}>{t(`memoryStatus_${value}`)}</option>)}
        </select>
        <select value={range} onChange={(e) => setRange(e.target.value as any)} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]">
          <option value="all">{t('memoryFilterAllTime')}</option>
          <option value="7">{t('memoryFilter7d')}</option>
          <option value="30">{t('memoryFilter30d')}</option>
          <option value="90">{t('memoryFilter90d')}</option>
        </select>
        <select value={tag} onChange={(e) => setTag(e.target.value)} className="max-w-[120px] rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]">
          <option value="">{t('memoryFilterAllTags')}</option>
          {tags.map((value) => <option key={value} value={value}>{value}</option>)}
        </select>
        <label className="inline-flex items-center gap-1 text-[10px] text-[var(--text-secondary)] cursor-pointer">
          <input type="checkbox" checked={triageOnly} onChange={(e) => setTriageOnly(e.target.checked)} className="accent-[var(--accent)]" />
          {t('memoryFilterTriage')}
        </label>
        <span className="ml-auto text-[10px] text-[var(--text-muted)] font-mono">{filtered.length}</span>
        <button onClick={() => setCreating((v) => !v)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2 py-1 text-[10px] font-medium text-white hover:opacity-90 cursor-pointer">
          {creating ? <FiX size={10} /> : <FiPlus size={10} />} {creating ? t('memoryNewCancel') : t('memoryExplorerNew')}
        </button>
      </div>

      {creating && <NewMemoryForm t={t} projectId={projectId} onDone={() => setCreating(false)} />}

      <div className={`grid grid-cols-1 ${selectedVisible ? 'lg:grid-cols-[minmax(0,0.9fr)_minmax(0,1.1fr)]' : ''} gap-2.5`}>
        <div className="space-y-1.5 max-h-[520px] overflow-y-auto pr-1">
          {filtered.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-1)_50%,transparent)] px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">
              {t('memoryExplorerEmpty')}
            </div>
          ) : filtered.map((record) => (
            <button
              key={record.id}
              onClick={() => onSelect(record.id)}
              className={`w-full text-left rounded-xl border px-2.5 py-2 transition-all cursor-pointer ${
                selectedVisible?.id === record.id
                  ? 'border-[color-mix(in_srgb,var(--accent)_50%,transparent)] bg-[var(--accent-soft)]'
                  : 'border-[var(--border)] bg-[var(--bg-1)] hover:border-[color-mix(in_srgb,var(--accent)_35%,transparent)]'
              }`}
            >
              <div className="flex items-start gap-2">
                <span className="mt-0.5 text-[var(--accent)] shrink-0">{LAYER_ICON[record.layer]}</span>
                <span className="min-w-0 flex-1">
                  <span className="block text-[11px] font-medium text-[var(--text-primary)] leading-snug line-clamp-2 [overflow-wrap:anywhere]">{record.title}</span>
                  <span className="mt-1 flex flex-wrap items-center gap-1">
                    <Chip>{t(`memoryLayer_${record.layer}`)}</Chip>
                    <Chip>{t(`memoryType_${record.type}`)}</Chip>
                    <Chip className={STATUS_TONE[record.status]}>{t(`memoryStatus_${record.status}`)}</Chip>
                    {record.needsTriage && <Chip className="text-[var(--warning)] border-[color-mix(in_srgb,var(--warning)_35%,transparent)]">{t('memoryFilterTriage')}</Chip>}
                  </span>
                </span>
                <span className="shrink-0 text-right">
                  <span className="block text-[9px] font-mono text-[var(--text-muted)]">{pct(record.importance)}</span>
                  <span className="block text-[9px] text-[var(--text-muted)]">{fmtTime(record.updatedAt)}</span>
                </span>
              </div>
            </button>
          ))}
        </div>
        {selectedVisible && <MemoryDetail t={t} record={selectedVisible} records={records} busy={busy} onSelect={onSelect} />}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// New memory form
// ---------------------------------------------------------------------------

function NewMemoryForm({ t, projectId, onDone }: { t: T; projectId: string | null; onDone: () => void }) {
  const saveMemory = useMemoryV2Store((s) => s.saveMemory);
  const [content, setContent] = useState('');
  const [type, setType] = useState<MemoryType>('project_fact');
  const [layer, setLayer] = useState<MemoryLayer>(projectId ? 'project' : 'global');
  const [status, setStatus] = useState<MemoryStatus>('confirmed');
  const [importance, setImportance] = useState(0.6);
  const [tags, setTags] = useState('');
  const [why, setWhy] = useState('');
  const [error, setError] = useState('');

  const submit = async () => {
    if (!content.trim()) return;
    setError('');
    const input: NewMemoryInput = {
      content: content.trim(),
      type,
      layer: layer === 'global' ? 'global' : layer,
      projectId: layer === 'global' ? null : projectId,
      status,
      origin: 'manual',
      importance,
      tags: tags.split(',').map((v) => v.trim()).filter(Boolean),
      why: why.trim() || undefined,
    };
    const saved = await saveMemory(input);
    if (!saved) { setError(t('memoryNewFailed')); return; }
    onDone();
  };

  return (
    <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-2.5 space-y-2">
      <textarea
        value={content}
        onChange={(e) => setContent(e.target.value)}
        rows={3}
        placeholder={t('memoryNewContent')}
        className="w-full resize-y rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-2 text-[11px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]"
      />
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-1.5">
        <select value={type} onChange={(e) => setType(e.target.value as MemoryType)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
          {TYPES.map((value) => <option key={value} value={value}>{t(`memoryType_${value}`)}</option>)}
        </select>
        <select value={layer} onChange={(e) => setLayer(e.target.value as MemoryLayer)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
          {LAYERS.map((value) => <option key={value} value={value}>{t(`memoryLayer_${value}`)}</option>)}
        </select>
        <select value={status} onChange={(e) => setStatus(e.target.value as MemoryStatus)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
          {(['confirmed', 'inferred', 'pending'] as MemoryStatus[]).map((value) => <option key={value} value={value}>{t(`memoryStatus_${value}`)}</option>)}
        </select>
        <label className="flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
          {t('memoryDetailImportance')}
          <input type="number" min={0} max={1} step={0.05} value={importance} onChange={(e) => setImportance(Number(e.target.value))} className="w-12 bg-transparent text-right font-mono text-[10px] text-[var(--text-secondary)] outline-none" />
        </label>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
        <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('memoryDetailTags')} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
        <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder={t('memoryDetailReason')} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
      </div>
      {layer !== 'global' && !projectId && (
        <p className="text-[10px] text-[var(--warning)]">{t('memoryNewNeedsProject')}</p>
      )}
      {error && <p className="text-[10px] text-[var(--error)]">{error}</p>}
      <div className="flex items-center gap-1.5">
        <button onClick={() => void submit()} disabled={!content.trim() || (layer !== 'global' && !projectId)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[10px] font-medium text-white disabled:opacity-40 cursor-pointer">
          <FiCheck size={10} /> {t('memoryNewSave')}
        </button>
        <button onClick={onDone} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] cursor-pointer">{t('memoryNewCancel')}</button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Detail
// ---------------------------------------------------------------------------

function MemoryDetail({ t, record, records, busy, onSelect }: {
  t: T;
  record: MemoryRecord;
  records: MemoryRecord[];
  busy: boolean;
  onSelect: (id: string | null) => void;
}) {
  const updateMemory = useMemoryV2Store((s) => s.updateMemory);
  const deleteMemory = useMemoryV2Store((s) => s.deleteMemory);
  const archiveMemory = useMemoryV2Store((s) => s.archiveMemory);
  const undo = useMemoryV2Store((s) => s.undo);
  const restoreVersion = useMemoryV2Store((s) => s.restoreVersion);
  const promoteWorkingMemory = useMemoryV2Store((s) => s.promoteWorkingMemory);
  const relate = useMemoryV2Store((s) => s.relate);
  const unrelate = useMemoryV2Store((s) => s.unrelate);
  const merge = useMemoryV2Store((s) => s.merge);
  const history = useMemoryV2Store((s) => s.history);
  const [editing, setEditing] = useState(false);
  const [title, setTitle] = useState(record.title);
  const [content, setContent] = useState(record.content);
  const [why, setWhy] = useState(record.why ?? '');
  const [tags, setTags] = useState(record.tags.join(', '));
  const [importance, setImportance] = useState(record.importance);
  const [confidence, setConfidence] = useState(record.confidence);
  const [status, setStatus] = useState<MemoryStatus>(record.status);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [force, setForce] = useState(false);
  const [forceEdit, setForceEdit] = useState(false);
  const [relationTarget, setRelationTarget] = useState('');
  const [relationKind, setRelationKind] = useState<RelationKind>('related');
  const [mergeTarget, setMergeTarget] = useState('');

  useEffect(() => {
    setEditing(false);
    setConfirmDelete(false);
    setForce(false);
    setForceEdit(false);
    setTitle(record.title);
    setContent(record.content);
    setWhy(record.why ?? '');
    setTags(record.tags.join(', '));
    setImportance(record.importance);
    setConfidence(record.confidence);
    setStatus(record.status);
    setRelationTarget('');
    setMergeTarget('');
  }, [record.id, record.version]);

  const versions = useMemo(() => {
    try { return history(record.id); } catch { return []; }
  }, [history, record.id, record.version]);

  const others = useMemo(
    () => records.filter((r) => r.id !== record.id && r.deletedAt === null && r.status !== 'archived' && (r.layer === 'global' || r.projectId === record.projectId)),
    [records, record.id, record.projectId],
  );

  const save = async () => {
    if (record.importance >= 0.85 && !forceEdit) return;
    await updateMemory(record.id, {
      title,
      content,
      why,
      tags: tags.split(',').map((v) => v.trim()).filter(Boolean),
      importance,
      confidence,
      status,
      needsTriage: false,
      force: forceEdit,
    }, 'edited in Memory Explorer');
    setEditing(false);
  };

  const doDelete = async () => {
    await deleteMemory(record.id, force);
    setConfirmDelete(false);
    onSelect(null);
  };

  const relatedIds = useMemo(() => new Set([
    ...record.relatedMemoryIds,
    ...record.relations.map((r) => r.targetId),
  ]), [record]);

  return (
    <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3 min-w-0 max-h-[520px] overflow-y-auto">
      <div className="flex items-start gap-2 mb-2">
        <span className="mt-0.5 text-[var(--accent)]">{LAYER_ICON[record.layer]}</span>
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-1">
            <Chip>{t(`memoryLayer_${record.layer}`)}</Chip>
            <Chip>{t(`memoryType_${record.type}`)}</Chip>
            <Chip className={STATUS_TONE[record.status]}>{t(`memoryStatus_${record.status}`)}</Chip>
            <Chip>v{record.version}</Chip>
            <Chip>{record.syncStatus}</Chip>
          </div>
          {editing ? (
            <input value={title} onChange={(e) => setTitle(e.target.value)} className="mt-1.5 w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[12px] font-semibold text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          ) : (
            <h4 className="mt-1.5 text-[12px] font-semibold text-[var(--text-primary)] leading-snug [overflow-wrap:anywhere]">{record.title}</h4>
          )}
        </div>
        <button onClick={() => onSelect(null)} className="shrink-0 rounded-lg p-1 text-[var(--text-muted)] hover:text-[var(--text-primary)] cursor-pointer" title={t('memoryDetailClose')}>
          <FiX size={13} />
        </button>
      </div>

      {editing ? (
        <div className="space-y-1.5">
          <textarea value={content} onChange={(e) => setContent(e.target.value)} rows={6} className="w-full resize-y rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1.5 text-[11px] leading-relaxed text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          <input value={why} onChange={(e) => setWhy(e.target.value)} placeholder={t('memoryDetailReason')} className="w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          <div className="grid grid-cols-2 gap-1.5">
            <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t('memoryDetailTags')} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none" />
            <select value={status} onChange={(e) => setStatus(e.target.value as MemoryStatus)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
              {STATUSES.map((value) => <option key={value} value={value}>{t(`memoryStatus_${value}`)}</option>)}
            </select>
          </div>
          <div className="grid grid-cols-2 gap-1.5">
            <label className="flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
              {t('memoryDetailImportance')}
              <input type="number" min={0} max={1} step={0.05} value={importance} onChange={(e) => setImportance(Number(e.target.value))} className="w-12 bg-transparent text-right font-mono text-[10px] text-[var(--text-secondary)] outline-none" />
            </label>
            <label className="flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)]">
              {t('memoryDetailConfidence')}
              <input type="number" min={0} max={1} step={0.05} value={confidence} onChange={(e) => setConfidence(Number(e.target.value))} className="w-12 bg-transparent text-right font-mono text-[10px] text-[var(--text-secondary)] outline-none" />
            </label>
          </div>
          {record.importance >= 0.85 && (
            <label className="flex items-start gap-1.5 rounded-lg bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--warning)]">
              <input type="checkbox" checked={forceEdit} onChange={(e) => setForceEdit(e.target.checked)} className="mt-0.5 accent-[var(--warning)]" />
              {t('memoryDetailProtected')}
            </label>
          )}
          <div className="flex gap-1.5">
            <button onClick={() => void save()} disabled={busy || !content.trim() || (record.importance >= 0.85 && !forceEdit)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[10px] font-medium text-white disabled:opacity-40 cursor-pointer"><FiCheck size={10} /> {t('memoryDetailSave')}</button>
            <button onClick={() => setEditing(false)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] cursor-pointer">{t('memoryDetailCancel')}</button>
          </div>
        </div>
      ) : (
        <div className="space-y-2">
          <p className="whitespace-pre-wrap text-[11px] leading-relaxed text-[var(--text-primary)] [overflow-wrap:anywhere]">{record.content}</p>
          {record.why && <p className="rounded-lg bg-[var(--bg-2)] px-2 py-1.5 text-[10px] leading-relaxed text-[var(--text-muted)]"><span className="font-medium text-[var(--text-secondary)]">{t('memoryDetailReason')}: </span>{record.why}</p>}
          <div className="grid grid-cols-2 gap-x-3 gap-y-1 text-[10px]">
            <Meta label={t('memoryDetailProject')} value={record.projectId ?? t('memoryLayer_global')} />
            <Meta label={t('memoryDetailCreated')} value={fmtTime(record.createdAt)} />
            <Meta label={t('memoryDetailUpdated')} value={fmtTime(record.updatedAt)} />
            <Meta label={t('memoryDetailImportance')} value={pct(record.importance)} />
            <Meta label={t('memoryDetailConfidence')} value={pct(record.confidence)} />
            <Meta label={t('memoryDetailSession')} value={record.sourceSessionId ? record.sourceSessionId.slice(0, 18) : '—'} />
          </div>
          {record.sourceSessionId && (
            <button
              onClick={() => { void useChatStore.getState().setActiveConversation(record.sourceSessionId!); }}
              className="inline-flex items-center gap-1 text-[10px] font-medium text-[var(--accent)] hover:underline cursor-pointer"
            >
              {t('memoryDetailOpenSource')} <FiArrowRight size={10} />
            </button>
          )}
          {record.tags.length > 0 && (
            <div className="flex flex-wrap items-center gap-1">
              <FiTag size={10} className="text-[var(--text-muted)]" />
              {record.tags.map((value) => <Chip key={value}>{value}</Chip>)}
            </div>
          )}
          {relatedIds.size > 0 && (
            <div>
              <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t('memoryDetailRelations')}</div>
              <div className="space-y-1">
                {[...relatedIds].map((id) => {
                  const target = records.find((r) => r.id === id);
                  return (
                    <div key={id} className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-2)] px-2 py-1 text-[10px]">
                      <FiLink size={9} className="text-[var(--accent)] shrink-0" />
                      <button onClick={() => onSelect(id)} className="min-w-0 flex-1 truncate text-left text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">
                        {target?.title ?? id}
                      </button>
                      <button onClick={() => void unrelate(record.id, id)} className="shrink-0 text-[var(--text-muted)] hover:text-[var(--error)] cursor-pointer" title={t('memoryDetailUnrelate')}><FiX size={10} /></button>
                    </div>
                  );
                })}
              </div>
            </div>
          )}

          <div className="flex flex-wrap items-center gap-1.5 border-t border-[var(--border)] pt-2">
            <button onClick={() => setEditing(true)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"><FiEdit3 size={10} /> {t('memoryDetailEdit')}</button>
            {record.layer === 'working' && (
              <button onClick={() => void promoteWorkingMemory(record.id)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent-soft)] border border-[color-mix(in_srgb,var(--accent)_35%,transparent)] px-2 py-1 text-[10px] text-[var(--accent)] hover:opacity-90 cursor-pointer"><FiArrowRight size={10} /> {t('memoryDetailPromote')}</button>
            )}
            <button onClick={() => void undo(record.id, record.importance >= 0.85)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"><FiClock size={10} /> {t('memoryDetailUndo')}</button>
            <button onClick={() => { if (record.importance >= 0.85 && !window.confirm(t('memoryDetailProtected'))) return; void archiveMemory(record.id, record.importance >= 0.85); }} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer"><FiArchive size={10} /> {t('memoryDetailArchive')}</button>
            {confirmDelete ? (
              <span className="inline-flex flex-wrap items-center gap-1">
                <span className="text-[10px] text-[var(--text-muted)]">{t('memoryDetailDeleteConfirm')}</span>
                {record.importance >= 0.85 && (
                  <label className="inline-flex items-center gap-1 text-[10px] text-[var(--warning)]">
                    <input type="checkbox" checked={force} onChange={(e) => setForce(e.target.checked)} className="accent-[var(--warning)]" /> {t('memoryDetailForce')}
                  </label>
                )}
                <button onClick={() => void doDelete()} disabled={record.importance >= 0.85 && !force} className="rounded-lg bg-[color-mix(in_srgb,var(--error)_15%,transparent)] px-2 py-1 text-[10px] font-medium text-[var(--error)] disabled:opacity-40 cursor-pointer">{t('memoryDetailDelete')}</button>
                <button onClick={() => setConfirmDelete(false)} className="rounded-lg px-2 py-1 text-[10px] text-[var(--text-muted)] cursor-pointer">{t('memoryDetailCancel')}</button>
              </span>
            ) : (
              <button onClick={() => setConfirmDelete(true)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--error)] cursor-pointer"><FiTrash2 size={10} /> {t('memoryDetailDelete')}</button>
            )}
          </div>

          {record.importance >= 0.85 && <p className="text-[10px] text-[var(--warning)]">{t('memoryDetailProtected')}</p>}

          <div className="border-t border-[var(--border)] pt-2 space-y-1.5">
            <div className="text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t('memoryDetailRelate')}</div>
            <div className="flex flex-wrap gap-1.5">
              <select value={relationTarget} onChange={(e) => setRelationTarget(e.target.value)} className="min-w-0 flex-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
                <option value="">{t('memoryDetailRelateTarget')}</option>
                {others.map((r) => <option key={r.id} value={r.id}>{r.title.slice(0, 60)}</option>)}
              </select>
              <select value={relationKind} onChange={(e) => setRelationKind(e.target.value as RelationKind)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
                {RELATION_KINDS.map((value) => <option key={value} value={value}>{t(`memoryRelation_${value}`)}</option>)}
              </select>
              <button onClick={() => { if (relationTarget) void relate(record.id, relationTarget, relationKind); }} disabled={!relationTarget} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] disabled:opacity-40 cursor-pointer">{t('memoryDetailRelateAdd')}</button>
            </div>
            <div className="flex flex-wrap gap-1.5">
              <select value={mergeTarget} onChange={(e) => setMergeTarget(e.target.value)} className="min-w-0 flex-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
                <option value="">{t('memoryDetailMergeTarget')}</option>
                {others.map((r) => <option key={r.id} value={r.id}>{r.title.slice(0, 60)}</option>)}
              </select>
              <button
                onClick={() => {
                  if (!mergeTarget) return;
                  const target = others.find((r) => r.id === mergeTarget);
                  const protectedMemory = record.importance >= 0.85 || (target?.importance ?? 0) >= 0.85;
                  if (protectedMemory && !window.confirm(t('memoryDetailProtected'))) return;
                  void merge(record.id, mergeTarget, protectedMemory);
                }}
                disabled={!mergeTarget}
                className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] disabled:opacity-40 cursor-pointer"
              >
                {t('memoryDetailMerge')}
              </button>
            </div>
          </div>

          <div className="border-t border-[var(--border)] pt-2">
            <div className="mb-1 flex items-center gap-1 text-[10px] font-semibold uppercase tracking-wider text-[var(--text-muted)]"><FiClock size={10} /> {t('memoryDetailHistory')} ({versions.length})</div>
            {versions.length <= 1 ? <p className="text-[10px] text-[var(--text-muted)]">{t('memoryDetailNoHistory')}</p> : (
              <div className="space-y-1 max-h-40 overflow-y-auto pr-1">
                {[...versions].reverse().map((version, index) => (
                  <div key={`${version.version}-${version.at}-${index}`} className="rounded-lg bg-[var(--bg-2)] px-2 py-1.5 text-[10px]">
                    <div className="flex items-center gap-1.5">
                      <span className="font-mono text-[var(--text-secondary)]">v{version.version}</span>
                      <span className="text-[var(--text-muted)]">{fmtTime(version.at)}</span>
                      <span className="ml-auto text-[9px] text-[var(--text-muted)] truncate max-w-[45%]">{version.reason}</span>
                      {index > 0 && (
                        <button onClick={() => void restoreVersion(record.id, version.version, record.importance >= 0.85)} className="shrink-0 text-[9px] text-[var(--accent)] hover:underline cursor-pointer">{t('memoryDetailRestore')}</button>
                      )}
                    </div>
                    <p className="mt-0.5 line-clamp-2 text-[10px] text-[var(--text-muted)] [overflow-wrap:anywhere]">{version.content}</p>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

function Meta({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <span className="text-[var(--text-muted)]">{label}: </span>
      <span className="font-mono text-[var(--text-secondary)] [overflow-wrap:anywhere]">{value}</span>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

function SearchTab({ t, projectId, cloudConfigured, onOpen }: {
  t: T;
  projectId: string | null;
  cloudConfigured: boolean;
  onOpen: (id: string) => void;
}) {
  const search = useMemoryV2Store((s) => s.search);
  const [text, setText] = useState('');
  const [scope, setScope] = useState<NonNullable<MemoryQuery['scope']>>('all');
  const [layer, setLayer] = useState<'all' | MemoryLayer>('all');
  const [type, setType] = useState<'all' | MemoryType>('all');
  const [importanceMin, setImportanceMin] = useState(0);
  const [results, setResults] = useState<Awaited<ReturnType<typeof search>>>([]);
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const run = async () => {
    if (!text.trim()) return;
    setSearching(true);
    try {
      const hits = await search({
        text: text.trim(),
        scope,
        projectId,
        layers: layer === 'all' ? undefined : [layer],
        types: type === 'all' ? undefined : [type],
        importanceMin: importanceMin > 0 ? importanceMin : undefined,
        includeRelated: true,
        relatedDepth: 1,
        limit: 20,
      });
      setResults(hits);
      setSearched(true);
    } finally { setSearching(false); }
  };

  return (
    <div className="space-y-2.5">
      <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-2.5 space-y-2">
        <div className="flex gap-1.5">
          <div className="relative flex-1 min-w-0">
            <FiSearch size={12} className="absolute left-2.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
            <input
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing) void run(); }}
              placeholder={t('memorySearchPlaceholder')}
              className="search-input w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] pl-8 pr-2.5 py-1.5 text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]"
            />
          </div>
          <button onClick={() => void run()} disabled={!text.trim() || searching} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1.5 text-[10px] font-medium text-white disabled:opacity-40 cursor-pointer">
            {searching ? <FiLoader size={10} className="animate-spin" /> : <FiSearch size={10} />} {t('memorySearchButton')}
          </button>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <select value={scope} onChange={(e) => setScope(e.target.value as any)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
            <option value="all">{t('memorySearchAll')}</option>
            <option value="project">{t('memorySearchCurrent')}</option>
            <option value="global">{t('memorySearchGlobal')}</option>
            <option value="local">{t('memorySearchLocal')}</option>
            <option value="cloud">{t('memorySearchCloud')}</option>
          </select>
          <select value={layer} onChange={(e) => setLayer(e.target.value as any)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
            <option value="all">{t('memoryFilterAllLayers')}</option>
            {LAYERS.map((value) => <option key={value} value={value}>{t(`memoryLayer_${value}`)}</option>)}
          </select>
          <select value={type} onChange={(e) => setType(e.target.value as any)} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
            <option value="all">{t('memoryFilterAllTypes')}</option>
            {TYPES.map((value) => <option key={value} value={value}>{t(`memoryType_${value}`)}</option>)}
          </select>
          <select value={importanceMin} onChange={(e) => setImportanceMin(Number(e.target.value))} className="rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
            <option value={0}>{t('memorySearchAnyImportance')}</option>
            <option value={0.5}>{t('memorySearchImportance50')}</option>
            <option value={0.7}>{t('memorySearchImportance70')}</option>
            <option value={0.9}>{t('memorySearchImportance90')}</option>
          </select>
          {scope === 'cloud' && !cloudConfigured && <span className="self-center text-[10px] text-[var(--warning)]">{t('memorySearchCloudUnavailable')}</span>}
        </div>
      </div>

      {!searched ? (
        <p className="px-1 text-[11px] text-[var(--text-muted)]">{t('memorySearchHint')}</p>
      ) : results.length === 0 ? (
        <div className="rounded-xl border border-dashed border-[var(--border)] px-3 py-6 text-center text-[11px] text-[var(--text-muted)]">{t('memorySearchEmpty')}</div>
      ) : (
        <div className="space-y-1.5 max-h-[440px] overflow-y-auto pr-1">
          {results.map((hit) => (
            <button key={`${hit.source}-${hit.record.id}`} onClick={() => onOpen(hit.record.id)} className="w-full rounded-xl border border-[var(--border)] bg-[var(--bg-1)] px-2.5 py-2 text-left hover:border-[color-mix(in_srgb,var(--accent)_35%,transparent)] cursor-pointer">
              <div className="flex items-center gap-1.5">
                <span className="text-[var(--accent)]">{LAYER_ICON[hit.record.layer]}</span>
                <span className="min-w-0 flex-1 truncate text-[11px] font-medium text-[var(--text-primary)]">{hit.record.title}</span>
                <Chip className={hit.source === 'cloud' ? 'text-[var(--accent)] border-[color-mix(in_srgb,var(--accent)_35%,transparent)]' : ''}>{hit.source}</Chip>
                <span className="text-[9px] font-mono text-[var(--text-muted)]">{hit.score.toFixed(2)}</span>
              </div>
              <p className="mt-0.5 line-clamp-2 text-[10px] leading-relaxed text-[var(--text-muted)] [overflow-wrap:anywhere]">{hit.record.content}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1">
                <Chip>{t(`memoryStatus_${hit.record.status}`)}</Chip>
                <Chip>v{hit.record.version}</Chip>
                {hit.reasons.slice(0, 2).map((reason) => <Chip key={reason}>{reason}</Chip>)}
              </div>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Cloud settings & sync
// ---------------------------------------------------------------------------

function CloudTab({ t, config, security, health, syncStatus, lastSync, conflicts, usage, devices, busy, migration }: {
  t: T;
  config: CloudConfig | null;
  security: ReturnType<typeof useMemoryV2Store.getState>['security'];
  health: ReturnType<typeof useMemoryV2Store.getState>['cloudHealth'];
  syncStatus: ReturnType<typeof useMemoryV2Store.getState>['syncStatus'];
  lastSync: ReturnType<typeof useMemoryV2Store.getState>['lastSync'];
  conflicts: ReturnType<typeof useMemoryV2Store.getState>['conflicts'];
  usage: ReturnType<typeof useMemoryV2Store.getState>['cloudUsage'];
  devices: ReturnType<typeof useMemoryV2Store.getState>['devices'];
  busy: boolean;
  migration: ReturnType<typeof useMemoryV2Store.getState>['migration'];
}) {
  const configureCloud = useMemoryV2Store((s) => s.configureCloud);
  const testConnection = useMemoryV2Store((s) => s.testConnection);
  const syncNow = useMemoryV2Store((s) => s.syncNow);
  const resolveConflict = useMemoryV2Store((s) => s.resolveConflict);
  const refreshCloudUsage = useMemoryV2Store((s) => s.refreshCloudUsage);
  const refreshDevices = useMemoryV2Store((s) => s.refreshDevices);
  const revokeDevice = useMemoryV2Store((s) => s.revokeDevice);
  const driveStatus = useMemoryV2Store((s) => s.driveStatus);
  const refreshDriveStatus = useMemoryV2Store((s) => s.refreshDriveStatus);
  const configureDrive = useMemoryV2Store((s) => s.configureDrive);
  const connectDrive = useMemoryV2Store((s) => s.connectDrive);
  const disconnectDrive = useMemoryV2Store((s) => s.disconnectDrive);
  const cloudBackup = useMemoryV2Store((s) => s.cloudBackup);
  const cloudRestore = useMemoryV2Store((s) => s.cloudRestore);
  const deleteCloudData = useMemoryV2Store((s) => s.deleteCloudData);
  const exportMarkdown = useMemoryV2Store((s) => s.exportMarkdown);

  const [enabled, setEnabled] = useState(!!config?.enabled);
  const [provider, setProvider] = useState<CloudConfig['provider']>(config?.provider ?? 'rest');
  const [googleClientId, setGoogleClientId] = useState(config?.googleClientId ?? '');
  const [googleClientSecret, setGoogleClientSecret] = useState('');
  const [baseUrl, setBaseUrl] = useState(config?.baseUrl ?? '');
  const [token, setToken] = useState('');
  const [clearToken, setClearToken] = useState(false);
  const [tenantId, setTenantId] = useState(config?.tenantId ?? 'default');
  const [autoSync, setAutoSync] = useState(config?.autoSync ?? true);
  const [intervalSec, setIntervalSec] = useState(Math.round((config?.syncIntervalMs ?? 60_000) / 1000));
  const [encryption, setEncryption] = useState<CloudConfig['encryption']>(config?.encryption ?? 'transport');
  const [passphrase, setPassphrase] = useState('');
  const [tlsOnly, setTlsOnly] = useState(config?.tlsOnly ?? true);
  const [notice, setNotice] = useState('');
  const [working, setWorking] = useState('');

  useEffect(() => {
    setEnabled(!!config?.enabled);
    setProvider(config?.provider ?? 'rest');
    setGoogleClientId(config?.googleClientId ?? '');
    setGoogleClientSecret('');
    setBaseUrl(config?.baseUrl ?? '');
    setTenantId(config?.tenantId ?? 'default');
    setAutoSync(config?.autoSync ?? true);
    setIntervalSec(Math.round((config?.syncIntervalMs ?? 60_000) / 1000));
    setEncryption(config?.encryption ?? 'transport');
    setTlsOnly(config?.tlsOnly ?? true);
    setToken('');
    setClearToken(false);
    setPassphrase('');
  }, [config?.enabled, config?.provider, config?.googleClientId, config?.baseUrl, config?.tenantId, config?.autoSync, config?.syncIntervalMs, config?.encryption, config?.tlsOnly]);

  useEffect(() => {
    if (config?.enabled) {
      void refreshCloudUsage();
      void refreshDevices();
    }
  }, [config?.enabled, refreshCloudUsage, refreshDevices]);

  useEffect(() => {
    if (provider === 'google-drive') void refreshDriveStatus();
  }, [provider, refreshDriveStatus]);

  const save = async (test: boolean) => {
    setWorking(test ? 'save-test' : 'save');
    setNotice('');
    try {
      if (provider === 'google-drive' && (googleClientId.trim() || googleClientSecret.trim())) {
        await configureDrive({
          ...(googleClientId.trim() ? { clientId: googleClientId.trim() } : {}),
          ...(googleClientSecret.trim() ? { clientSecret: googleClientSecret.trim() } : {}),
        });
        setGoogleClientSecret('');
      }
      const patch: Partial<CloudConfig> = {
        enabled,
        provider,
        googleClientId: googleClientId.trim() || driveStatus?.clientId || '',
        baseUrl: baseUrl.trim(),
        tenantId: tenantId.trim() || 'default',
        autoSync,
        syncIntervalMs: Math.max(15, Math.min(86_400, intervalSec || 60)) * 1000,
        encryption,
        tlsOnly,
        ...(clearToken ? { authToken: '' } : token ? { authToken: token } : {}),
        ...(passphrase ? { e2ePassphrase: passphrase } : {}),
      };
      const health = await configureCloud(patch);
      setNotice(health.ok
        ? `${t('memoryCloudConnected')}: ${health.message}`
        : `${t('memoryCloudDisconnected')}: ${health.message}`);
      setToken('');
      setPassphrase('');
      setClearToken(false);
      if (test && !health.ok) setNotice(`${t('memoryCloudTestFailed')}: ${health.message}`);
    } finally { setWorking(''); }
  };

  const doTest = async () => {
    setWorking('test');
    setNotice('');
    try {
      const result = await testConnection();
      setNotice(result.ok ? `${t('memoryCloudConnected')}: ${result.message}` : `${t('memoryCloudTestFailed')}: ${result.message}`);
    } finally { setWorking(''); }
  };

  const doConnectDrive = async () => {
    setWorking('drive-connect');
    setNotice('');
    try {
      const result = await connectDrive({
        ...(googleClientId.trim() ? { clientId: googleClientId.trim() } : {}),
        ...(googleClientSecret.trim() ? { clientSecret: googleClientSecret.trim() } : {}),
      });
      if (result.ok) {
        setGoogleClientSecret('');
        setEnabled(true);
        setNotice(`${t('memoryDriveConnected')}${result.status?.email ? `: ${result.status.email}` : ''}`);
      } else {
        setNotice(`${t('memoryDriveConnectFailed')}: ${result.error ?? ''}`);
      }
    } finally { setWorking(''); }
  };

  const doDisconnectDrive = async () => {
    if (!window.confirm(t('memoryDriveDisconnectConfirm'))) return;
    setWorking('drive-disconnect');
    setNotice('');
    try {
      const ok = await disconnectDrive();
      setEnabled(false);
      setNotice(ok ? t('memoryDriveDisconnected') : t('memoryDriveDisconnectFailed'));
    } finally { setWorking(''); }
  };

  const doSync = async () => {
    setWorking('sync');
    try {
      const report = await syncNow();
      if (!report) { setNotice(t('memoryCloudSyncFailed')); return; }
      setNotice(report.ok
        ? `${t('memoryCloudSyncDone')}: ↑${report.pushed} ↓${report.pulled} · ${report.durationMs}ms`
        : `${t('memoryCloudSyncFailed')}: ${report.error ?? ''}`);
    } finally { setWorking(''); }
  };

  const doCloudBackup = async () => {
    setWorking('cloud-backup');
    try {
      const key = await cloudBackup();
      setNotice(key ? `${t('memoryCloudBackupDone')}: ${key}` : t('memoryCloudBackupFailed'));
    } finally { setWorking(''); }
  };
  const doCloudRestore = async () => {
    setWorking('cloud-restore');
    try {
      const ok = await cloudRestore();
      setNotice(ok ? t('memoryCloudRestoreDone') : t('memoryCloudRestoreFailed'));
    } finally { setWorking(''); }
  };
  const doExport = async () => {
    setWorking('export');
    try {
      const md = await exportMarkdown();
      setNotice(md ? `${t('memoryCloudExportDone')} (${fmtBytes(new Blob([md]).size)})` : t('memoryCloudExportFailed'));
    } finally { setWorking(''); }
  };

  const cloudOk = !!health?.ok && !!health.configured;
  const effectiveSecurity = securitySummary({
    enabled,
    provider,
    baseUrl: baseUrl.trim(),
    authToken: token || config?.authToken || '',
    googleClientId: googleClientId.trim() || driveStatus?.clientId || '',
    tenantId: tenantId.trim() || 'default',
    autoSync,
    syncIntervalMs: Math.max(15, Math.min(86_400, intervalSec || 60)) * 1000,
    encryption,
    e2ePassphrase: passphrase || config?.e2ePassphrase || '',
    tlsOnly,
  });

  return (
    <div className="space-y-2.5">
      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3 space-y-2">
        <div className="flex items-center gap-2">
          <FiServer size={12} className="text-[var(--accent)]" />
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{t('memoryCloudSettings')}</h4>
          <label className="ml-auto inline-flex items-center gap-1 text-[10px] text-[var(--text-secondary)] cursor-pointer">
            <input type="checkbox" checked={enabled} onChange={(e) => setEnabled(e.target.checked)} className="accent-[var(--accent)]" />
            {t('memoryCloudEnabled')}
          </label>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
          <label className="space-y-0.5">
            <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryCloudProvider')}</span>
            <select value={provider} onChange={(e) => setProvider(e.target.value as CloudConfig['provider'])} className="w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
              <option value="rest">{t('memoryCloudProviderRest')}</option>
              <option value="google-drive">{t('memoryCloudProviderDrive')}</option>
              <option value="custom">{t('memoryCloudProviderCustom')}</option>
            </select>
          </label>
          {provider !== 'google-drive' && (
            <label className="space-y-0.5">
              <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryCloudBaseUrl')}</span>
              <input value={baseUrl} onChange={(e) => setBaseUrl(e.target.value)} placeholder="https://memory.example.com" spellCheck={false} className="w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
            </label>
          )}
          <label className="space-y-0.5">
            <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryCloudTenant')}</span>
            <input value={tenantId} onChange={(e) => setTenantId(e.target.value)} className="w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]" />
          </label>
          {provider !== 'google-drive' && (
            <label className="space-y-0.5 sm:col-span-2">
              <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryCloudToken')}</span>
              <div className="flex gap-1.5">
                <input value={token} onChange={(e) => { setToken(e.target.value); setClearToken(false); }} type="password" autoComplete="off" placeholder={config?.authToken ? t('memoryCloudTokenSet') : t('memoryCloudTokenPh')} className="min-w-0 flex-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
                {config?.authToken && (
                  <button onClick={() => { setClearToken(true); setToken(''); }} className="shrink-0 rounded-lg border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-muted)] hover:text-[var(--error)] cursor-pointer">{t('memoryCloudClearToken')}</button>
                )}
              </div>
              {clearToken && <span className="block text-[9px] text-[var(--warning)]">{t('memoryCloudTokenWillClear')}</span>}
            </label>
          )}
          <label className="space-y-0.5">
            <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryCloudEncryption')}</span>
            <select value={encryption} onChange={(e) => setEncryption(e.target.value as CloudConfig['encryption'])} className="w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] outline-none">
              <option value="transport">{t('memoryCloudTransport')}</option>
              <option value="server-at-rest">{t('memoryCloudServerAtRest')}</option>
              <option value="e2e">{t('memoryCloudE2E')}</option>
            </select>
          </label>
          <label className="space-y-0.5">
            <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryCloudPassphrase')}</span>
            <input value={passphrase} onChange={(e) => setPassphrase(e.target.value)} type="password" autoComplete="off" placeholder={config?.e2ePassphrase ? t('memoryCloudPassphraseSet') : t('memoryCloudPassphrasePh')} className="w-full rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
          </label>
          <label className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={autoSync} onChange={(e) => setAutoSync(e.target.checked)} className="accent-[var(--accent)]" />
            {t('memoryCloudAutoSync')}
          </label>
          <label className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)]">
            {t('memoryCloudInterval')}
            <input type="number" min={15} max={86400} value={intervalSec} onChange={(e) => setIntervalSec(Number(e.target.value))} className="w-16 bg-transparent text-right font-mono text-[10px] outline-none" />
            {t('memorySeconds')}
          </label>
          {provider !== 'google-drive' && (
            <label className="flex items-center gap-1.5 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-secondary)] sm:col-span-2">
              <input type="checkbox" checked={tlsOnly} onChange={(e) => setTlsOnly(e.target.checked)} className="accent-[var(--accent)]" />
              {t('memoryCloudTlsOnly')}
            </label>
          )}
        </div>

        {provider === 'google-drive' && (
          <div className="rounded-xl border border-[var(--border)] bg-[var(--bg-2)] p-2.5 space-y-2">
            <div className="flex flex-wrap items-center gap-2">
              <FiCloud size={12} className="text-[var(--accent)]" />
              <span className="text-[11px] font-semibold text-[var(--text-primary)]">{t('memoryDriveTitle')}</span>
              <span className={`ml-auto inline-flex items-center gap-1 text-[10px] ${driveStatus?.connected ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
                <HealthDot ok={!!driveStatus?.connected} configured={!!driveStatus?.configured} />
                {driveStatus?.connected ? t('memoryDriveConnectedState') : t('memoryDriveNotConnected')}
              </span>
            </div>
            {driveStatus?.email && <p className="text-[10px] text-[var(--text-secondary)]">{t('memoryDriveAccount')}: <span className="font-mono">{driveStatus.email}</span></p>}
            {driveStatus?.source === 'env' && <p className="text-[9px] text-[var(--success)]">{t('memoryDriveEnvConfigured')}</p>}
            {!driveStatus?.configured && (
              <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                <label className="space-y-0.5">
                  <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryDriveClientId')}</span>
                  <input value={googleClientId} onChange={(e) => setGoogleClientId(e.target.value)} spellCheck={false} placeholder="1234567890-xxxx.apps.googleusercontent.com" className="w-full rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
                </label>
                <label className="space-y-0.5">
                  <span className="block text-[10px] text-[var(--text-muted)]">{t('memoryDriveClientSecret')}</span>
                  <input value={googleClientSecret} onChange={(e) => setGoogleClientSecret(e.target.value)} type="password" autoComplete="off" placeholder={t('memoryDriveClientSecretPh')} className="w-full rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[10px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)] placeholder-[var(--text-muted)]" />
                </label>
              </div>
            )}
            <p className="text-[9px] leading-relaxed text-[var(--text-muted)]">{t('memoryDriveHint')}</p>
            <div className="flex flex-wrap gap-1.5">
              {!driveStatus?.connected ? (
                <button onClick={() => void doConnectDrive()} disabled={!!working || (!driveStatus?.configured && !googleClientId.trim())} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[10px] font-medium text-white disabled:opacity-40 cursor-pointer">
                  {working === 'drive-connect' ? <FiLoader size={10} className="animate-spin" /> : <FiCloud size={10} />} {t('memoryDriveConnect')}
                </button>
              ) : (
                <button onClick={() => void doDisconnectDrive()} disabled={!!working} className="inline-flex items-center gap-1 rounded-lg border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--error)] disabled:opacity-50 cursor-pointer">
                  {working === 'drive-disconnect' ? <FiLoader size={10} className="animate-spin" /> : <FiCloudOff size={10} />} {t('memoryDriveDisconnect')}
                </button>
              )}
            </div>
            {driveStatus?.error && <p className="text-[10px] text-[var(--error)] [overflow-wrap:anywhere]">{driveStatus.error}</p>}
          </div>
        )}

        {provider !== 'google-drive' && (
          <p className="text-[9px] leading-relaxed text-[var(--text-muted)]">{t('memoryCloudStorageHint')}</p>
        )}
        <div className="flex flex-wrap gap-1.5">
          <button onClick={() => void save(false)} disabled={!!working} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[10px] font-medium text-white disabled:opacity-50 cursor-pointer">
            {working === 'save' ? <FiLoader size={10} className="animate-spin" /> : <FiCheck size={10} />} {t('memoryCloudSave')}
          </button>
          <button onClick={() => void save(true)} disabled={!!working} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer">
            {working === 'save-test' ? <FiLoader size={10} className="animate-spin" /> : <FiZap size={10} />} {t('memoryCloudSaveTest')}
          </button>
          <button onClick={() => void doTest()} disabled={!!working || config?.provider !== provider || (provider !== 'google-drive' && !config?.baseUrl)} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 cursor-pointer">
            {working === 'test' ? <FiLoader size={10} className="animate-spin" /> : <FiCloud size={10} />} {t('memoryCloudTest')}
          </button>
        </div>
        {notice && <p className="rounded-lg bg-[var(--bg-2)] px-2 py-1.5 text-[10px] text-[var(--text-secondary)] [overflow-wrap:anywhere]">{notice}</p>}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
        <div className="flex items-center gap-2 mb-2">
          <HealthDot ok={cloudOk} configured={!!config?.enabled} />
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{t('memoryCloudStatus')}</h4>
          <span className={`ml-auto text-[10px] ${cloudOk ? 'text-[var(--success)]' : 'text-[var(--text-muted)]'}`}>
            {cloudOk ? t('memoryCloudConnected') : config?.enabled ? t('memoryCloudDisconnected') : t('memoryCloudNotConfigured')}
          </span>
        </div>
        <p className="mb-2 text-[10px] text-[var(--text-muted)] [overflow-wrap:anywhere]">{health?.message ?? t('memoryCloudNoConnection')}</p>
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <Stat label={t('memoryCloudLastSync')} value={fmtTime(syncStatus?.lastSyncAt ?? lastSync?.at ?? null)} />
          <Stat label={t('memoryCloudPending')} value={syncStatus?.pending ?? 0} />
          <Stat label={t('memoryCloudOfflineQueue')} value={syncStatus?.offlineQueue ?? 0} />
          <Stat label={t('memoryCloudConflicts')} value={conflicts.length} tone={conflicts.length ? 'text-[var(--error)]' : undefined} />
        </div>
        {syncStatus?.lastError && <p className="mt-2 rounded-lg bg-[color-mix(in_srgb,var(--error)_8%,transparent)] px-2 py-1.5 text-[10px] text-[var(--error)] [overflow-wrap:anywhere]">{t('memoryCloudLastError')}: {syncStatus.lastError}</p>}
        <div className="mt-2 flex flex-wrap gap-1.5">
          <button onClick={() => void doSync()} disabled={!!working || busy || !config?.enabled} className="inline-flex items-center gap-1 rounded-lg bg-[var(--accent)] px-2.5 py-1 text-[10px] font-medium text-white disabled:opacity-50 cursor-pointer">
            {working === 'sync' || busy ? <FiLoader size={10} className="animate-spin" /> : <FiRefreshCw size={10} />} {t('memoryCloudSyncNow')}
          </button>
          <button onClick={() => { void refreshCloudUsage(); void refreshDevices(); }} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] cursor-pointer"><FiRefreshCw size={10} /> {t('memoryCloudRefresh')}</button>
          <button onClick={() => void doCloudBackup()} disabled={!!working || !config?.enabled} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] disabled:opacity-50 cursor-pointer"><FiDownload size={10} /> {t('memoryCloudBackup')}</button>
          <button onClick={() => void doCloudRestore()} disabled={!!working || !config?.enabled} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] disabled:opacity-50 cursor-pointer"><FiUpload size={10} /> {t('memoryCloudRestore')}</button>
          <button onClick={() => void doExport()} disabled={!!working} className="inline-flex items-center gap-1 rounded-lg bg-[var(--bg-2)] border border-[var(--border)] px-2.5 py-1 text-[10px] text-[var(--text-secondary)] disabled:opacity-50 cursor-pointer"><FiFileText size={10} /> {t('memoryCloudExport')}</button>
          <button
            onClick={async () => {
              if (!window.confirm(t('memoryCloudDeleteConfirm'))) return;
              setWorking('delete-cloud');
              try {
                const ok = await deleteCloudData();
                setNotice(ok ? t('memoryCloudDeleteDone') : t('memoryCloudDeleteFailed'));
              } finally { setWorking(''); }
            }}
            disabled={!!working || !config?.enabled}
            className="inline-flex items-center gap-1 rounded-lg border border-[color-mix(in_srgb,var(--error)_35%,transparent)] px-2.5 py-1 text-[10px] text-[var(--error)] disabled:opacity-50 cursor-pointer"
          >
            {working === 'delete-cloud' ? <FiLoader size={10} className="animate-spin" /> : <FiTrash2 size={10} />} {t('memoryCloudDelete')}
          </button>
        </div>
      </section>

      {conflicts.length > 0 && (
        <section className="rounded-xl border border-[color-mix(in_srgb,var(--error)_35%,transparent)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-2 mb-2">
            <FiAlertCircle size={12} className="text-[var(--error)]" />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--error)]">{t('memoryCloudConflictTitle')} ({conflicts.length})</h4>
          </div>
          <div className="space-y-2">
            {conflicts.map((conflict) => (
              <div key={conflict.id} className="rounded-lg border border-[var(--border)] bg-[var(--bg-2)] p-2">
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-1.5">
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t('memoryCloudKeepLocal')} · v{conflict.local.version}</div>
                    <p className="mt-0.5 line-clamp-3 text-[10px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">{conflict.local.content}</p>
                  </div>
                  <div>
                    <div className="text-[9px] font-semibold uppercase tracking-wider text-[var(--text-muted)]">{t('memoryCloudKeepRemote')} · v{conflict.remote.version}</div>
                    <p className="mt-0.5 line-clamp-3 text-[10px] leading-relaxed text-[var(--text-secondary)] [overflow-wrap:anywhere]">{conflict.remote.content}</p>
                  </div>
                </div>
                <div className="mt-1.5 flex flex-wrap gap-1.5">
                  <button onClick={() => void resolveConflict(conflict.id, 'keep_local')} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">{t('memoryCloudKeepLocal')}</button>
                  <button onClick={() => void resolveConflict(conflict.id, 'keep_remote')} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">{t('memoryCloudKeepRemote')}</button>
                  <button onClick={() => void resolveConflict(conflict.id, 'merge')} className="rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1 text-[9px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] cursor-pointer">{t('memoryCloudMerge')}</button>
                </div>
              </div>
            ))}
          </div>
        </section>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-2.5">
        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-2 mb-2">
            <FiDatabase size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{t('memoryCloudUsage')}</h4>
          </div>
          <div className="grid grid-cols-2 gap-2">
            <Stat label={t('memoryCloudRecords')} value={usage?.records ?? 0} />
            <Stat label={t('memoryCloudObjects')} value={usage?.objects ?? 0} />
            <Stat label={t('memoryCloudChanges')} value={usage?.changes ?? 0} />
            <Stat label={t('memoryCloudBytes')} value={fmtBytes(usage?.bytes ?? 0)} />
          </div>
          {usage?.accountEmail && <p className="mt-2 text-[10px] text-[var(--text-muted)]">{t('memoryDriveAccount')}: <span className="font-mono">{usage.accountEmail}</span></p>}
          {!!usage?.quotaLimit && (
            <p className="mt-1 text-[10px] text-[var(--text-muted)]">
              {t('memoryDriveQuota')}: {fmtBytes(usage.quotaUsed ?? 0)} / {fmtBytes(usage.quotaLimit)}
            </p>
          )}
        </section>

        <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
          <div className="flex items-center gap-2 mb-2">
            <FiShield size={12} className="text-[var(--accent)]" />
            <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{t('memoryCloudSecurity')}</h4>
          </div>
          <div className="space-y-1 text-[10px] leading-relaxed">
            <div><span className="text-[var(--text-muted)]">TLS: </span><span className="text-[var(--text-secondary)]">{effectiveSecurity.transport}</span></div>
            <div><span className="text-[var(--text-muted)]">At rest: </span><span className="text-[var(--text-secondary)]">{effectiveSecurity.serverAtRest}</span></div>
            <div><span className="text-[var(--text-muted)]">E2E: </span><span className="text-[var(--text-secondary)]">{effectiveSecurity.endToEnd}</span></div>
            {effectiveSecurity.warnings.map((warning) => <p key={warning} className="rounded bg-[color-mix(in_srgb,var(--warning)_8%,transparent)] px-1.5 py-1 text-[var(--warning)]">{warning}</p>)}
          </div>
        </section>
      </div>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
        <div className="flex items-center gap-2 mb-2">
          <FiHardDrive size={12} className="text-[var(--accent)]" />
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{t('memoryCloudDevices')}</h4>
          <span className="ml-auto text-[10px] font-mono text-[var(--text-muted)]">{devices.length}</span>
        </div>
        {devices.length === 0 ? <p className="text-[10px] text-[var(--text-muted)]">{t('memoryCloudNoDevices')}</p> : (
          <div className="space-y-1">
            {devices.map((device) => (
              <div key={device.deviceId} className="flex items-center gap-2 rounded-lg bg-[var(--bg-2)] px-2 py-1 text-[10px]">
                <FiCloud size={10} className="text-[var(--text-muted)]" />
                <span className="min-w-0 flex-1 truncate font-mono text-[var(--text-secondary)]">{device.deviceId}</span>
                <span className="shrink-0 text-[9px] text-[var(--text-muted)]">{fmtTime(device.lastSeenAt)}</span>
                <button
                  onClick={() => { if (window.confirm(t('memoryCloudRevokeConfirm'))) void revokeDevice(device.deviceId); }}
                  className="shrink-0 text-[9px] text-[var(--text-muted)] hover:text-[var(--error)] cursor-pointer"
                >
                  {t('memoryCloudRevoke')}
                </button>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="rounded-xl border border-[var(--border)] bg-[var(--bg-1)] p-3">
        <div className="flex items-center gap-2 mb-1.5">
          <FiArchive size={12} className="text-[var(--accent)]" />
          <h4 className="text-[11px] font-semibold uppercase tracking-wider text-[var(--text-secondary)]">{t('memoryOverviewMigration')}</h4>
        </div>
        <p className="text-[10px] leading-relaxed text-[var(--text-muted)]">
          {migration
            ? `${t('memoryMigrationImported')}: ${migration.imported} · ${t('memoryMigrationDuplicates')}: ${migration.skippedDuplicates} · ${t('memoryMigrationOtherProject')}: ${migration.skippedOtherProject} · ${migration.verified ? t('memoryMigrationVerified') : t('memoryMigrationUnverified')}`
            : t('memoryMigrationNotRun')}
        </p>
      </section>
    </div>
  );
}
