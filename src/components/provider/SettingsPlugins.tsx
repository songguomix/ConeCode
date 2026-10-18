import { useEffect, useMemo, useState } from 'react';
import {
  FiX, FiChevronLeft, FiChevronDown, FiPlus, FiSearch, FiRefreshCw,
  FiGithub, FiActivity, FiShield, FiList, FiGitCommit, FiMap, FiBox,
} from 'react-icons/fi';
import { usePluginStore, selectPlugins, type PluginEntry } from '../../stores/plugin.store';
import { useMarketStore } from '../../stores/market.store';
import { useSkillsStore, useChatStore, useModelStore, useUIStore, useLanguageStore } from '../../stores';
import { buildCreatePluginPrompt } from '../../core/plugins/plugins';
import SyncView from '../plugins/SyncView';
import PerfView from '../plugins/PerfView';
import SecurityView from '../plugins/SecurityView';
import SkillRunView from '../plugins/SkillRunView';

const ICONS: Record<string, JSX.Element> = {
  github: <FiGithub size={18} />,
  activity: <FiActivity size={18} />,
  shield: <FiShield size={18} />,
  list: <FiList size={18} />,
  commit: <FiGitCommit size={18} />,
  map: <FiMap size={18} />,
  box: <FiBox size={18} />,
};

const TILE_BG: Record<string, string> = {
  github: 'bg-black text-white',
  activity: 'bg-orange-500/15 text-orange-500',
  shield: 'bg-blue-500/15 text-blue-500',
  list: 'bg-emerald-500/15 text-emerald-500',
  commit: 'bg-violet-500/15 text-violet-500',
  map: 'bg-amber-500/15 text-amber-500',
  box: 'bg-[var(--bg-3)] text-[var(--text-secondary)]',
};

type View = { kind: 'list' } | { kind: 'detail'; id: string } | { kind: 'sync' } | { kind: 'create' };
type Chip = 'all' | 'builtin' | 'market' | 'custom';
type T = (k: string) => string;

/**
 * Builtins ship fixed zh metadata; the library reads through i18n so names
 * and descriptions follow the current locale. Market/custom entries keep
 * their own (user or remote) strings — those are data, not UI copy.
 */
export const pluginDisplayName = (p: PluginEntry, t: T): string =>
  (p.kind === 'builtin' ? t(`pluginName_${p.id}`) : p.name);
export const pluginDisplayDesc = (p: PluginEntry, t: T): string =>
  (p.kind === 'builtin' ? t(`pluginDesc_${p.id}`) : p.description);

function IconTile({ icon, size = 'w-10 h-10' }: { icon: string; size?: string }) {
  return (
    <span className={`${size} rounded-xl flex items-center justify-center shrink-0 ${TILE_BG[icon] || TILE_BG.box}`}>
      {ICONS[icon] || ICONS.box}
    </span>
  );
}

/**
 * Screenshot-style plugin library inside Settings: search, installed list
 * with source chips, a hot grid of our own plugins, an add menu (AI-assisted
 * creation, market sync — no skill recording), and one detail view each.
 * Skills stay a separate system; plugins only link to them by skillId.
 */
