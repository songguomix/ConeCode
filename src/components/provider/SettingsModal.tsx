import { useState, useEffect } from 'react';
import { FiX, FiPlus, FiEdit3, FiTrash2, FiCheck, FiServer, FiAlertTriangle, FiZap, FiRefreshCw, FiShield, FiSliders, FiPackage, FiCpu, FiBell, FiBox } from 'react-icons/fi';
import { useUIStore, useProviderStore, useLanguageStore, useSettingsStore, useModelStore } from '../../stores';
import type { ProviderConfig, ProviderType } from '../../types';
import MemoryPanel from '../memory/MemoryPanel';
import SkillsPanel from '../skills/SkillsPanel';
import SettingsPlugins from './SettingsPlugins';
import ShortcutCard from '../screenshot/ShortcutCard';

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
    <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
      <div className="flex items-center gap-2 mb-2">
        <FiZap size={14} className="text-[var(--accent)]" />
        <span className="font-medium text-sm">{t('mcpServers')}</span>
        {tools.length > 0 && (
          <span className="text-[10px] px-1.5 py-0.5 rounded bg-[var(--accent-soft)] text-[var(--accent)]">{tools.length}</span>
        )}
      </div>
      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder={MCP_PLACEHOLDER}
        spellCheck={false}
        rows={6}
        className="w-full bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-xs font-mono outline-none focus:border-[var(--accent)] resize-y"
      />
      <div className="flex items-center justify-between mt-2 gap-2">
        <span className="text-xs text-[var(--text-muted)] truncate">
          {status || (tools.length ? tools.map((x) => `${x.server}:${x.name}`).slice(0, 4).join(', ') : '')}
        </span>
        <button onClick={save} disabled={busy}
          className="shrink-0 inline-flex items-center gap-1 px-3 py-1.5 rounded-lg bg-[var(--accent)] text-white text-xs hover:bg-[var(--accent-hover)] disabled:opacity-50">
          <FiRefreshCw size={12} className={busy ? 'animate-spin' : ''} /> {t('save')}
        </button>
      </div>
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
  const notificationMode = useSettingsStore((s) => s.notificationMode);
  const notifyApprovals = useSettingsStore((s) => s.notifyApprovals);
  const preventSleepWhileRunning = useSettingsStore((s) => s.preventSleepWhileRunning);
  const updateSettings = useSettingsStore((s) => s.updateSettings);
  const { t } = useLanguageStore();

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
    { id: 'general', label: 'setGeneral', icon: <FiSliders size={14} /> },
    { id: 'providers', label: 'setProviders', icon: <FiServer size={14} /> },
    { id: 'skills', label: 'skills', icon: <FiPackage size={14} /> },
    { id: 'plugins', label: 'plugins', icon: <FiBox size={14} /> },
    { id: 'memory', label: 'memory', icon: <FiCpu size={14} /> },
    { id: 'mcp', label: 'mcpServers', icon: <FiZap size={14} /> },
  ] as const;
  const [section, setSection] = useState<(typeof SECTIONS)[number]['id']>('general');

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 anim-scrim">
      <div className="w-[880px] h-[78vh] bg-[var(--bg-0)] border border-[var(--border)] rounded-2xl shadow-2xl flex overflow-hidden anim-modal">

        {/* ---- Left rail ---- */}
        <div className="w-[200px] shrink-0 bg-[var(--bg-1)] border-r border-[var(--border)] flex flex-col">
          <div className="px-4 py-4 flex items-center gap-2">
            <div className="w-7 h-7 rounded-lg bg-[var(--accent-soft)] flex items-center justify-center text-[var(--accent)]">
              <FiServer size={14} />
            </div>
            <h2 className="text-sm font-semibold">{t('settings')}</h2>
          </div>
          <nav className="flex-1 px-2 space-y-0.5">
            {SECTIONS.map((sec) => (
              <button
                key={sec.id}
                onClick={() => setSection(sec.id)}
                className={`w-full flex items-center gap-2.5 px-2.5 py-2 rounded-lg text-xs font-medium transition-colors ${
                  section === sec.id
                    ? 'bg-[var(--bg-3)] text-[var(--text-primary)]'
                    : 'text-[var(--text-secondary)] hover:bg-[var(--bg-3)]/60 hover:text-[var(--text-primary)]'
                }`}
              >
                <span className={section === sec.id ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}>{sec.icon}</span>
                {t(sec.label)}
              </button>
            ))}
          </nav>
          <div className="p-2">
            <button onClick={toggleSettings}
              className="w-full flex items-center gap-2 px-2.5 py-2 rounded-lg text-xs text-[var(--text-muted)] hover:bg-[var(--bg-3)] hover:text-[var(--text-primary)] transition-colors">
              <FiX size={14} /> {t('close')}
            </button>
          </div>
        </div>

        {/* ---- Right pane ---- */}
        <div className="flex-1 min-w-0 overflow-y-auto">
          <div className="p-5 space-y-3">
            {section === 'general' && (
              <>
                <SectionHeading title={t('setGeneral')} desc={t('setGeneralDesc')} />

                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
                  <div className="font-medium text-sm mb-2">{t('approvalMode')}</div>
                  <div className="grid grid-cols-3 gap-2">
                    {APPROVAL_MODES.map((m) => (
                      <button key={m.value} onClick={() => updateSettings({ approvalMode: m.value })}
                        className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          approvalMode === m.value
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]'
                            : 'bg-[var(--bg-3)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)]'
                        }`}>
                        {t(m.label)}
                      </button>
                    ))}
                  </div>
                  <p className={`mt-2 text-xs flex items-start gap-1.5 ${approvalMode === 'fullAuto' ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>
                    {approvalMode === 'fullAuto' && <FiAlertTriangle size={13} className="mt-0.5 shrink-0" />}
                    <span>{t(APPROVAL_MODES.find((m) => m.value === approvalMode)!.desc)}</span>
                  </p>
                </div>

                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <FiShield size={14} className={sandboxMode === 'workspaceWrite' && sandboxSupported ? 'text-[var(--success)]' : 'text-[var(--warning)]'} />
                    <span className="font-medium text-sm">{t('sandbox')}</span>
                  </div>
                  {sandboxSupported ? (
                    <>
                      <div className="grid grid-cols-2 gap-2">
                        {([{ value: 'workspaceWrite', label: 'sandboxOn' }, { value: 'off', label: 'sandboxOff' }] as const).map((m) => (
                          <button key={m.value} onClick={() => updateSettings({ sandboxMode: m.value })}
                            className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                              sandboxMode === m.value
                                ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]'
                                : 'bg-[var(--bg-3)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)]'
                            }`}>
                            {t(m.label)}
                          </button>
                        ))}
                      </div>
                      <p className={`mt-2 text-xs flex items-start gap-1.5 ${sandboxMode === 'off' ? 'text-red-500' : 'text-[var(--text-muted)]'}`}>
                        {sandboxMode === 'off' && <FiAlertTriangle size={13} className="mt-0.5 shrink-0" />}
                        <span>{t(sandboxMode === 'off' ? 'sandboxOffDesc' : 'sandboxOnDesc')}</span>
                      </p>
                      {sandboxMode === 'workspaceWrite' && (
                        <label className="mt-2 flex items-center gap-1.5 text-xs text-[var(--text-secondary)] cursor-pointer">
                          <input type="checkbox" checked={sandboxAllowNetwork}
                            onChange={(e) => updateSettings({ sandboxAllowNetwork: e.target.checked })}
                            className="accent-[var(--accent)]" />
                          {t('sandboxNetwork')}
                        </label>
                      )}
                    </>
                  ) : (
                    <p className="text-xs text-[var(--text-muted)]">{t('sandboxUnavailable')}</p>
                  )}
                </div>

                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
                  <div className="font-medium text-sm mb-2">{t('toolCallMode')}</div>
                  <div className="grid grid-cols-3 gap-2">
                    {TOOL_CALL_MODES.map((m) => (
                      <button key={m.value} onClick={() => updateSettings({ toolCallMode: m.value })}
                        className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          toolCallMode === m.value
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]'
                            : 'bg-[var(--bg-3)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)]'
                        }`}>
                        {t(m.label)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">
                    {t(TOOL_CALL_MODES.find((m) => m.value === toolCallMode)!.desc)}
                  </p>
                  {selectedModel && (
                    <p className="mt-1.5 text-xs flex items-center gap-1.5">
                      <span className="text-[var(--text-muted)]">{selectedModel.name}:</span>
                      <span className={nativeActive ? 'text-[var(--success)] font-medium' : 'text-[var(--warning)] font-medium'}>
                        {nativeActive ? t('toolModeNative') : t('toolModePrompt')}
                      </span>
                    </p>
                  )}
                </div>

                <div className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
                  <div className="flex items-center gap-2 mb-2">
                    <FiBell size={14} className="text-[var(--accent)]" />
                    <span className="font-medium text-sm">{t('notifications')}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2">
                    {(['never', 'background', 'always'] as const).map((mode) => (
                      <button key={mode} onClick={() => updateSettings({ notificationMode: mode })}
                        className={`px-2 py-1.5 rounded-lg text-xs font-medium border transition-colors ${
                          notificationMode === mode
                            ? 'bg-[var(--accent-soft)] text-[var(--accent)] border-[var(--accent)]'
                            : 'bg-[var(--bg-3)] text-[var(--text-secondary)] border-[var(--border)] hover:border-[var(--accent)]'
                        }`}>
                        {t(`notification_${mode}`)}
                      </button>
                    ))}
                  </div>
                  <p className="mt-2 text-xs text-[var(--text-muted)]">{t('notificationsDesc')}</p>
                  <div className="mt-3 space-y-2">
                    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                      <input type="checkbox" checked={notifyApprovals}
                        onChange={(event) => updateSettings({ notifyApprovals: event.target.checked })}
                        className="accent-[var(--accent)]" />
                      {t('notifyApprovals')}
                    </label>
                    <label className="flex items-center gap-2 text-xs text-[var(--text-secondary)] cursor-pointer">
                      <input type="checkbox" checked={preventSleepWhileRunning}
                        onChange={(event) => updateSettings({ preventSleepWhileRunning: event.target.checked })}
                        className="accent-[var(--accent)]" />
                      {t('preventSleepWhileRunning')}
                    </label>
                  </div>
                </div>

                <ShortcutCard t={t} />
              </>
            )}

            {section === 'providers' && (
              <>
                <SectionHeading title={t('setProviders')} desc={t('setProvidersDesc')} />
                {providers.map((p) => (
                  <div key={p.id} className="bg-[var(--bg-2)] border border-[var(--border)] rounded-xl p-4">
                    {editing === p.id ? (
                      <ProviderForm form={form} setForm={setForm} onTypeChange={handleTypeChange} t={t}
                        onSave={async () => { await updateProvider(p.id, form); setEditing(null); resetForm(); }}
                        onCancel={() => { setEditing(null); resetForm(); }} />
                    ) : (
                      <div className="flex items-center gap-3">
                        <div className="flex-1 min-w-0">
                          <div className="font-medium text-sm">{p.name}</div>
                          <div className="text-xs text-[var(--text-muted)] truncate">{p.baseUrl}</div>
                          <div className="text-xs text-[var(--text-muted)] mt-1">{t('default')}: {p.defaultModel || t('none')}</div>
                        </div>
                        <div className="flex items-center gap-2 shrink-0">
                          <button onClick={() => toggleProvider(p.id)}
                            className={`px-2 py-1 rounded text-xs ${p.enabled ? 'bg-green-500/20 text-green-400' : 'bg-[var(--bg-3)] text-[var(--text-muted)]'}`}>
                            {p.enabled ? t('enabled') : t('disabled')}
                          </button>
                          <button onClick={() => { setForm({ name: p.name, type: p.type, baseUrl: p.baseUrl, apiKey: '', defaultModel: p.defaultModel, timeout: p.timeout }); setEditing(p.id); }}
                            className="p-1.5 rounded hover:bg-[var(--bg-3)] text-[var(--text-muted)]"><FiEdit3 size={14} /></button>
                          <button onClick={() => deleteProvider(p.id)}
                            className="p-1.5 rounded hover:bg-red-500/20 text-[var(--error)]"><FiTrash2 size={14} /></button>
                        </div>
                      </div>
                    )}
                  </div>
                ))}
                {showAdd ? (
                  <div className="bg-[var(--bg-2)] border border-[var(--accent)] rounded-xl p-4">
                    <ProviderForm form={form} setForm={setForm} onTypeChange={handleTypeChange} t={t}
                      onSave={handleAdd} onCancel={() => { setShowAdd(false); resetForm(); }} />
                  </div>
                ) : (
                  <button onClick={() => setShowAdd(true)}
                    className="w-full p-4 rounded-xl border border-dashed border-[var(--border)] text-[var(--text-muted)] hover:border-[var(--accent)] hover:text-[var(--accent)] transition-colors flex items-center justify-center gap-2 text-sm">
                    <FiPlus size={14} /> {t('addProvider')}
                  </button>
                )}
              </>
            )}

            {section === 'skills' && (
              <>
                <SectionHeading title={t('skills')} desc={t('skillsHint')} />
                <SkillsPanel t={t} />
              </>
            )}

            {section === 'plugins' && (
              <SettingsPlugins t={t} />
            )}

            {section === 'memory' && (
              <>
                <SectionHeading title={t('memory')} desc={t('memoryHint')} />
                <MemoryPanel t={t} />
              </>
            )}

            {section === 'mcp' && (
              <>
                <SectionHeading title={t('mcpServers')} desc={t('setMcpDesc')} />
                <McpSettings t={t} />
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function SectionHeading({ title, desc }: { title: string; desc: string }) {
  return (
    <div className="mb-1">
      <h3 className="text-base font-semibold text-[var(--text-primary)]">{title}</h3>
      <p className="text-xs text-[var(--text-muted)] mt-0.5 leading-relaxed">{desc}</p>
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
          placeholder={t('providerName')} className="bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
        <select value={form.type} onChange={(e) => { onTypeChange(e.target.value as ProviderType); setModels([]); setDetectErr(''); }}
          className="bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none">
          {PROVIDER_TYPES.map((type) => (
            <option key={type.value} value={type.value}>
              {type.labelKey === 'custom' ? t('custom') : type.labelKey}
            </option>
          ))}
        </select>
      </div>
      <input value={form.baseUrl} onChange={(e) => setForm({ ...form, baseUrl: e.target.value })}
        placeholder={t('baseUrl')} className="w-full bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
      <input value={form.apiKey} onChange={(e) => setForm({ ...form, apiKey: e.target.value })} type="password"
        placeholder={t('apiKey')} className="w-full bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
      <div className="grid grid-cols-2 gap-3">
        {/* Free-text model name — type any name manually, or pick a detected one
            (with its API context window) from the autocomplete suggestions. */}
        <input value={form.defaultModel} onChange={(e) => setForm({ ...form, defaultModel: e.target.value })}
          list={models.length > 0 ? 'cc-detected-models' : undefined} placeholder={t('defaultModel')}
          className="bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
        <input value={form.timeout} onChange={(e) => setForm({ ...form, timeout: Number(e.target.value) })} type="number"
          placeholder={t('timeout')} className="bg-[var(--bg-3)] border border-[var(--border)] rounded-lg px-3 py-2 text-sm outline-none focus:border-[var(--accent)]" />
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
          className="flex items-center gap-1.5 px-2.5 py-1 rounded-lg text-xs bg-[var(--bg-3)] text-[var(--text-secondary)] hover:bg-[var(--bg-4)] hover:text-[var(--text-primary)] transition-colors disabled:opacity-50 shrink-0">
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
      <div className="flex justify-end gap-2">
        <button onClick={onCancel} className="px-4 py-2 rounded-lg bg-[var(--bg-3)] text-sm text-[var(--text-secondary)] hover:bg-[var(--bg-4)]">{t('cancel')}</button>
        <button onClick={onSave} className="px-4 py-2 rounded-lg bg-[var(--accent)] text-white text-sm hover:bg-[var(--accent-hover)] flex items-center gap-1">
          <FiCheck size={14} /> {t('save')}
        </button>
      </div>
    </div>
  );
}
