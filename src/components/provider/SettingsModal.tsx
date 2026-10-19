import { useState, useEffect } from 'react';
import { FiX, FiPlus, FiEdit3, FiTrash2, FiCheck, FiServer, FiAlertTriangle, FiZap, FiRefreshCw, FiShield, FiSliders, FiPackage, FiCpu, FiBell, FiBox, FiGlobe } from 'react-icons/fi';
import { useUIStore, useProviderStore, useLanguageStore, useSettingsStore, useModelStore, LOCALES } from '../../stores';
import type { ProviderConfig, ProviderType } from '../../types';
import MemoryPanel from '../memory/MemoryPanel';
import SkillsPanel from '../skills/SkillsPanel';
import SettingsPlugins from './SettingsPlugins';
import ShortcutCard from '../screenshot/ShortcutCard';
import FreeProviderCard from './FreeProviderCard';

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

  useEffect(() => {
    (window as any).electronAPI?.mcp?.getConfig?.().then((cfg: any) => {
      setText(cfg && Object.keys(cfg.mcpServers || cfg.servers || {}).length ? JSON.stringify(cfg, null, 2) : '');
    });
    (window as any).electronAPI?.mcp?.list?.().then(setTools);
  }, []);

  const save = async () => {
    setBusy(true);
    setStatus('');
    try {
      const cfg = JSON.parse(text || MCP_PLACEHOLDER);
      const res = await (window as any).electronAPI.mcp.setConfig(cfg);
      setTools(res || []);
      setStatus(`✓ ${(res || []).length} ${t('functions')}`);
    } catch (e: any) {
      setStatus('⚠ ' + (e?.message || String(e)));
    } finally {
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
            <span className="text-[10px] px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] border border-[var(--accent)]/30 font-medium">
              {tools.length} {t('functions')}
            </span>
          )}
        </div>
        <button onClick={save} disabled={busy}
          className="shrink-0 inline-flex items-center gap-1.5 px-3.5 py-1.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-xs font-medium hover:opacity-95 disabled:opacity-50 shadow-2xs cursor-pointer">
          <FiRefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {t('save')}
        </button>
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={MCP_PLACEHOLDER}
        spellCheck={false}
        rows={8}
        className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl p-3 text-xs font-mono text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 resize-y shadow-2xs leading-relaxed"
      />
      {status && (
        <div className="text-xs text-[var(--text-muted)]">
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

export default function SettingsModal() {
  const toggleSettings = useUIStore((s) => s.toggleSettings);
  const providers = useProviderStore((s) => s.providers);
  const addProvider = useProviderStore((s) => s.addProvider);
  const updateProvider = useProviderStore((s) => s.updateProvider);
  const deleteProvider = useProviderStore((s) => s.deleteProvider);
  const toggleProvider = useProviderStore((s) => s.toggleProvider);
  const approvalMode = useSettingsStore((s) => s.approvalMode);
  const toolCallMode = useSettingsStore((s) => s.toolCallMode);
  const fullContext = useSettingsStore((s) => s.fullContext);
  const costLock = useSettingsStore((s) => s.costLock);
  const maxEpisodeCost = useSettingsStore((s) => s.maxEpisodeCost);
  const notificationMode = useSettingsStore((s) => s.notificationMode);
  const notifyApprovals = useSettingsStore((s) => s.notifyApprovals);
  const preventSleepWhileRunning = useSettingsStore((s) => s.preventSleepWhileRunning);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { locale, setLocale, t } = useLanguageStore();

  const APPROVAL_MODES = [
    { value: 'suggest', label: 'approvalSuggest', desc: 'approvalSuggestDesc' },
    { value: 'autoEdit', label: 'approvalAutoEdit', desc: 'approvalAutoEditDesc' },
    { value: 'fullAuto', label: 'approvalFullAuto', desc: 'approvalFullAutoDesc' },
  ] as const;

  const TOOL_CALL_MODES = [
    { value: 'auto', label: 'toolModeAuto', desc: 'toolModeAutoDesc' },
    { value: 'native', label: 'toolModeNative', desc: 'toolModeNativeDesc' },
    { value: 'prompt', label: 'toolModePrompt', desc: 'toolModePromptDesc' },
  ] as const;

  const sandboxMode = useSettingsStore((s) => s.sandboxMode);
  const sandboxAllowNetwork = useSettingsStore((s) => s.sandboxAllowNetwork);
  // Seatbelt is macOS-only; elsewhere the switch would be a lie.
  const sandboxSupported = typeof navigator !== 'undefined' && /Mac/.test(navigator.platform || '');

  const selectedModel = useModelStore((s) => s.getSelectedModel)();
  const nativeActive =
    toolCallMode === 'native' || (toolCallMode === 'auto' && !!selectedModel?.supportsFunctionCalling);

  const [editing, setEditing] = useState<string | null>(null);
  const [showAdd, setShowAdd] = useState(false);
  const [form, setForm] = useState({ name: '', type: 'openai' as ProviderType, baseUrl: '', apiKey: '', defaultModel: '', timeout: 60000 });

  const resetForm = () => setForm({ name: '', type: 'openai', baseUrl: '', apiKey: '', defaultModel: '', timeout: 60000 });

  const handleTypeChange = (type: ProviderType) => {
    const preset = PROVIDER_TYPES.find((p) => p.value === type);
    setForm((f) => ({ ...f, type, baseUrl: preset?.baseUrl || f.baseUrl }));
  };

  const handleAdd = async () => {
    await addProvider({ ...form, enabled: true });
    resetForm();
    setShowAdd(false);
  };

  const getTypeLabel = (type: ProviderType) => {
    const preset = PROVIDER_TYPES.find((p) => p.value === type);
    return preset?.labelKey === 'custom' ? t('custom') : preset?.labelKey || type;
  };

  // Claude-style: a left rail of sections, one pane of content on the right —
  // the old single column meant scrolling past MCP to reach a provider key.
  const SECTIONS = [
    { id: 'general', label: 'setGeneral', desc: 'setGeneralDesc', icon: <FiSliders size={14} /> },
    { id: 'providers', label: 'setProviders', desc: 'setProvidersDesc', icon: <FiServer size={14} /> },
    { id: 'skills', label: 'skills', desc: 'skillsHint', icon: <FiPackage size={14} /> },
    { id: 'plugins', label: 'plugins', desc: 'pluginsDesc', icon: <FiBox size={14} /> },
    { id: 'memory', label: 'memory', desc: 'memoryHint', icon: <FiCpu size={14} /> },
    { id: 'mcp', label: 'mcpServers', desc: 'setMcpDesc', icon: <FiZap size={14} /> },
  ] as const;
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('general');
  const currentSec = SECTIONS.find((s) => s.id === section) || SECTIONS[0];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') toggleSettings();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [toggleSettings]);

  return (
    <div
      onClick={(e) => { if (e.target === e.currentTarget) toggleSettings(); }}
      className="fixed inset-0 bg-black/45 backdrop-blur-sm flex items-center justify-center z-50 p-4 anim-scrim"
    >
      <div className="w-[860px] max-w-[calc(100vw-32px)] h-[620px] max-h-[85vh] bg-[var(--bg-0)] border border-[var(--border)] rounded-2xl shadow-2xl flex overflow-hidden anim-modal ring-1 ring-black/5 dark:ring-white/10">

        {/* ---- Left rail ---- */}
        <div className="w-[200px] shrink-0 bg-[var(--bg-1)] border-r border-[var(--border)] flex flex-col">
          <div className="h-14 px-4 flex items-center gap-2.5 border-b border-[var(--border)]/60 shrink-0">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)] shadow-2xs border border-[var(--accent)]/20">
              <FiSliders size={14} />
            </div>
            <h2 className="text-[15.5px] font-bold text-[var(--text-primary)] font-serif tracking-tight">{t('settings')}</h2>
          </div>
          <nav className="flex-1 px-2.5 py-3 space-y-1 overflow-y-auto">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                onClick={() => setSection(sec.id)}
                className={`w-full flex items-center gap-2.5 px-3 py-2 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                  section === sec.id
                    ? 'bg-[var(--bg-2)] text-[var(--text-primary)] shadow-xs border border-[var(--border)]/80 font-semibold'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-2)]/60 hover:text-[var(--text-primary)] border border-transparent'
                }`}
              >
                <span className={section === sec.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>{sec.icon}</span>
                {t(sec.label)}
              </button>
            ))}
          </nav>
        </div>

        {/* ---- Right pane ---- */}
        <div className="flex-1 min-w-0 flex flex-col bg-[var(--bg-0)]">
          {/* Unified Top Header Bar matching left rail h-14 */}
          <div className="h-14 px-6 flex items-center justify-between border-b border-[var(--border)]/60 shrink-0 bg-[var(--bg-0)]">
            <div className="flex items-center gap-3 min-w-0">
              <h3 className="text-[16px] font-bold text-[var(--text-primary)] font-serif tracking-tight shrink-0">{t(currentSec.label)}</h3>
              <span className="text-xs text-[var(--text-muted)] truncate hidden md:inline">{t(currentSec.desc)}</span>
            </div>
            <button
              onClick={toggleSettings}
              title={t('close')}
              className="w-7 h-7 rounded-lg flex items-center justify-center text-[var(--text-muted)] hover:bg-[var(--bg-2)] hover:text-[var(--text-primary)] transition-all cursor-pointer shrink-0"
            >
              <FiX size={15} />
            </button>
          </div>

          {/* Scrollable Content Pane */}
          <div className="flex-1 min-w-0 overflow-y-auto p-6 space-y-4">
            {section === 'general' && (
              <>
                {/* Group 0: 界面语言 */}
                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-2xs p-4">
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-2">
                        <FiGlobe size={14} className="text-[var(--accent)] shrink-0" />
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('languageTitle')}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed">
                        {t('languageDesc')}
                      </p>
                    </div>
                    <div className="inline-flex p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5 shrink-0">
                      {LOCALES.map((l) => (
                        <button
                          key={l.value}
                          type="button"
                          onClick={() => {
                            setLocale(l.value);
                            updateSettings({ language: l.value });
                          }}
                          className={`min-w-[76px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            locale === l.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[var(--border)]/70 font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]/40 border border-transparent'
                          }`}
                        >
                          {l.label}
                        </button>
                      ))}
                    </div>
                  </div>
                </div>

                {/* Group 1: 运行与安全策略 */}
                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-2xs divide-y divide-[var(--border)] overflow-hidden">
                  {/* Approval Mode */}
                  <div className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="font-semibold text-sm text-[var(--text-primary)]">{t('approvalMode')}</div>
                      <p className={`mt-0.5 text-xs flex items-center gap-1.5 leading-relaxed ${approvalMode === 'fullAuto' ? 'text-red-500 font-medium' : 'text-[var(--text-muted)]'}`}>
                        {approvalMode === 'fullAuto' && <FiAlertTriangle size={13} className="shrink-0" />}
                        <span>{t(APPROVAL_MODES.find((m) => m.value === approvalMode)!.desc)}</span>
                      </p>
                    </div>
                    <div className="inline-flex p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5 shrink-0">
                      {APPROVAL_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => updateSettings({ approvalMode: m.value })}
                          className={`min-w-[76px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            approvalMode === m.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[var(--border)]/70 font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]/40 border border-transparent'
                          }`}
                        >
                          {t(m.label)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Command Sandbox */}
                  <div className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-2">
                        <FiShield size={14} className={sandboxMode === 'workspaceWrite' && sandboxSupported ? 'text-[var(--success)]' : 'text-[var(--warning)]'} />
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('sandbox')}</span>
                      </div>
                      <p className={`mt-0.5 text-xs flex items-center gap-1.5 leading-relaxed ${sandboxMode === 'off' ? 'text-red-500 font-medium' : 'text-[var(--text-muted)]'}`}>
                        {sandboxMode === 'off' && <FiAlertTriangle size={13} className="shrink-0" />}
                        <span>{t(sandboxMode === 'off' ? 'sandboxOffDesc' : 'sandboxOnDesc')}</span>
                      </p>
                      {sandboxMode === 'workspaceWrite' && (
                        <label className="mt-1.5 inline-flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                          <input type="checkbox" checked={sandboxAllowNetwork}
                            onChange={(e) => updateSettings({ sandboxAllowNetwork: e.target.checked })}
                            className="accent-[var(--accent)] rounded" />
                          {t('sandboxNetwork')}
                        </label>
                      )}
                    </div>
                    {sandboxSupported && (
                      <div className="inline-flex p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5 shrink-0">
                        {([{ value: 'workspaceWrite', label: 'sandboxOn' }, { value: 'off', label: 'sandboxOff' }] as const).map((m) => (
                          <button
                            key={m.value}
                            type="button"
                            onClick={() => updateSettings({ sandboxMode: m.value })}
                            className={`min-w-[88px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                              sandboxMode === m.value
                                ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[var(--border)]/70 font-semibold'
                                : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]/40 border border-transparent'
                            }`}
                          >
                            {t(m.label)}
                          </button>
                        ))}
                      </div>
                    )}
                  </div>
                </div>

                {/* Group 2: 模型与推理控制 */}
                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl shadow-2xs divide-y divide-[var(--border)] overflow-hidden">
                  {/* Tool Calls */}
                  <div className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="font-semibold text-sm text-[var(--text-primary)]">{t('toolCallMode')}</div>
                      <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed">
                        {t(TOOL_CALL_MODES.find((m) => m.value === toolCallMode)!.desc)}
                      </p>
                      {selectedModel && (
                        <p className="mt-1 text-xs flex items-center gap-1.5">
                          <span className="text-[var(--text-muted)]">{selectedModel.name}:</span>
                          <span className={nativeActive ? 'text-[var(--success)] font-medium' : 'text-[var(--warning)] font-medium'}>
                            {nativeActive ? t('toolModeNative') : t('toolModePrompt')}
                          </span>
                        </p>
                      )}
                    </div>
                    <div className="inline-flex p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5 shrink-0">
                      {TOOL_CALL_MODES.map((m) => (
                        <button
                          key={m.value}
                          type="button"
                          onClick={() => updateSettings({ toolCallMode: m.value })}
                          className={`min-w-[76px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            toolCallMode === m.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[var(--border)]/70 font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]/40 border border-transparent'
                          }`}
                        >
                          {t(m.label)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* Context Budget */}
                  <div className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="font-semibold text-sm text-[var(--text-primary)]">{t('contextTitle')}</div>
                      <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed">
                        {t(fullContext ? 'contextFullDesc' : 'contextCappedDesc')}
                      </p>
                    </div>
                    <div className="inline-flex p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5 shrink-0">
                      {([{ value: false, label: 'contextCapped' }, { value: true, label: 'contextFull' }] as const).map((m) => (
                        <button
                          key={m.label}
                          type="button"
                          onClick={() => updateSettings({ fullContext: m.value })}
                          className={`min-w-[95px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            fullContext === m.value
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[var(--border)]/70 font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]/40 border border-transparent'
                          }`}
                        >
                          {t(m.label)}
                        </button>
                      ))}
                    </div>
                  </div>

                  {/* RSI Cost Lock */}
                  <div className="p-4 flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-2">
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('costTitle')}</span>
                        <label className="flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
                          <input type="checkbox" checked={costLock}
                            onChange={(e) => updateSettings({ costLock: e.target.checked })}
                            className="accent-[var(--accent)] rounded" />
                          <span className="font-medium text-[var(--text-secondary)]">{t('costLock')}</span>
                        </label>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed">{t('costDesc')}</p>
                    </div>
                    <div className="flex items-center gap-2 shrink-0">
                      <span className="text-xs text-[var(--text-muted)]">{t('costBudget')}:</span>
                      <div className="flex items-center gap-1.5 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-2.5 py-1.5 focus-within:border-[var(--accent)] focus-within:ring-2 focus-within:ring-[var(--accent)]/20 transition-all shadow-2xs">
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
                  <div className="flex items-center justify-between gap-4">
                    <div className="flex-1 min-w-0 pr-4">
                      <div className="flex items-center gap-2">
                        <FiBell size={14} className="text-[var(--accent)]" />
                        <span className="font-semibold text-sm text-[var(--text-primary)]">{t('notifications')}</span>
                      </div>
                      <p className="mt-0.5 text-xs text-[var(--text-muted)] leading-relaxed">{t('notificationsDesc')}</p>
                    </div>
                    <div className="inline-flex p-1 bg-[var(--bg-1)] border border-[var(--border)] rounded-xl gap-0.5 shrink-0">
                      {(['never', 'background', 'always'] as const).map((mode) => (
                        <button
                          key={mode}
                          type="button"
                          onClick={() => updateSettings({ notificationMode: mode })}
                          className={`min-w-[76px] px-3.5 py-1.5 rounded-lg text-xs font-medium text-center transition-all cursor-pointer ${
                            notificationMode === mode
                              ? 'bg-[var(--bg-2)] text-[var(--accent)] shadow-xs border border-[var(--border)]/70 font-semibold'
                              : 'text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-2)]/40 border border-transparent'
                          }`}
                        >
                          {t(`notification_${mode}`)}
                        </button>
                      ))}
                    </div>
                  </div>
                  <div className="mt-3 pt-3 border-t border-[var(--border)]/60 flex flex-wrap gap-x-6 gap-y-2">
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
                {providers.filter((p) => p.type !== 'conecode-free').map((p) => (
                  <div key={p.id} className="bg-[var(--bg-2)] border border-[var(--border)] rounded-2xl p-4 shadow-2xs hover:border-[var(--accent)]/40 transition-all">
                    {editing === p.id ? (
                      <ProviderForm form={form} setForm={setForm} onTypeChange={handleTypeChange} t={t}
                        onSave={async () => { await updateProvider(p.id, form); setEditing(null); resetForm(); }}
                        onCancel={() => { setEditing(null); resetForm(); }} />
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-semibold text-sm text-[var(--text-primary)]">{p.name}</div>
                          <div className="text-xs text-[var(--text-muted)] truncate mt-0.5">{p.baseUrl}</div>
                          <div className="text-xs text-[var(--text-muted)] mt-1">{t('default')}: <span className="font-mono text-[var(--text-secondary)]">{p.defaultModel || t('none')}</span></div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => toggleProvider(p.id)}
                            className={`px-2.5 py-1 rounded-full text-xs font-medium border transition-all cursor-pointer ${
                              p.enabled ? 'bg-green-500/15 text-green-600 dark:text-green-400 border-green-500/30' : 'bg-[var(--bg-1)] text-[var(--text-muted)] border-[var(--border)]'
                            }`}>
                            {p.enabled ? t('enabled') : t('disabled')}
                          </button>
                          <button onClick={() => { setForm({ name: p.name, type: p.type, baseUrl: p.baseUrl, apiKey: '', defaultModel: p.defaultModel, timeout: p.timeout }); setEditing(p.id); }}
                            className="p-1.5 rounded-lg hover:bg-[var(--bg-1)] text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"><FiEdit3 size={14} /></button>
                          <button onClick={() => deleteProvider(p.id)}
                            className="p-1.5 rounded-lg hover:bg-red-500/15 text-[var(--error)] transition-colors cursor-pointer"><FiTrash2 size={14} /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {showAdd ? (
                  <div className="bg-[var(--bg-2)] border border-[var(--accent)] rounded-2xl p-4 shadow-md">
                    <ProviderForm form={form} setForm={setForm} onTypeChange={handleTypeChange} t={t}
                      onSave={handleAdd} onCancel={() => { setShowAdd(false); resetForm(); }} />
                  </div>
                ) : (
                  <button onClick={() => setShowAdd(true)}
                    className="w-full p-4 rounded-2xl border border-dashed border-[var(--border)] bg-[var(--bg-2)]/60 hover:bg-[var(--bg-2)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-all flex items-center justify-center gap-2 text-sm font-medium cursor-pointer shadow-2xs">
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
          </div>
        </div>
      </div>
    </div>
  );
}


function ProviderForm({ form, setForm, onTypeChange, onSave, onCancel, t }: {
  form: any; setForm: (f: any) => void; onTypeChange: (t: ProviderType) => void;
  onSave: () => void; onCancel: () => void; t: (key: string) => string;
}) {
  const [detecting, setDetecting] = useState(false);
  const [detectErr, setDetectErr] = useState('');
  const [models, setModels] = useState<any[]>([]);

  const fmtCtx = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}K` : String(n || '?'));

  const detect = async () => {
    setDetecting(true);
    setDetectErr('');
    try {
      const res = await (window as any).electronAPI.model.probe({
        type: form.type, baseUrl: form.baseUrl, apiKey: form.apiKey, name: form.name, timeout: form.timeout,
      });
      if (res?.ok) {
        const list: any[] = res.models || [];
        setModels(list);
        if (list.length && !form.defaultModel) setForm({ ...form, defaultModel: list[0].id });
        if (!list.length) setDetectErr(t('detectFailed'));
      } else {
        setDetectErr(res?.error || t('detectFailed'));
      }
    } catch (e: any) {
      setDetectErr(e?.message || t('detectFailed'));
    } finally {
      setDetecting(false);
    }
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3">
        <input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })}
          placeholder={t('providerName')} className="bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs" />
        <select value={form.type} onChange={(e) => { onTypeChange(e.target.value as ProviderType); setModels([]); setDetectErr(''); }}
          className="bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs">
          {PROVIDER_TYPES.map((type) => (
            <option key={type.value} value={type.value} className="bg-[var(--bg-2)] text-[var(--text-primary)]">
              {type.labelKey === 'custom' ? t('custom') : type.labelKey}
            </option>
          ))}
        </select>
      </div>
      <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        placeholder={t('baseUrl')} className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs" />
      <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} type="password"
        placeholder={t('apiKey')} className="w-full bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs" />
      <div className="grid grid-cols-2 gap-3">
        {/* Free-text model name — type any name manually, or pick a detected one
            (with its API context window) from the autocomplete suggestions. */}
        <input value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
          list={models.length > 0 ? 'cc-detected-models' : undefined} placeholder={t('defaultModel')}
          className="bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs" />
        <input value={form.timeout} onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })} type="number"
          placeholder={t('timeout')} className="bg-[var(--bg-1)] border border-[var(--border)] rounded-xl px-3 py-2 text-sm text-[var(--text-primary)] placeholder-[var(--text-muted)] outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent)]/20 transition-all shadow-2xs" />
      </div>
      {models.length > 0 && (
        <datalist id="cc-detected-models">
          {models.map((m) => (
            <option key={m.id} value={m.id}>{(m.name || m.id)} · {t('context')} {fmtCtx(m.contextWindow)}</option>
          ))}
        </datalist>
      )}
      {/* Auto-detect available models (and their API-reported context windows). */}
      <div className="flex items-center gap-2 min-h-[24px]">
        <button type="button" onClick={detect} disabled={detecting || !form.baseUrl}
          className="flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs bg-[var(--bg-1)] border border-[var(--border)] text-[var(--text-secondary)] hover:border-[var(--accent)]/50 hover:text-[var(--text-primary)] transition-all disabled:opacity-50 shrink-0 cursor-pointer shadow-2xs">
          <FiRefreshCw size={12} className={detecting ? 'animate-spin' : ''} /> {detecting ? t('detecting') : t('detectModels')}
        </button>
        {models.length > 0 && !detectErr ? (
          <span className="text-xs text-[var(--success)]">✓ {models.length} {t('modelsFound')}</span>
        ) : detectErr ? (
          <span className="text-xs text-[var(--error)] truncate" title={detectErr}>⚠ {detectErr}</span>
        ) : (
          <span className="text-[11px] text-[var(--text-muted)] truncate">{t('detectHint')}</span>
        )}
      </div>
      <div className="flex justify-end gap-2 pt-1">
        <button onClick={onCancel} className="px-4 py-2 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-sm text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-all cursor-pointer">{t('cancel')}</button>
        <button onClick={onSave} className="px-4 py-2 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white text-sm font-medium hover:opacity-95 flex items-center gap-1.5 shadow-xs transition-all cursor-pointer">
          <FiCheck size={14} /> {t('save')}
        </button>
      </div>
    </div>
  );
}