export default function SettingsPlugins({ t }: { t: (k: string) => string }) {
  const [view, setView] = useState<View>({ kind: 'list' });
  const [query, setQuery] = useState('');
  const [chip, setChip] = useState<Chip>('all');
  const [addOpen, setAddOpen] = useState(false);

  // Reactive subscriptions so list/detail refresh on any registry change.
  const custom = usePluginStore((s) => s.custom);
  const disabled = usePluginStore((s) => s.disabled);
  const installedSkills = useSkillsStore((s) => s.installed);
  const skillsLoaded = useSkillsStore((s) => s.loaded);
  const loadSkills = useSkillsStore((s) => s.load);
  void custom; void disabled; void installedSkills;

  useEffect(() => {
    if (!skillsLoaded) void loadSkills();
  }, [skillsLoaded, loadSkills]);

  const plugins = useMemo(() => selectPlugins(), [custom, disabled, installedSkills]);
  const q = query.trim().toLowerCase();
  const matches = (p: PluginEntry) =>
    !q || pluginDisplayName(p, t).toLowerCase().includes(q) || pluginDisplayDesc(p, t).toLowerCase().includes(q);
  const installed = plugins.filter(
    (p) => matches(p) && (chip === 'all' || p.kind === chip) && p.skillInstalled !== false,
  );
  // Hot = our six builtins, always present, two-column cards like the mock.
  const hot = plugins.filter((p) => p.kind === 'builtin' && matches(p));

  return (
    <div className="min-w-0">
      {view.kind === 'list' && (
        <>
          <div className="flex items-center justify-between gap-2.5 mb-4">
            <div className="relative flex-1">
              <FiSearch size={14} className="absolute left-3.5 top-1/2 -translate-y-1/2 text-[var(--text-muted)]" />
              <input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('pluginSearchPh')}
                spellCheck={false}
                className="w-full pl-9 pr-3.5 py-2 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs"
              />
            </div>
            <div className="flex items-center gap-2 shrink-0">
              <button
                onClick={() => void useMarketStore.getState().refresh()}
                title={t('pluginRefresh')}
                className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-1)] border border-[var(--border)] transition-all shadow-2xs cursor-pointer"
              >
                <FiRefreshCw size={13} />
              </button>
              <div className="relative">
                <button
                  onClick={() => setAddOpen((v) => !v)}
                  className="h-8 px-3 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-medium flex items-center gap-1.5 hover:opacity-95 shadow-2xs transition-all cursor-pointer"
                >
                  <FiPlus size={13} /> {t('pluginAdd')} <FiChevronDown size={12} />
                </button>
                {addOpen && (
                  <>
                    <div className="fixed inset-0 z-40" onClick={() => setAddOpen(false)} />
                    <div className="absolute right-0 top-full mt-1.5 w-44 rounded-2xl border border-[var(--border)] bg-[var(--bg-2)] shadow-2xl z-50 py-1.5 anim-menu ring-1 ring-black/5 dark:ring-white/10">
                      <button
                        onClick={() => { setAddOpen(false); setView({ kind: 'create' }); }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                      >
                        <FiPlus size={13} />{t('pluginCreate')}
                      </button>
                      <button
                        onClick={() => { setAddOpen(false); setView({ kind: 'sync' }); }}
                        className="w-full flex items-center gap-2.5 px-3.5 py-2 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
                      >
                        <FiGithub size={13} />{t('pluginAddGithub')}
                      </button>
                    </div>
                  </>
                )}
              </div>
            </div>
          </div>

          <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs mb-4">
            <div className="flex items-center justify-between gap-2 mb-3 pb-2.5 border-b border-[var(--border)]/60">
              <div className="flex items-center gap-2">
                <FiBox size={14} className="text-[var(--accent)]" />
                <h4 className="font-semibold text-sm text-[var(--text-primary)]">{t('pluginInstalled')}</h4>
                {installed.length > 0 && (
                  <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 font-medium font-mono">
                    {installed.length}
                  </span>
                )}
              </div>
              <div className="inline-flex p-0.5 bg-[var(--bg-1)] border border-[var(--border)] rounded-lg gap-0.5">
                {(['all', 'builtin', 'market', 'custom'] as Chip[]).map((c) => (
                  <button
                    key={c}
                    onClick={() => setChip(c)}
                    className={`px-2.5 py-1 rounded-md text-[11px] font-medium transition-all cursor-pointer ${
                      chip === c
                        ? 'bg-[var(--bg-2)] text-[var(--accent)] font-semibold shadow-2xs border border-[var(--border)]/70'
                        : 'text-[var(--text-muted)] hover:text-[var(--text-primary)] border border-transparent'
                    }`}
                  >
                    {t(`pluginChip_${c}`)}
                  </button>
                ))}
              </div>
            </div>
            <div className="divide-y divide-[var(--border)]">
              {installed.length === 0 && (
                <p className="py-4 text-xs text-[var(--text-muted)] text-center">{t('pluginEmpty')}</p>
              )}
              {installed.map((p) => (
                <InstalledRow key={p.id} plugin={p} t={t} onOpen={() => setView({ kind: 'detail', id: p.id })} />
              ))}
            </div>
          </div>

          <div className="space-y-2.5">
            <h4 className="text-xs font-semibold text-[var(--text-secondary)] uppercase tracking-wider px-1">{t('pluginHot')}</h4>
            <div className="grid grid-cols-2 gap-3">
              {hot.map((p) => (
                <button
                  key={p.id}
                  onClick={() => setView({ kind: 'detail', id: p.id })}
                  className="flex items-center gap-3 p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] text-left min-w-0 group hover:border-[var(--accent)]/50 hover:bg-[var(--bg-3)]/30 transition-all shadow-2xs cursor-pointer"
                >
                  <IconTile icon={p.icon} />
                  <span className="flex-1 min-w-0">
                    <span className="block text-xs font-semibold text-[var(--text-primary)] truncate group-hover:text-[var(--accent)] transition-colors">
                      {pluginDisplayName(p, t)}
                    </span>
                    <span className="block text-[11px] text-[var(--text-muted)] truncate mt-0.5">{pluginDisplayDesc(p, t)}</span>
                  </span>
                  {p.skillInstalled && (
                    <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-medium border border-[var(--accent)]/30 shrink-0">
                      {t('pluginInstalled')}
                    </span>
                  )}
                </button>
              ))}
            </div>
          </div>
        </>
      )}

      {view.kind !== 'list' && (
        <button
          onClick={() => setView({ kind: 'list' })}
          className="flex items-center gap-1.5 mb-2 text-[13px] text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors"
        >
          <FiChevronLeft size={14} />{t('pluginBack')}
        </button>
      )}
      {view.kind === 'sync' && <SyncView />}
      {view.kind === 'create' && <CreateView t={t} onDone={(id) => setView({ kind: 'detail', id })} />}
      {view.kind === 'detail' && <DetailView id={view.id} t={t} />}
    </div>
  );
}

