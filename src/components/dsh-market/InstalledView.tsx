import { useEffect, useMemo, useState } from 'react';
import semver from 'semver';
import {
  FiChevronDown, FiCode, FiExternalLink, FiFileText, FiPlay, FiPlus,
  FiRefreshCw, FiRotateCcw, FiTerminal, FiTrash2, FiX, FiZap,
} from 'react-icons/fi';
import { useDshMarketStore } from '../../stores/dshMarket.store';
import type { InstalledPlugin } from '../../core/dsh-market/types';
import { CompatBadge, PluginIcon, StatusBadge, formatDateTime } from './MarketCommon';

export default function InstalledView({ t }: { t: (key: string) => string }) {
  const snapshot = useDshMarketStore((s) => s.snapshot);
  const refresh = useDshMarketStore((s) => s.refresh);
  const setEnabled = useDshMarketStore((s) => s.setEnabled);
  const uninstall = useDshMarketStore((s) => s.uninstall);
  const rollback = useDshMarketStore((s) => s.rollback);
  const update = useDshMarketStore((s) => s.update);
  const selectPlugin = useDshMarketStore((s) => s.selectPlugin);
  const loadLogs = useDshMarketStore((s) => s.loadLogs);
  const logs = useDshMarketStore((s) => s.logs);
  const switchProfile = useDshMarketStore((s) => s.switchProfile);
  const createProfile = useDshMarketStore((s) => s.createProfile);
  const restartRuntime = useDshMarketStore((s) => s.restartRuntime);
  const cancel = useDshMarketStore((s) => s.cancel);
  const operationLog = useDshMarketStore((s) => s.operationLog);
  const error = useDshMarketStore((s) => s.error);

  const [configPlugin, setConfigPlugin] = useState<InstalledPlugin | null>(null);
  const [runPlugin, setRunPlugin] = useState<InstalledPlugin | null>(null);
  const [logsPlugin, setLogsPlugin] = useState<InstalledPlugin | null>(null);
  const [uninstallPlugin, setUninstallPlugin] = useState<InstalledPlugin | null>(null);
  const [deleteData, setDeleteData] = useState(false);
  const [newProfile, setNewProfile] = useState('');
  const [updates, setUpdates] = useState<Record<string, string>>({});
  const installed = snapshot?.installed || [];
  const installedKey = installed.map((plugin) => `${plugin.name}@${plugin.version}`).join('|');
  useEffect(() => {
    let cancelled = false;
    const bridge = (window as any).electronAPI?.dshMarket;
    if (!bridge || !installed.length) { setUpdates({}); return () => { cancelled = true; }; }
    void Promise.all(installed.map(async (plugin) => {
      try {
        const catalog = await bridge.versions(plugin.name);
        const latest = catalog?.latest;
        return latest && semver.gt(latest, plugin.version) ? [plugin.name, latest] as const : null;
      } catch {
        return null;
      }
    })).then((rows) => {
      if (!cancelled) setUpdates(Object.fromEntries(rows.filter((row): row is readonly [string, string] => !!row)));
    });
    return () => { cancelled = true; };
  }, [installedKey]);
  const activeOp = snapshot?.operations.find((op) => ['queued', 'resolving', 'installing', 'probing', 'activating', 'restoring'].includes(op.phase));

  useEffect(() => {
    if (logsPlugin) void loadLogs(logsPlugin.id).catch(() => {});
  }, [logsPlugin, loadLogs]);

  useEffect(() => {
    if (!uninstallPlugin) setDeleteData(false);
  }, [uninstallPlugin]);

  const profile = snapshot?.profile;
  const profiles = snapshot?.profiles || [];

  return (
    <div className="flex-1 min-h-0 overflow-y-auto px-5 py-4">
      <div className="flex flex-wrap items-center gap-2 mb-4">
        <div className="flex items-center gap-1.5">
          <span className="text-[10px] uppercase tracking-wider text-[var(--text-muted)]">{t('profile')}</span>
          <select
            value={profile?.id || ''}
            onChange={(event) => void switchProfile(event.target.value).catch(() => {})}
            className="h-8 px-2 rounded-lg bg-[var(--bg-1)] border border-[var(--border)] text-[11px] text-[var(--text-secondary)] outline-none focus:border-[var(--accent)]"
          >
            {profiles.map((item) => <option key={item.id} value={item.id}>{item.name} · {item.enabledCount}/{item.pluginCount}</option>)}
          </select>
        </div>
        <div className="flex items-center gap-1">
          <input
            value={newProfile}
            onChange={(event) => setNewProfile(event.target.value)}
            placeholder={t('newProfile')}
            spellCheck={false}
            className="h-8 w-32 px-2 rounded-lg bg-[var(--bg-1)] border border-[var(--border)] text-[11px] text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
          />
          <button
            disabled={!newProfile.trim()}
            onClick={() => {
              const id = newProfile.trim();
              if (!/^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)) {
                useDshMarketStore.getState().pushNotice('Profile id: 1–32 lowercase letters, numbers, - or _.');
                return;
              }
              void createProfile(id, id).then(() => setNewProfile('')).catch(() => {});
            }}
            className="h-8 px-2.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-40 inline-flex items-center gap-1"
          >
            <FiPlus size={11} />{t('createProfile')}
          </button>
        </div>
        <div className="ml-auto flex items-center gap-2 text-[10.5px]">
          <button onClick={() => void restartRuntime().catch(() => {})} className="px-2 py-1 rounded-lg border border-[var(--border)] text-[var(--text-muted)] hover:text-[var(--text-primary)] inline-flex items-center gap-1">
            <FiRefreshCw size={10} />{t('runtimeRestart')}
          </button>
        </div>
      </div>

      {activeOp && (
        <div className="mb-3 rounded-xl border border-[var(--accent-border)] bg-[var(--accent-soft)]/40 p-3">
          <div className="flex items-center gap-2 text-[11px]">
            <span className="w-2 h-2 rounded-full bg-[var(--accent)] animate-pulse" />
            <span className="font-medium text-[var(--text-primary)]">{activeOp.kind} · {activeOp.pluginId}</span>
            <span className="text-[var(--text-muted)]">{activeOp.phase} — {activeOp.message}</span>
            <button onClick={() => void cancel(activeOp.requestId)} className="ml-auto px-2 py-1 rounded-md border border-[var(--border)] text-[10px] text-[var(--text-secondary)] hover:text-[var(--error)]">
              {t('cancelOperation')}
            </button>
          </div>
          {(operationLog || activeOp.logTail) && (
            <pre className="mt-2 max-h-28 overflow-y-auto rounded-lg bg-[var(--bg-1)] p-2 text-[10px] font-mono text-[var(--text-muted)] whitespace-pre-wrap">
              {operationLog || activeOp.logTail}
            </pre>
          )}
        </div>
      )}
      {error && <div className="mb-3 rounded-xl border border-red-500/30 bg-red-500/10 px-3 py-2 text-[11px] text-red-600 dark:text-red-400 whitespace-pre-wrap">{error}</div>}

      {installed.length === 0 ? (
        <div className="py-20 text-center">
          <FiZap size={28} className="mx-auto mb-3 text-[var(--text-muted)]" />
          <p className="text-sm text-[var(--text-muted)]">{t('empty')}</p>
          <p className="mt-1 text-[11px] text-[var(--text-muted)]">{t('reviewHint')}</p>
        </div>
      ) : (
        <div className="space-y-2.5">
          {installed.map((plugin) => (
            <div key={plugin.id} className="rounded-2xl border border-[var(--border)] bg-[var(--bg-1)]/70 p-3.5">
              <div className="flex items-start gap-3">
                <PluginIcon plugin={{ name: plugin.name, title: plugin.title, icon: undefined } as any} />
                <div className="flex-1 min-w-0">
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="text-[13px] font-semibold text-[var(--text-primary)]">{plugin.title}</span>
                    <span className="text-[10px] font-mono text-[var(--text-muted)]">{plugin.name}@{plugin.version}</span>
                    <CompatBadge state={plugin.compatibility.state}>{t(plugin.compatibility.state)}</CompatBadge>
                    <StatusBadge plugin={plugin} text={t} />
                    {plugin.clientUnsupported && <span className="text-[10px] px-1.5 py-0.5 rounded-md bg-sky-500/12 text-sky-600 dark:text-sky-400">{t('clientOnly')}</span>}
                  </div>
                  <div className="mt-1 flex items-center gap-2 flex-wrap text-[10px] text-[var(--text-muted)]">
                    <span>{plugin.format === 'native' ? 'ConeCode native' : 'DSH bundle'}</span>
                    <span>·</span>
                    <span>{formatDateTime(plugin.updatedAt)}</span>
                    <span>·</span>
                    <span>{plugin.contributions.tools.length} {t('tools')} · {plugin.contributions.commands.length} {t('commands')} · {plugin.contributions.skills.length} {t('skills')}</span>
                  </div>
                  {plugin.lastError && <div className="mt-1 text-[10px] text-[var(--error)] whitespace-pre-wrap">{plugin.lastError}</div>}
                  <div className="mt-1 flex items-center gap-2 flex-wrap">
                    {plugin.rows.map((row) => (
                      <span key={row.id} className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)] font-mono">{row.id}: {row.name}</span>
                    ))}
                    {plugin.backups.length > 0 && (
                      <span className="text-[9.5px] text-[var(--text-muted)]">{t('backups')}: {plugin.backups.map((backup) => backup.version).join(', ')}</span>
                    )}
                  </div>
                </div>
                <div className="flex flex-col items-end gap-1.5 shrink-0">
                  <button
                    onClick={() => void setEnabled(plugin.id, !plugin.enabled).catch(() => {})}
                    role="switch"
                    aria-checked={plugin.enabled}
                    title={plugin.enabled ? t('disable') : t('enable')}
                    className={`w-9 h-5 rounded-full relative transition-colors ${plugin.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-4)]'}`}
                  >
                    <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${plugin.enabled ? 'left-[18px]' : 'left-0.5'}`} />
                  </button>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    <ActionButton icon={<FiFileText size={10} />} label={t('details')} onClick={() => void selectPlugin(plugin.name).catch(() => {})} />
                    <ActionButton icon={<FiCode size={10} />} label={t('config')} onClick={() => setConfigPlugin(plugin)} />
                    <ActionButton icon={<FiTerminal size={10} />} label={t('logs')} onClick={() => setLogsPlugin(plugin)} />
                    <ActionButton icon={<FiPlay size={10} />} label={t('run')} onClick={() => setRunPlugin(plugin)} />
                  </div>
                  <div className="flex items-center gap-1 flex-wrap justify-end">
                    {updates[plugin.name] && (
                      <ActionButton icon={<FiRefreshCw size={10} />} label={`${t('update')} ${updates[plugin.name]}`} onClick={() => void update(plugin.id, updates[plugin.name]).catch(() => {})} />
                    )}
                    {plugin.backups.length > 0 && (
                      <ActionButton icon={<FiRotateCcw size={10} />} label={t('rollback')} onClick={() => {
                        const backup = plugin.backups[plugin.backups.length - 1];
                        if (backup) void rollback(plugin.id, backup.version).catch(() => {});
                      }} />
                    )}
                    <ActionButton icon={<FiTrash2 size={10} />} label={t('uninstall')} tone="danger" onClick={() => setUninstallPlugin(plugin)} />
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="mt-5 rounded-xl border border-[var(--border)] bg-[var(--bg-1)]/40 p-3 text-[10.5px] text-[var(--text-muted)] leading-relaxed">
        <div className="font-medium text-[var(--text-secondary)] mb-1">{t('dataPolicy')}</div>
        {profile && <div className="font-mono break-all">{t('profileDirectory')}: {profile.directory}</div>}
      </div>

      {configPlugin && <ConfigDialog plugin={configPlugin} t={t} onClose={() => setConfigPlugin(null)} />}
      {runPlugin && <RunDialog plugin={runPlugin} t={t} onClose={() => setRunPlugin(null)} />}
      {logsPlugin && (
        <Modal t={t} title={`${logsPlugin.title} · ${t('logs')}`} onClose={() => setLogsPlugin(null)}>
          <div className="text-[10px] font-mono text-[var(--text-muted)] mb-2 break-all">{logs?.path}</div>
          <pre className="max-h-[55vh] overflow-auto rounded-xl bg-[var(--bg-1)] border border-[var(--border)] p-3 text-[10.5px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap">
            {logs?.text || t('noLogs')}
          </pre>
        </Modal>
      )}
      {uninstallPlugin && (
        <Modal t={t} title={t('confirmUninstall')} onClose={() => setUninstallPlugin(null)}>
          <p className="text-[12px] text-[var(--text-secondary)]">{uninstallPlugin.title} · {uninstallPlugin.name}@{uninstallPlugin.version}</p>
          <p className="mt-2 text-[11px] text-[var(--text-muted)]">{t('dataPolicy')}</p>
          <label className="mt-3 flex items-center gap-2 text-[11px] text-[var(--text-secondary)]">
            <input type="checkbox" checked={deleteData} onChange={(event) => setDeleteData(event.target.checked)} className="accent-red-500" />
            {t('deleteData')}
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button onClick={() => setUninstallPlugin(null)} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-secondary)]">{t('cancel')}</button>
            <button
              onClick={() => {
                const plugin = uninstallPlugin;
                setUninstallPlugin(null);
                void uninstall(plugin.id, deleteData).catch(() => {});
              }}
              className="px-3 py-1.5 rounded-lg bg-red-500 text-white text-[11px] font-medium"
            >
              {t('confirm')}
            </button>
          </div>
        </Modal>
      )}
    </div>
  );
}

function ActionButton({ icon, label, onClick, tone = 'normal' }: {
  icon: React.ReactNode;
  label: string;
  onClick: () => void;
  tone?: 'normal' | 'danger';
}) {
  return (
    <button onClick={onClick}
      className={`px-1.5 py-1 rounded-md border border-[var(--border)] text-[10px] inline-flex items-center gap-1 ${tone === 'danger' ? 'text-[var(--text-muted)] hover:text-[var(--error)]' : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)]'} hover:bg-[var(--bg-2)]`}>
      {icon}{label}
    </button>
  );
}

function Modal({ t, title, children, onClose }: { t: (key: string) => string; title: string; children: React.ReactNode; onClose: () => void }) {
  return (
    <div className="fixed inset-0 z-[90] flex items-center justify-center p-4 bg-black/35 backdrop-blur-sm" onClick={onClose}>
      <div className="w-full max-w-2xl rounded-2xl border border-[var(--border)] bg-[var(--bg-0)] shadow-2xl max-h-[85vh] flex flex-col" onClick={(event) => event.stopPropagation()}>
        <div className="flex items-center gap-2 px-4 py-3 border-b border-[var(--border)]">
          <span className="text-sm font-semibold text-[var(--text-primary)] flex-1 min-w-0 truncate">{title}</span>
          <button onClick={onClose} className="w-7 h-7 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] flex items-center justify-center" aria-label={t('close')}>
            <FiX size={14} />
          </button>
        </div>
        <div className="p-4 overflow-y-auto min-h-0">{children}</div>
      </div>
    </div>
  );
}

function ConfigDialog({ plugin, t, onClose }: { plugin: InstalledPlugin; t: (key: string) => string; onClose: () => void }) {
  const saveConfig = useDshMarketStore((s) => s.saveConfig);
  const [drafts, setDrafts] = useState<Record<string, string>>(() => Object.fromEntries(plugin.rows.map((row) => [row.id, JSON.stringify(row.config ?? {}, null, 2)])));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setError(null);
    const configs: Record<string, unknown> = {};
    try {
      for (const row of plugin.rows) configs[row.id] = JSON.parse(drafts[row.id] || '{}');
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }
    setBusy(true);
    try {
      await saveConfig(plugin.id, configs);
      useDshMarketStore.getState().pushNotice(t('configSaved'));
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : String(saveError));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Modal t={t} title={`${plugin.title} · ${t('configTitle')}`} onClose={onClose}>
      <p className="text-[11px] text-[var(--text-muted)] mb-3">{t('configHint')}</p>
      {plugin.rows.length === 0 && <p className="text-[12px] text-[var(--text-muted)]">{t('noConfig')}</p>}
      <div className="space-y-3">
        {plugin.rows.map((row) => (
          <div key={row.id}>
            <div className="flex items-center gap-2 mb-1">
              <span className="text-[11px] font-medium text-[var(--text-secondary)]">{t('row')} · {row.id}</span>
              <span className="text-[10px] font-mono text-[var(--text-muted)]">{row.name}</span>
            </div>
            <textarea
              value={drafts[row.id]}
              onChange={(event) => setDrafts((current) => ({ ...current, [row.id]: event.target.value }))}
              spellCheck={false}
              rows={8}
              className="w-full rounded-xl bg-[var(--bg-1)] border border-[var(--border)] p-3 text-[11px] font-mono text-[var(--text-primary)] outline-none focus:border-[var(--accent)] resize-y"
            />
          </div>
        ))}
      </div>
      {error && <div className="mt-3 text-[11px] text-[var(--error)] whitespace-pre-wrap">{error}</div>}
      <div className="mt-4 flex justify-end gap-2">
        <button onClick={onClose} className="px-3 py-1.5 rounded-lg border border-[var(--border)] text-[11px] text-[var(--text-secondary)]">{t('cancel')}</button>
        <button onClick={() => void save()} disabled={busy || plugin.rows.length === 0}
          className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium disabled:opacity-50">
          {busy ? t('saving') : t('saveConfig')}
        </button>
      </div>
    </Modal>
  );
}

