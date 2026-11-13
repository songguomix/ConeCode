import { useState, useEffect, useRef, useId, type Dispatch, type SetStateAction } from 'react';
import { FiX, FiPlus, FiEdit3, FiTrash2, FiCheck, FiServer, FiZap, FiRefreshCw, FiSliders, FiPackage, FiCpu, FiBell, FiBox, FiGlobe, FiFileText, FiDownload } from 'react-icons/fi';
import { useUIStore, useProviderStore, useLanguageStore, useSettingsStore, useUpdateStore, LOCALES } from '../../stores';
import type { ProviderConfig, ProviderType } from '../../types';
import MemoryPanel from '../memory/MemoryPanel';
import SkillsPanel from '../skills/SkillsPanel';
import UpdateSettingsPanel from '../update/UpdateSettingsPanel';
import SettingsPlugins from './SettingsPlugins';
import ShortcutCard from '../screenshot/ShortcutCard';
import FreeProviderCard from './FreeProviderCard';
import PromptsSettingsPanel from './PromptsSettingsPanel';
import { parseMcpConfig } from './mcpConfig';

const MCP_PLACEHOLDER = `{
  "mcpServers": {
    "filesystem": {
      "command": "npx",
      "args": ["-y", "@modelcontextprotocol/server-filesystem", "/path/to/project"]
    }
  }
}`;

function McpSettings({ t }: { t: (k: string) => string }) {
  const [text, setText] = useState('');
  const [tools, setTools] = useState<{ server: string; name: string }[]>([]);
  const [status, setStatus] = useState('');
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const savingRef = useRef(false);

  useEffect(() => {
    let active = true;
    const load = async () => {
      try {
        const api = (window as any).electronAPI?.mcp;
        const [cfg, available] = await Promise.all([api?.getConfig?.(), api?.list?.()]);
        if (!active) return;
        setText(cfg && Object.keys(cfg.mcpServers || cfg.servers || {}).length ? JSON.stringify(cfg, null, 2) : '');
        setTools(Array.isArray(available) ? available : []);
      } catch (error) {
        if (active) setStatus(`⚠ ${error instanceof Error ? error.message : String(error)}`);
      } finally {
        if (active) setLoading(false);
      }
    };
    void load();
    return () => { active = false; };
  }, []);

  const save = async () => {
    if (savingRef.current || loading) return;
    savingRef.current = true;
    setBusy(true);
    setStatus('');
    try {
      const cfg = parseMcpConfig(text);
      const res = await (window as any).electronAPI.mcp.setConfig(cfg);
      setTools(res || []);
      setStatus(`✓ ${(res || []).length} ${t('functions')}`);
    } catch (e: any) {
      setStatus('⚠ ' + (e?.message || String(e)));
    } finally {
      savingRef.current = false;
      setBusy(false);
    }
  };

  return (
    <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs space-y-3">
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2">
          <FiZap size={14} className="text-[var(--accent)]" />
          <span className="font-semibold text-sm text-[var(--text-primary)]">{t('mcpServers')}</span>
          {tools.length > 0 && (
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] font-medium">
              {tools.length} {t('functions')}
            </span>
          )}
        </div>
        <button onClick={save} disabled={busy || loading}
          className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-medium hover:opacity-95 disabled:opacity-50 shadow-2xs cursor-pointer">
          <FiRefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {t('save')}
        </button>
      </div>
      <textarea
        value={text}
        disabled={loading || busy}
        aria-label={t('mcpServers')}
        onChange={(e) => setText(e.target.value)}
        placeholder={MCP_PLACEHOLDER}
        spellCheck={false}
        rows={8}
        className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-3 text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] resize-y shadow-2xs leading-relaxed"
      />
      {status && (
        <div role="status" className="text-xs text-[var(--text-muted)] break-words [overflow-wrap:anywhere]">
          {status}
        </div>
      )}
    </div>
  );
}