const KIND_BADGE: Record<string, string> = {
  builtin: 'bg-[var(--accent-soft)] text-[var(--accent)]',
  market: 'bg-[var(--warning)]/15 text-[var(--warning)]',
  custom: 'bg-[var(--bg-3)] text-[var(--text-secondary)]',
};

function InstalledRow({ plugin: p, t, onOpen }: { plugin: PluginEntry; t: (k: string) => string; onOpen: () => void }) {
  const setEnabled = usePluginStore((s) => s.setEnabled);
  const removeCustom = usePluginStore((s) => s.removeCustom);
  return (
    <div className="flex items-center gap-3 py-2.5 min-w-0">
      <IconTile icon={p.icon} size="w-9 h-9" />
      <div className="flex-1 min-w-0">
        <p className="text-sm font-medium text-[var(--text-primary)] truncate">{pluginDisplayName(p, t)}</p>
        <p className="text-xs text-[var(--text-muted)] truncate mt-0.5">{pluginDisplayDesc(p, t)}</p>
      </div>
      <span className={`text-[10px] px-2 py-0.5 rounded-full shrink-0 font-medium ${KIND_BADGE[p.kind]}`}>
        {t(`pluginChip_${p.kind}`)}
      </span>
      {p.view && (
        <button onClick={onOpen} title={t('pluginOpen')}
          className="px-2.5 py-1 rounded-lg text-xs text-[var(--accent)] hover:bg-[var(--accent-soft)] transition-colors shrink-0 cursor-pointer">
          {t('pluginOpen')}
        </button>
      )}
      <button
        onClick={() => setEnabled(p.id, !p.enabled)}
        title={t(p.enabled ? 'pluginDisable' : 'pluginEnable')}
        className={`w-9 h-5 rounded-full transition-colors shrink-0 relative cursor-pointer ${p.enabled ? 'bg-[var(--accent)]' : 'bg-[var(--bg-4)]'}`}
      >
        <span className={`absolute top-0.5 w-4 h-4 rounded-full bg-white shadow transition-all ${p.enabled ? 'left-[18px]' : 'left-0.5'}`} />
      </button>
      {p.kind === 'custom' && (
        <button onClick={() => removeCustom(p.id)} title={t('pluginRemove')}
          className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--error)] transition-colors shrink-0 cursor-pointer">
          <FiX size={13} />
        </button>
      )}
    </div>
  );
}