function RunDialog({ plugin, t, onClose }: { plugin: InstalledPlugin; t: (key: string) => string; onClose: () => void }) {
  const invokeTool = useDshMarketStore((s) => s.invokeTool);
  const invokeCommand = useDshMarketStore((s) => s.invokeCommand);
  const [toolArgs, setToolArgs] = useState<Record<string, string>>({});
  const [commandInput, setCommandInput] = useState<Record<string, string>>({});
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const contributions = plugin.contributions;
  const hasAny = contributions.tools.length + contributions.commands.length + contributions.skills.length > 0;

  const runTool = async (name: string) => {
    setError(null);
    setResult(null);
    let args: unknown = {};
    try {
      args = JSON.parse(toolArgs[name] || '{}');
    } catch (parseError) {
      setError(parseError instanceof Error ? parseError.message : String(parseError));
      return;
    }
    setBusy(`tool:${name}`);
    try {
      setResult(await invokeTool(plugin.id, name, args));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(null);
    }
  };

  const runCommand = async (name: string) => {
    setError(null);
    setResult(null);
    setBusy(`command:${name}`);
    try {
      setResult(await invokeCommand(plugin.id, name, commandInput[name] || ''));
    } catch (runError) {
      setError(runError instanceof Error ? runError.message : String(runError));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal t={t} title={`${plugin.title} · ${t('run')}`} onClose={onClose}>
      {!hasAny && <p className="text-[12px] text-[var(--text-muted)]">{t('noContributions')}</p>}
      <div className="space-y-3">
        {contributions.tools.map((tool) => (
          <div key={`tool-${tool.name}`} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex items-center gap-2">
              <FiZap size={12} className="text-[var(--accent)]" />
              <span className="text-[12px] font-medium text-[var(--text-primary)]">{tool.name}</span>
              <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">{t('tools')}</span>
            </div>
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">{tool.description}</p>
            <textarea
              value={toolArgs[tool.name] ?? '{}'}
              onChange={(event) => setToolArgs((current) => ({ ...current, [tool.name]: event.target.value }))}
              rows={3}
              spellCheck={false}
              placeholder={t('toolArgs')}
              className="mt-2 w-full rounded-lg bg-[var(--bg-1)] border border-[var(--border)] p-2 text-[10.5px] font-mono outline-none focus:border-[var(--accent)] resize-y"
            />
            <button onClick={() => void runTool(tool.name)} disabled={busy !== null}
              className="mt-2 px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[10.5px] font-medium disabled:opacity-50 inline-flex items-center gap-1">
              <FiPlay size={10} />{busy === `tool:${tool.name}` ? t('running') : t('runTool')}
            </button>
          </div>
        ))}
        {contributions.commands.map((command) => (
          <div key={`cmd-${command.name}`} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex items-center gap-2">
              <FiTerminal size={12} className="text-[var(--accent)]" />
              <span className="text-[12px] font-medium text-[var(--text-primary)]">/{command.name}</span>
              <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">{t('commands')}</span>
            </div>
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">{command.description}{command.inputHint ? ` · ${command.inputHint}` : ''}</p>
            <input
              value={commandInput[command.name] || ''}
              onChange={(event) => setCommandInput((current) => ({ ...current, [command.name]: event.target.value }))}
              placeholder={t('commandInput')}
              className="mt-2 w-full rounded-lg bg-[var(--bg-1)] border border-[var(--border)] px-2 py-1.5 text-[10.5px] font-mono outline-none focus:border-[var(--accent)]"
            />
            <button onClick={() => void runCommand(command.name)} disabled={busy !== null}
              className="mt-2 px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white text-[10.5px] font-medium disabled:opacity-50 inline-flex items-center gap-1">
              <FiPlay size={10} />{busy === `command:${command.name}` ? t('running') : t('runCommand')}
            </button>
          </div>
        ))}
        {contributions.skills.map((skill) => (
          <div key={`skill-${skill.name}`} className="rounded-xl border border-[var(--border)] p-3">
            <div className="flex items-center gap-2">
              <FiFileText size={12} className="text-[var(--accent)]" />
              <span className="text-[12px] font-medium text-[var(--text-primary)]">{skill.name}</span>
              <span className="text-[9.5px] px-1.5 py-0.5 rounded bg-[var(--bg-3)] text-[var(--text-muted)]">{t('skills')}</span>
            </div>
            <p className="mt-1 text-[10.5px] text-[var(--text-muted)]">{skill.description}</p>
            <button
              onClick={() => {
                setBusy(`skill:${skill.name}`);
                setError(null);
                void (window as any).electronAPI.dshMarket.skillContent(plugin.id, skill.name).then((content: string | null) => {
                  setResult(content || '');
                  setBusy(null);
                }).catch((skillError: unknown) => {
                  setError(skillError instanceof Error ? skillError.message : String(skillError));
                  setBusy(null);
                });
              }}
              disabled={busy !== null}
              className="mt-2 px-2.5 py-1 rounded-lg border border-[var(--border)] text-[10.5px] text-[var(--text-secondary)] disabled:opacity-50"
            >
              {t('openSkill')}
            </button>
          </div>
        ))}
      </div>
      {busy?.startsWith('skill:') && <div className="mt-3 text-[11px] text-[var(--text-muted)]">{t('running')}</div>}
      {error && <div className="mt-3 text-[11px] text-[var(--error)] whitespace-pre-wrap">{error}</div>}
      {result !== null && (
        <div className="mt-3">
          <div className="text-[10px] uppercase tracking-wider text-[var(--text-muted)] mb-1">{t('result')}</div>
          <pre className="max-h-[35vh] overflow-auto rounded-xl bg-[var(--bg-1)] border border-[var(--border)] p-3 text-[10.5px] font-mono text-[var(--text-secondary)] whitespace-pre-wrap">{result}</pre>
        </div>
      )}
    </Modal>
  );
}