const PROVIDER_TYPES: { value: ProviderType; labelKey: string; baseUrl: string }[] = [
  { value: 'openai', labelKey: 'OpenAI', baseUrl: 'https://api.openai.com' },
  { value: 'anthropic', labelKey: 'Anthropic', baseUrl: 'https://api.anthropic.com' },
  { value: 'gemini', labelKey: 'Gemini', baseUrl: 'https://generativelanguage.googleapis.com' },
  { value: 'deepseek', labelKey: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  { value: 'openrouter', labelKey: 'OpenRouter', baseUrl: 'https://openrouter.ai/api' },
  { value: 'custom', labelKey: 'custom', baseUrl: '' },
];

type ProviderDraft = Pick<ProviderConfig, 'name' | 'type' | 'baseUrl' | 'apiKey' | 'defaultModel' | 'timeout'>;
const emptyProviderDraft = (): ProviderDraft => ({ name: '', type: 'openai', baseUrl: 'https://api.openai.com', apiKey: '', defaultModel: '', timeout: 60000 });

export default function SettingsModal() {
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const providers = useProviderStore((s) => s.providers);
  const addProvider = useProviderStore((s) => s.addProvider);
  const updateProvider = useProviderStore((s) => s.updateProvider);
  const deleteProvider = useProviderStore((s) => s.deleteProvider);
  const toggleProvider = useProviderStore((s) => s.toggleProvider);
  const providerError = useProviderStore((s) => s.error);
  const [providerSaving, setProviderSaving] = useState(false);
  const providerSavingRef = useRef(false);
  const toolCallMode = useSettingsStore((s) => s.toolCallMode);
  const fullContext = useSettingsStore((s) => s.fullContext);
  const costLock = useSettingsStore((s) => s.costLock);
  const maxEpisodeCost = useSettingsStore((s) => s.maxEpisodeCost);
  const notificationMode = useSettingsStore((s) => s.notificationMode);
  const notifyApprovals = useSettingsStore((s) => s.notifyApprovals);
  const preventSleepWhileRunning = useSettingsStore((s) => s.preventSleepWhileRunning);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { locale, setLocale, t } = useLanguageStore();
  const updateAvailable = useUpdateStore((s) => Boolean(s.result?.ok && s.result.updateAvailable));

  const TOOL_CALL_MODES = [
    { value: 'auto', label: 'toolModeAuto' },
    { value: 'native', label: 'toolModeNative' },
    { value: 'prompt', label: 'toolModePrompt' },
  ] as const;

  const [editing, setEditing] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState<ProviderDraft>(emptyProviderDraft);

  const resetForm = () => setForm(emptyProviderDraft());

  const handleTypeChange = (type: ProviderType) => {
    const preset = PROVIDER_TYPES.find((p) => p.value === type);
    setForm((f) => ({ ...f, type, baseUrl: preset?.baseUrl || f.baseUrl }));
  };

  const saveProvider = async (id?: string) => {
    if (providerSavingRef.current) return;
    providerSavingRef.current = true;
    setProviderSaving(true);
    useProviderStore.setState({ error: null });
    try {
      const config = { ...form, name: form.name.trim(), baseUrl: form.baseUrl.trim(), apiKey: form.apiKey.trim(), defaultModel: form.defaultModel.trim() };
      if (id) await updateProvider(id, config);
      else await addProvider({ ...config, enabled: true });
      // The store exposes failures in state instead of rejecting its promise.
      // Keep the draft open so the user can correct or retry it.
      if (useProviderStore.getState().error) return;
      resetForm();
      setEditing(null);
      setShowAdd(false);
    } finally {
      providerSavingRef.current = false;
      setProviderSaving(false);
    }
  };

  const getTypeLabel = (type: ProviderType) => {
    const preset = PROVIDER_TYPES.find((p) => p.value === type);
    return preset?.labelKey === 'custom' ? t('custom') : preset?.labelKey || type;
  };

  // Claude-style: a left rail of sections, one pane of content on the right —
  // the old single column meant scrolling past MCP to reach a provider key.
  const SECTIONS = [
    { id: 'general', label: 'setGeneral', icon: <FiSliders size={14} /> },
    { id: 'providers', label: 'setProviders', icon: <FiServer size={14} /> },
    { id: 'prompts', label: 'setPrompts', icon: <FiFileText size={14} /> },
    { id: 'skills', label: 'skills', icon: <FiPackage size={14} /> },
    { id: 'plugins', label: 'plugins', icon: <FiBox size={14} /> },
    { id: 'memory', label: 'memory', icon: <FiCpu size={14} /> },
    { id: 'mcp', label: 'mcpServers', icon: <FiZap size={14} /> },
    { id: 'updates', label: 'setUpdates', icon: <FiDownload size={14} /> },
  ] as const;
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('general');
  const currentSec = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !e.defaultPrevented && !e.isComposing) toggleSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSettings]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) toggleSettings(); }}
      className="fixed inset-0 bg-black/45 backdrop-blur-sm flex items-center justify-center z-50 p-4 anim-scrim"
    >
      <div role="dialog" aria-modal="true" aria-label={t('settings')} className="w-[860px] max-w-[calc(100vw-32px)] h-[620px] max-h-[calc(100dvh-32px)] bg-[var(--bg-0)] border border-[var(--border)] rounded-2xl shadow-2xl flex overflow-hidden anim-modal ring-1 ring-black/5 dark:ring-white/10">

        {/* ---- Left rail ---- */}
        <div className="w-14 sm:w-[168px] md:w-[200px] shrink-0 bg-[var(--bg-1)] border-r border-[var(--border)] flex flex-col">
          <div className="h-14 px-3 sm:px-4 flex items-center gap-2.5 border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] shrink-0">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)] shadow-2xs border border-[color-mix(in_srgb,var(--accent)_20%,transparent)]">
              <FiSliders size={14} />
            </div>
            <h2 className="hidden sm:block text-[15.5px] font-bold text-[var(--text-primary)] font-serif tracking-tight">{t('settings')}</h2>
          </div>
          <nav aria-label={t('settings')} className="flex-1 px-1.5 sm:px-2.5 py-3 space-y-1 overflow-y-auto">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                onClick={() => setSection(sec.id)}
                title={t(sec.label)}
                aria-label={t(sec.label)}
                aria-current={section === sec.id ? 'page' : undefined}
                className={`relative w-full flex items-center justify-center sm:justify-start gap-2.5 px-2 sm:px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  section === sec.id
                    ? 'bg-[var(--bg-2)] text-[var(--text-primary)] shadow-xs border border-[color-mix(in_srgb,var(--border)_80%,transparent)] font-semibold'
                    : 'text-[var(--text-secondary)] hover:bg-[color-mix(in_srgb,var(--bg-2)_60%,transparent)] hover:text-[var(--text-primary)] border border-transparent'
                }`}
              >
                <span className={section === sec.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>{sec.icon}</span>
                <span className="hidden sm:inline">{t(sec.label)}</span>
                {sec.id === 'updates' && updateAvailable && (
                  <span aria-hidden="true" className="absolute right-1 top-1 w-1.5 h-1.5 rounded-full bg-[var(--accent)]" />
                )}
              </button>
            ))}
          </nav>
        </div>

        {/* ---- Right pane ---- */}
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-0)]">
          {/* Unified Top Header Bar matching left rail h-14 */}
          <div className="h-14 px-3 sm:px-4 flex items-center justify-between gap-3 border-b border-[color-mix(in_srgb,var(--border)_60%,transparent)] shrink-0 bg-[var(--bg-0)]">
            <div className="flex items-center gap-3 min-w-0">
              <h3 className="text-[16px] font-bold text-[var(--text-primary)] font-serif tracking-tight truncate">{t(currentSec.label)}</h3>
            </div>
            <button
              onClick={toggleSettings}
              title={t('close')}
              aria-label={t('close')}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-2)] hover:text-[var(--text-primary)] transition-all cursor-pointer shrink-0"
            >
              <FiX size={15} />
            </button>
          </div>

          {/* Scrollable Content Pane */}
          {section === 'prompts' ? (
            <div className="flex-1 min-w-0 flex flex-col overflow-hidden">
              <PromptsSettingsPanel />
            </div>
          ) : (
            <div className="flex-1 min-h-0 min-w-0 overflow-y-auto overflow-x-hidden p-3 sm:p-4 space-y-3.5">
              {section === 'general' && (
              <>
                {/* Group 0: 界面语言 */}
                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-2xs p-4">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 basis-44 min-w-0">
                      <div className="flex items-center gap-2">
                        <FiGlobe size={14} className="text-[var(--accent)] shrink-0" />
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('languageTitle')}</span>
                      </div>
                    </div>
                    <div className="inline-flex flex-wrap max-w-full p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5">
                      {LOCALES.map((l) => (
                        <button
                          key={l.value}
                          type="button"
                          onClick={() => {
                            setLocale(l.value);
                            updateSettings({ language: l.value });
                          }}
                          className={`min-w-[68px] flex-auto whitespace-nowrap px-2.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            locale === l.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[color-mix(in_srgb,var(--border)_70%,transparent)] font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-2)_40%,transparent)] border border-transparent'
                          }`}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Group 1: 模型与推理控制 */}
                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-2xs divide-y divide-[var(--border)] overflow-hidden">
                  {/* Tool Calls */}
                  <div className="p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 basis-44 min-w-0">
                      <div className="font-semibold text-sm text-[var(--text-primary)]">{t('toolCallMode')}</div>
                    </div>
                    <div className="inline-flex flex-wrap max-w-full p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5">
                      {TOOL_CALL_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => updateSettings({ toolCallMode: m.value })}
                          className={`min-w-[68px] flex-auto whitespace-nowrap px-2.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            toolCallMode === m.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[color-mix(in_srgb,var(--border)_70%,transparent)] font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-2)_40%,transparent)] border border-transparent'
                          }`}
                        >
                          {t(m.label)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Context Budget */}
                  <div className="p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 basis-44 min-w-0">
                      <div className="font-semibold text-sm text-[var(--text-primary)]">{t('contextTitle')}</div>
                    </div>
                    <div className="inline-flex flex-wrap max-w-full p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5">
                      {([{ value: false, label: 'contextCapped' }, { value: true, label: 'contextFull' }] as const).map((m) => (
                        <button
                          key={m.label}
                          type="button"
                          onClick={() => updateSettings({ fullContext: m.value })}
                          className={`min-w-[80px] flex-auto whitespace-nowrap px-2.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            fullContext === m.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[color-mix(in_srgb,var(--border)_70%,transparent)] font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-2)_40%,transparent)] border border-transparent'
                          }`}
                        >
                          {t(m.label)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* RSI Cost Lock */}
                  <div className="p-4 flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 basis-44 min-w-0">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('costTitle')}</span>
                        <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
                          <input type="checkbox" checked={costLock}
                            onChange={(e) => updateSettings({ costLock: e.target.checked })}
                            className="accent-[var(--accent)] rounded" />
                          <span className="font-medium text-[var(--text-secondary)]">{t('costLock')}</span>
                        </label>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-[var(--text-muted)]">{t('costBudget')}:</span>
                      <div className="flex items-center gap-1.5 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-2.5 py-1.5 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs">
                        <span className="text-xs text-[var(--text-muted)] font-mono">$</span>
                        <input
                          type="number"
                          min={0}
                          step={0.1}
                          value={maxEpisodeCost}
                          onChange={(e) => updateSettings({ maxEpisodeCost: Math.max(0, Number(e.target.value) || 0) })}
                          className="w-16 bg-transparent text-xs font-mono text-[var(--text-primary)] outline-none"
                        />
                        <span className="text-[11px] text-[var(--text-muted)] font-mono">USD</span>
                      </div>
                    </div>
                  </div>
                </div>

                {/* Group 3: 系统通知偏好 */}
                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-2xs p-4">
                  <div className="flex flex-wrap items-center justify-between gap-4">
                    <div className="flex-1 basis-44 min-w-0">
                      <div className="flex items-center gap-2">
                        <FiBell size={14} className="text-[var(--accent)]" />
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('notifications')}</span>
                      </div>
                    </div>
                    <div className="inline-flex flex-wrap max-w-full p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5">
                      {(['never', 'background', 'always'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => updateSettings({ notificationMode: mode })}
                          className={`min-w-[68px] flex-auto whitespace-nowrap px-2.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            notificationMode === mode
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[color-mix(in_srgb,var(--border)_70%,transparent)] font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[color-mix(in_srgb,var(--bg-2)_40%,transparent)] border border-transparent'
                          }`}
                        >
                          {t(`notification_${mode}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-[color-mix(in_srgb,var(--border)_60%,transparent)] flex flex-wrap gap-x-6 gap-y-2">
                    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                      <input type="checkbox" checked={notifyApprovals}
                        onChange={(event) => updateSettings({ notifyApprovals: event.target.checked })}
                        className="accent-[var(--accent)] rounded" />
                      {t('notifyApprovals')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                      <input type="checkbox" checked={preventSleepWhileRunning}
                        onChange={(event) => updateSettings({ preventSleepWhileRunning: event.target.checked })}
                        className="accent-[var(--accent)] rounded" />
                      {t('preventSleepWhileRunning')}
                    </label>
                  </div>
                </div>

                {/* Group 4: 屏幕截图快捷键 */}
                <ShortcutCard t={t} />
              </>
            )}

            {section === 'providers' && (
              <>
                <FreeProviderCard />
                {providerError && <div role="alert" className="rounded-xl border border-[color-mix(in_srgb,var(--error)_20%,transparent)] bg-[color-mix(in_srgb,var(--error)_10%,transparent)] p-3 text-xs text-[var(--error)] break-words [overflow-wrap:anywhere]">{providerError}</div>}
                {providers.filter((p) => p.type !== 'conecode-free').map((p) => (
                  <div key={p.id} className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs hover:border-[color-mix(in_srgb,var(--accent)_40%,transparent)] transition-all">
                    {editing === p.id ? (
                      <ProviderForm form={form} setForm={setForm} onTypeChange={handleTypeChange} t={t}
                        saving={providerSaving}
                        onSave={() => saveProvider(p.id)}
                        onCancel={() => { setEditing(null); resetForm(); }} />
                    ) : (
                      <div className="flex flex-wrap items-center gap-3">
                        <div className="flex-1 basis-40 min-w-0">
                          <div className="font-semibold text-sm text-[var(--text-primary)] break-words [overflow-wrap:anywhere]">{p.name}</div>
                          <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">{p.baseUrl}</div>
                          <div className="text-xs text-[var(--text-muted)] mt-1 break-words [overflow-wrap:anywhere]">{t('default')}: <span className="font-mono text-[var(--text-secondary)]">{p.defaultModel || t('none')}</span></div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => toggleProvider(p.id)}
                            disabled={providerSaving}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer ${
                              p.enabled ? 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30' : 'bg-[var(--bg-1)] text-[var(--text-muted)] border-[var(--border)]'
                            }`}>
                            {p.enabled ? t('enabled') : t('disabled')}
                          </button>
                          <button disabled={providerSaving} title={t('edit')} aria-label={`${t('edit')} ${p.name}`} onClick={() => { setShowAdd(false); setForm({ name: p.name, type: p.type, baseUrl: p.baseUrl, apiKey: '', defaultModel: p.defaultModel, timeout: p.timeout }); setEditing(p.id); }}
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-1)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"><FiEdit3 size={14} /></button>
                          <button disabled={providerSaving} title={t('delete')} aria-label={`${t('delete')} ${p.name}`} onClick={() => deleteProvider(p.id)}
                            className="p-1.5 rounded-lg hover:bg-red-500/15 text-[var(--error)] transition-colors cursor-pointer"><FiTrash2 size={14} /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {showAdd ? (
                  <div className="bg-[var(--bg-2)] border border-[var(--accent)] rounded-2xl p-4 shadow-md">
                    <ProviderForm form={form} setForm={setForm} onTypeChange={handleTypeChange} t={t}
                      saving={providerSaving}
                      onSave={() => saveProvider()} onCancel={() => { setShowAdd(false); resetForm(); }} />
                  </div>
                ) : (
                  <button disabled={providerSaving} onClick={() => { setEditing(null); resetForm(); setShowAdd(true); }}
                    className="w-full p-4 rounded-2xl border border-dashed border-[var(--border)] bg-[color-mix(in_srgb,var(--bg-2)_60%,transparent)] hover:bg-[var(--bg-2)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all flex items-center justify-center gap-2 text-sm font-medium cursor-pointer shadow-2xs">
                    <FiPlus size={14} /> {t('addProvider')}
                  </button>
                )}
              </>
            )}

            {section === 'skills' && (
              <SkillsPanel t={t} />
            )}

            {section === 'plugins' && (
              <SettingsPlugins t={t} />
            )}

            {section === 'memory' && (
              <MemoryPanel t={t} />
            )}

            {section === 'mcp' && (
              <McpSettings t={t} />
            )}
            {section === 'updates' && (
              <UpdateSettingsPanel />
            )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}


function ProviderForm({ form, setForm, onTypeChange, onSave, onCancel, saving, t }: {
  form: ProviderDraft; setForm: Dispatch<SetStateAction<ProviderDraft>>; onTypeChange: (t: ProviderType) => void;
  onSave: () => Promise<void>; onCancel: () => void; saving: boolean; t: (key: string) => string;
}) {
  const [detecting, setDetecting] = useState(false);
  const [detectErr, setDetectErr] = useState('');
  const [models, setModels] = useState<any[]>([]);
  const [saveError, setSaveError] = useState('');
  const requestRef = useRef(0);
  const detectingRef = useRef(false);
  const latestForm = useRef(form);
  latestForm.current = form;
  const modelsId = useId();

  useEffect(() => {
    requestRef.current += 1;
    detectingRef.current = false;
    setDetecting(false);
    setModels([]);
    setDetectErr('');
    return () => { requestRef.current += 1; };
  }, [form.type, form.baseUrl, form.apiKey, form.timeout]);

  const fmtCtx = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n || '?'));

  const detect = async () => {
    if (detectingRef.current || saving || !form.baseUrl.trim()) return;
    const request = ++requestRef.current;
    const source = form;
    detectingRef.current = true;
    setDetecting(true);
    setDetectErr('');
    try {
      const res = await (window as any).electronAPI.model.probe({
        type: form.type, baseUrl: form.baseUrl, apiKey: form.apiKey, name: form.name, timeout: form.timeout,
      });
      const current = latestForm.current;
      if (request !== requestRef.current || current.type !== source.type || current.baseUrl !== source.baseUrl || current.apiKey !== source.apiKey || current.timeout !== source.timeout) return;
      if (res?.ok) {
        const list: any[] = res.models || [];
        setModels(list);
        if (list.length) setForm((draft) => draft.defaultModel ? draft : { ...draft, defaultModel: list[0].id });
        if (!list.length) setDetectErr(t('detectFailed'));
      } else {
        setDetectErr(res?.error || t('detectFailed'));
      }
    } catch (e: any) {
      if (request === requestRef.current) setDetectErr(e?.message || t('detectFailed'));
    } finally {
      if (request === requestRef.current) {
        detectingRef.current = false;
        setDetecting(false);
      }
    }
  };

  return (
    <form onSubmit={(event) => {
      event.preventDefault();
      if (saving) return;
      setSaveError('');
      void onSave().catch((error) => setSaveError(error instanceof Error ? error.message : String(error)));
    }}>
      <fieldset disabled={saving} className="min-w-0 space-y-3">
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          required aria-label={t('providerName')}
          placeholder={t('providerName')} className="min-w-0 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs" />
        <select value={form.type} onChange={(e) => { onTypeChange(e.target.value as ProviderType); setModels([]); setDetectErr(''); }}
          aria-label={t('providerType')}
          className="min-w-0 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs">
          {PROVIDER_TYPES.map((type) => (
            <option key={type.value} value={type.value} className="bg-[var(--bg-2)] text-[var(--text-primary)]">
              {type.labelKey === 'custom' ? t('custom') : type.labelKey}
            </option>
          ))}
        </select>
      </div>
      <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        required type="url" pattern="https?://.*" aria-label={t('baseUrl')}
        placeholder={t('baseUrl')} className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs" />
      <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} type="password"
        autoComplete="off" aria-label={t('apiKey')}
        placeholder={t('apiKey')} className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs" />
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        {/* Free-text model name — type any name manually, or pick a detected one
            (with its API context window) from the autocomplete suggestions. */}
        <input value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
          list={models.length > 0 ? modelsId : undefined} placeholder={t('defaultModel')}
          aria-label={t('defaultModel')}
          className="min-w-0 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs" />
        <input value={form.timeout} onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })} type="number"
          required min={1} step={1} aria-label={t('timeout')}
          placeholder={t('timeout')} className="min-w-0 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[color-mix(in_srgb,var(--accent)_20%,transparent)] transition-all shadow-2xs" />
      </div>
      {models.length > 0 && (
        <datalist id={modelsId}>
          {models.map((m) => (
            <option key={m.id} value={m.id}>{(m.name || m.id)} · {t('context')} {fmtCtx(m.contextWindow)}</option>
          ))}
        </datalist>
      )}
      {/* Auto-detect available models (and their API-reported context windows). */}
      <div className="flex flex-wrap items-center gap-2 min-h-[24px]">
        <button type="button" onClick={detect} disabled={detecting || !form.baseUrl}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-[var(--bg-1)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[color-mix(in_srgb,var(--accent)_50%,transparent)] hover:text-[var(--text-primary)] transition-all disabled:opacity-50 shrink-0 cursor-pointer shadow-2xs">
          <FiRefreshCw size={12} className={detecting ? 'animate-spin' : ''} /> {detecting ? t('detecting') : t('detectModels')}
        </button>
        {models.length > 0 && !detectErr && (
          <span className="text-xs text-[var(--success)]">✓ {models.length} {t('modelsFound')}</span>
        )}
        {detectErr && (
          <span className="text-xs text-[var(--error)] truncate" title={detectErr}>⚠ {detectErr}</span>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button type="button" onClick={onCancel} className="px-4 py-2 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all cursor-pointer">{t('cancel')}</button>
        <button type="submit" disabled={saving || !form.name.trim() || !form.baseUrl.trim()} className="px-4 py-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-sm font-medium hover:opacity-95 flex items-center gap-1.5 shadow-xs transition-all cursor-pointer disabled:opacity-50">
          {saving ? <FiRefreshCw size={14} className="animate-spin" /> : <FiCheck size={14} />} {t('save')}
        </button>
      </div>
      {saveError && <p role="alert" className="text-xs text-[var(--error)] break-words">{saveError}</p>}
      </fieldset>
    </form>
  );
}