function DetailView({ id, t }: { id: string; t: (k: string) => string }) {
  const custom = usePluginStore((s) => s.custom);
  const disabled = usePluginStore((s) => s.disabled);
  const installedSkills = useSkillsStore((s) => s.installed);
  void custom; void disabled; void installedSkills;

  const plugins = selectPlugins();
  const p = plugins.find((x) => x.id === id);
  if (!p) return <p className="text-[13px] text-[var(--text-muted)]">{t('pluginEmpty')}</p>;
  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2.5 mb-3">
        <IconTile icon={p.icon} />
        <div className="min-w-0">
          <p className="text-[15px] font-semibold text-[var(--text-primary)]">{pluginDisplayName(p, t)}</p>
          <p className="text-[12px] text-[var(--text-muted)]">{pluginDisplayDesc(p, t)}</p>
        </div>
      </div>
      {p.view === 'sync' && <SyncView />}
      {p.view === 'perf' && <PerfView />}
      {p.view === 'security' && <SecurityView />}
      {p.view === 'skill' && p.skillId && <SkillRunView skillId={p.skillId} />}
      {p.view === 'skill' && !p.skillId && (
        <p className="text-[13px] text-[var(--text-muted)]">{t('pluginNeedInstall')}</p>
      )}
    </div>
  );
}

function CreateView({ t, onDone }: { t: (k: string) => string; onDone: (id: string) => void }) {
  const [name, setName] = useState('');
  const [description, setDescription] = useState('');
  const [skillId, setSkillId] = useState('');
  const addCustom = usePluginStore((s) => s.addCustom);
  const installedSkills = useSkillsStore((s) => s.installed);
  const sendMessage = useChatStore((s) => s.sendMessage);
  const getSelectedModel = useModelStore((s) => s.getSelectedModel);
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const model = getSelectedModel();

  const aiCreate = async () => {
    if (!model) return;
    toggleSettings();
    await sendMessage(buildCreatePluginPrompt(t), model.providerId, model.id);
  };

  return (
    <div className="min-w-0">
      <div className="flex items-center gap-2 mb-3">
        <div className="flex-1">
          <p className="text-[15px] font-semibold text-[var(--text-primary)]">{t('pluginCreate')}</p>
          <p className="text-[12px] text-[var(--text-muted)]">{t('pluginCreateHint')}</p>
        </div>
        <button
          onClick={() => void aiCreate()}
          disabled={!model}
          title={t('pluginCreateAiHint')}
          className="px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-[12px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40 shrink-0"
        >
          {t('pluginCreateAi')}
        </button>
      </div>
      <label className="block mb-1 text-[12px] text-[var(--text-muted)]">{t('pluginNameLabel')}</label>
      <input
        value={name}
        onChange={(e) => setName(e.target.value)}
        spellCheck={false}
        className="w-full mb-2 px-3 py-2 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] text-[13px] outline-none focus:border-[var(--accent)]/50"
      />
      <label className="block mb-1 text-[12px] text-[var(--text-muted)]">{t('pluginDescLabel')}</label>
      <input
        value={description}
        onChange={(e) => setDescription(e.target.value)}
        spellCheck={false}
        className="w-full mb-2 px-3 py-2 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] text-[13px] outline-none focus:border-[var(--accent)]/50"
      />
      <label className="block mb-1 text-[12px] text-[var(--text-muted)]">{t('pluginSkillLabel')}</label>
      <select
        value={skillId}
        onChange={(e) => setSkillId(e.target.value)}
        className="w-full mb-3 px-3 py-2 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] text-[13px] outline-none focus:border-[var(--accent)]/50"
      >
        <option value="">{t('pluginSkillNone')}</option>
        {installedSkills.map((s) => (
          <option key={`${s.scope}:${s.id}`} value={s.id}>{s.name} · {s.id}</option>
        ))}
      </select>
      <button
        onClick={() => {
          const id = addCustom({ name, description, skillId: skillId || undefined });
          if (id) onDone(id);
        }}
        disabled={!name.trim() || !description.trim()}
        className="px-4 py-2 rounded-xl bg-[var(--accent)] text-white text-[13px] font-medium hover:bg-[var(--accent-hover)] transition-colors disabled:opacity-40"
      >
        {t('pluginSave')}
      </button>
    </div>
  );
}
