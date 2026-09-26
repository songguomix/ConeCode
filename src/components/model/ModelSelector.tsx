import { useState, useRef, useEffect, useMemo } from 'react';
import { FiChevronDown, FiSearch, FiStar, FiSun, FiMoon, FiRefreshCw, FiCpu, FiSliders } from 'react-icons/fi';
import { useModelStore, useProviderStore, useUIStore, useLanguageStore, useThemeStore, useChatStore } from '../../stores';
import { modelLimitKey } from '../../stores/model.store';
import ThinkingSlider from './ThinkingSlider';
import ContextMeter from './ContextMeter';
import type { AIModel } from '../../types';

const CAP_ICONS: Record<string, string> = {
  vision: '🖼️',
  imageGeneration: '🎨',
  audioInput: '🎤',
  audioOutput: '🔊',
  functionCalling: '⚙️',
};

export default function ModelSelector() {
  const [search, setSearch] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [tooltipModel, setTooltipModel] = useState<AIModel | null>(null);
  const [editingLimits, setEditingLimits] = useState<{ providerId: string; modelId: string } | null>(null);
  const [refreshingLimits, setRefreshingLimits] = useState(false);
  const [limitDraft, setLimitDraft] = useState<{ context: string; maxOutput: string }>({ context: '', maxOutput: '' });
  const searchRef = useRef<HTMLInputElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  const models = useModelStore((s) => s.models);
  const selectModel = useModelStore((s) => s.selectModel);
  const favorites = useModelStore((s) => s.favorites);
  const recentModels = useModelStore((s) => s.recentModels);
  const toggleFavorite = useModelStore((s) => s.toggleFavorite);
  const limitOverrides = useModelStore((s) => s.limitOverrides);
  const setModelLimits = useModelStore((s) => s.setModelLimits);
  const fetchModels = useModelStore((s) => s.fetchModels);
  const fetchAllModels = useModelStore((s) => s.fetchAllModels);
  const modelsLoading = useModelStore((s) => s.loading);
  const providers = useProviderStore((s) => s.providers);
  const isOpen = useUIStore((s) => s.modelSelectorOpen);
  const toggleModelSelector = useUIStore((s) => s.toggleModelSelector);
  const closeModelSelector = useUIStore((s) => s.closeModelSelector);
  const { t } = useLanguageStore();
  const { resolved, toggle: toggleTheme } = useThemeStore();
  const reasoningEffort = useChatStore((s) => s.reasoningEffort);
  const setReasoningEffort = useChatStore((s) => s.setReasoningEffort);

  const selectedModel = useModelStore((s) => s.getSelectedModel());
  const showThinking = selectedModel?.supportsReasoning || selectedModel?.userEnabledReasoning || false;

  const grouped = useMemo(() => {
    const all = Array.from(models.values()).flat();
    const q = search.toLowerCase();
    const filtered = q ? all.filter((m) => m.name.toLowerCase().includes(q) || m.id.toLowerCase().includes(q)) : all;

    const groups: { label: string; models: AIModel[] }[] = [];

    const favModels = filtered.filter((m) => favorites.includes(m.id));
    if (favModels.length) groups.push({ label: t('favorites'), models: favModels });

    const recentM = filtered.filter((m) => recentModels.includes(m.id) && !favorites.includes(m.id));
    if (recentM.length) groups.push({ label: t('recent'), models: recentM });

    // A favorite/recent model already has a prominent section. Repeating it in
    // its provider section inflated the menu and made keyboard selection jump
    // between duplicate rows that represented the same model.
    const featured = new Set([...favModels, ...recentM].map((m) => modelLimitKey(m.providerId, m.id)));

    for (const p of providers) {
      const pModels = filtered.filter((m) =>
        m.providerId === p.id && !featured.has(modelLimitKey(m.providerId, m.id)),
      );
      if (pModels.length) groups.push({ label: p.name, models: pModels });
    }

    return groups;
  }, [models, search, favorites, recentModels, providers, t]);

  const flatModels = useMemo(() => grouped.flatMap((g) => g.models), [grouped]);

  useEffect(() => {
    if (isOpen) searchRef.current?.focus();
  }, [isOpen]);

  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        closeModelSelector();
      }
    };
    if (isOpen) document.addEventListener('mousedown', handleClickOutside);
    return () => document.removeEventListener('mousedown', handleClickOutside);
  }, [isOpen]);

  const handleKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { closeModelSelector(); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setSelectedIndex((i) => Math.min(i + 1, flatModels.length - 1)); }
    if (e.key === 'ArrowUp') { e.preventDefault(); setSelectedIndex((i) => Math.max(i - 1, 0)); }
    if (e.key === 'Enter' && !(e.nativeEvent as any).isComposing && flatModels[selectedIndex]) {
      selectModel(flatModels[selectedIndex].id, flatModels[selectedIndex].providerId);
      closeModelSelector();
    }
  };

  const getCapIcons = (m: AIModel) => {
    const caps: string[] = [];
    if (m.supportsVision) caps.push('vision');
    if (m.supportsImageGeneration) caps.push('imageGeneration');
    if (m.supportsAudioInput) caps.push('audioInput');
    if (m.supportsAudioOutput) caps.push('audioOutput');
    if (m.supportsFunctionCalling) caps.push('functionCalling');
    if (m.supportsReasoning) caps.push('reasoning');
    return caps;
  };

  const formatLimit = (value: number) => {
    if (value >= 1_000_000) return `${(value / 1_000_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}M`;
    if (value >= 1_000) return `${(value / 1_000).toLocaleString(undefined, { maximumFractionDigits: 1 })}K`;
    return value.toLocaleString();
  };

  const openLimitEditor = (model: AIModel) => {
    if (editingLimits?.providerId === model.providerId && editingLimits.modelId === model.id) {
      setEditingLimits(null);
      return;
    }
    setEditingLimits({ providerId: model.providerId, modelId: model.id });
    setLimitDraft({ context: String(model.contextWindow ?? ''), maxOutput: String(model.maxOutputTokens ?? '') });
  };

  const saveLimits = () => {
    if (!editingLimits) return;
    const ctx = parseInt(limitDraft.context, 10);
    const out = parseInt(limitDraft.maxOutput, 10);
    setModelLimits(editingLimits.providerId, editingLimits.modelId, {
      contextWindow: Number.isFinite(ctx) && ctx > 0 ? ctx : null,
      maxOutputTokens: Number.isFinite(out) && out > 0 ? out : null,
    });
    setEditingLimits(null);
  };

  const resetLimits = () => {
    if (!editingLimits) return;
    setModelLimits(editingLimits.providerId, editingLimits.modelId, { contextWindow: null, maxOutputTokens: null });
    setEditingLimits(null);
  };

  const readLimitsFromApi = async () => {
    if (!editingLimits || refreshingLimits) return;
    setRefreshingLimits(true);
    try {
      const loaded = await fetchModels(editingLimits.providerId);
      if (!loaded) return;
      const apiModel = useModelStore.getState().models
        .get(editingLimits.providerId)
        ?.find((m) => m.id === editingLimits.modelId);
      if (!apiModel) return;
      setModelLimits(editingLimits.providerId, editingLimits.modelId, {
        contextWindow: null,
        maxOutputTokens: null,
      });
      const refreshed = useModelStore.getState().models
        .get(editingLimits.providerId)
        ?.find((m) => m.id === editingLimits.modelId);
      if (refreshed) {
        setLimitDraft({
          context: String(refreshed.autoContextWindow ?? refreshed.contextWindow),
          maxOutput: String(refreshed.autoMaxOutputTokens ?? refreshed.maxOutputTokens),
        });
      }
    } finally {
      setRefreshingLimits(false);
    }
  };

  const handleLimitKey = (e: React.KeyboardEvent) => {
    e.stopPropagation();
    if (e.key === 'Enter') { e.preventDefault(); saveLimits(); }
    if (e.key === 'Escape') { e.preventDefault(); setEditingLimits(null); }
  };

  const providerName = (providerId: string) => providers.find((p) => p.id === providerId)?.name || '';

  return (
    <div ref={containerRef} className="relative max-w-[900px] mx-auto w-full px-4 pb-3">
      <div className="flex items-center gap-2">
        <button onClick={toggleModelSelector}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm hover:bg-[var(--bg-3)] transition-colors ${showThinking ? 'flex-1 min-w-0' : 'flex-1'}`}>
          <span className="truncate text-[var(--text-secondary)] text-[13px]">{selectedModel?.name || t('selectModel')}</span>
          {selectedModel && getCapIcons(selectedModel).map((c) => (
            <span key={c} className="text-xs shrink-0">{c === 'reasoning' ? '🧠' : CAP_ICONS[c]}</span>
          ))}
          <FiChevronDown size={13} className="text-[var(--text-muted)] shrink-0 ml-auto" />
        </button>

        {showThinking && <ThinkingSlider value={reasoningEffort} onChange={setReasoningEffort} />}

        <ContextMeter />

        <button onClick={toggleTheme}
          className="w-8 h-8 rounded-xl flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors shrink-0"
          title={resolved === 'dark' ? t('lightMode') : t('darkMode')}>
          {resolved === 'dark' ? <FiSun size={14} /> : <FiMoon size={14} />}
        </button>
      </div>

      {isOpen && (
        <div className="absolute bottom-full left-6 right-6 mb-1 bg-[var(--bg-2)] border border-[var(--border)] rounded-xl shadow-lg overflow-hidden z-50 anim-menu"
          style={{ ['--menu-origin' as any]: 'bottom center', ['--menu-shift' as any]: '6px' }}
          onKeyDown={handleKeyDown}>
          <div className="p-2 border-b border-[var(--border)]">
            <div className="flex items-center gap-2 px-3 py-2 bg-[var(--bg-0)] rounded-xl">
              <FiSearch size={14} className="text-[var(--text-muted)]" />
              <input ref={searchRef} value={search} onChange={(e) => { setSearch(e.target.value); setSelectedIndex(0); }}
                placeholder={t('searchModels')} className="flex-1 bg-transparent text-sm outline-none" />
              <button onClick={() => fetchAllModels()} disabled={modelsLoading}
                className="p-1 rounded-lg hover:bg-[var(--bg-3)] text-[var(--text-muted)] disabled:opacity-50"
                title={t('refresh')}>
                <FiRefreshCw size={13} className={modelsLoading ? 'animate-spin' : ''} />
              </button>
            </div>
          </div>

          <div className="max-h-80 overflow-y-auto">
            {grouped.map((group) => (
              <div key={group.label}>
                <div className="px-3 py-1.5 text-[11px] font-semibold text-[var(--text-muted)] uppercase tracking-wider">
                  {group.label === t('favorites') && <FiStar size={10} className="inline mr-1" />}
                  {group.label}
                </div>
                {group.models.map((model) => {
                  const idx = flatModels.indexOf(model);
                  const hasReasoning = model.supportsReasoning || model.userEnabledReasoning;
                  const scopedLimitKey = modelLimitKey(model.providerId, model.id);
                  const hasLimitOverride = !!(limitOverrides[scopedLimitKey] ?? limitOverrides[model.id]);
                  const isEditing = editingLimits?.providerId === model.providerId && editingLimits.modelId === model.id;
                  const isSelected = selectedModel?.providerId === model.providerId && selectedModel.id === model.id;
                  return (
                    <div key={scopedLimitKey}>
                      <div
                        onClick={() => { selectModel(model.id, model.providerId); closeModelSelector(); }}
                        onMouseEnter={() => { setSelectedIndex(idx); setTooltipModel(model); }}
                        onMouseLeave={() => setTooltipModel(null)}
                        className={`flex items-center gap-2 px-3 py-2.5 cursor-pointer text-sm transition-colors ${
                          idx === selectedIndex ? 'bg-[var(--bg-3)]' : 'hover:bg-[var(--bg-3)]/50'
                        } ${isSelected ? 'text-[var(--accent)]' : 'text-[var(--text-primary)]'}`}>
                        <button onClick={(e) => { e.stopPropagation(); toggleFavorite(model.id); }}
                          className={`text-xs ${favorites.includes(model.id) ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}>
                          <FiStar size={12} fill={favorites.includes(model.id) ? 'currentColor' : 'none'} />
                        </button>
                        <span className="flex-1 truncate">{model.name}</span>
                        <span className={`text-[11px] tabular-nums shrink-0 ${hasLimitOverride ? 'text-[var(--accent)]' : 'text-[var(--text-muted)]'}`}
                          title={`${t('contextWindow')}: ${model.contextWindow.toLocaleString()}`}>
                          {formatLimit(model.contextWindow)}
                        </span>
                        <span className="flex gap-1 items-center text-xs shrink-0">
                          <button onClick={(e) => { e.stopPropagation(); openLimitEditor(model); }}
                            className={`p-0.5 rounded ${isEditing || hasLimitOverride ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                            title={t('editLimits')}>
                            <FiSliders size={12} />
                          </button>
                          <button onClick={(e) => { e.stopPropagation(); useModelStore.getState().toggleReasoning(model.providerId, model.id); }}
                            className={`p-0.5 rounded ${hasReasoning ? 'text-[var(--accent)] bg-[var(--accent-soft)]' : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'}`}
                            title={hasReasoning ? t('disableReasoning') : t('enableReasoning')}>
                            <FiCpu size={12} />
                          </button>
                          {getCapIcons(model).map((c) => <span key={c}>{CAP_ICONS[c]}</span>)}
                        </span>
                      </div>
                      {isEditing && (
                        <div className="px-3 pb-2 pt-1 bg-[var(--bg-3)] text-xs"
                          onClick={(e) => e.stopPropagation()}>
                          <div className="flex gap-2">
                            <label className="flex flex-col gap-0.5 flex-1 min-w-0">
                              <span className="text-[var(--text-muted)]">{t('contextWindow')}</span>
                              <input type="number" min="1" step="1" value={limitDraft.context} autoFocus
                                onChange={(e) => setLimitDraft((d) => ({ ...d, context: e.target.value }))}
                                onKeyDown={handleLimitKey}
                                className="w-full bg-[var(--bg-0)] border border-[var(--border)] rounded-lg px-2 py-1 outline-none focus:border-[var(--accent)]" />
                            </label>
                            <label className="flex flex-col gap-0.5 flex-1 min-w-0">
                              <span className="text-[var(--text-muted)]">{t('maxOutput')}</span>
                              <input type="number" min="1" step="1" value={limitDraft.maxOutput}
                                onChange={(e) => setLimitDraft((d) => ({ ...d, maxOutput: e.target.value }))}
                                onKeyDown={handleLimitKey}
                                className="w-full bg-[var(--bg-0)] border border-[var(--border)] rounded-lg px-2 py-1 outline-none focus:border-[var(--accent)]" />
                            </label>
                          </div>
                          <div className="flex justify-end gap-2 mt-2">
                            <button onClick={readLimitsFromApi} disabled={refreshingLimits}
                              className="flex items-center gap-1 px-2.5 py-1 rounded-lg bg-[var(--bg-4)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] disabled:opacity-50 shrink-0">
                              <FiRefreshCw size={11} className={refreshingLimits ? 'animate-spin' : ''} />
                              {t('readFromApi')}
                            </button>
                            <button onClick={resetLimits}
                              className="px-2.5 py-1 rounded-lg bg-[var(--bg-4)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] shrink-0">{t('reset')}</button>
                            <button onClick={saveLimits}
                              className="px-2.5 py-1 rounded-lg bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] shrink-0">{t('save')}</button>
                          </div>
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            ))}
            {grouped.length === 0 && (
              <div className="p-4 text-center text-sm text-[var(--text-muted)]">{t('noModels')}</div>
            )}
          </div>
        </div>
      )}

      {tooltipModel && isOpen && (
        <div className="absolute bottom-full left-1/2 -translate-x-1/2 mb-2 p-3 bg-[var(--bg-3)] border border-[var(--border)] rounded-xl shadow-xl text-xs space-y-1 z-50 w-56 pointer-events-none">
          <div className="font-semibold text-sm text-[var(--text-primary)]">{tooltipModel.name}</div>
          <div className="text-[var(--text-muted)]">{providerName(tooltipModel.providerId)}</div>
          <div className="border-t border-[var(--border)] pt-1 space-y-0.5">
            <div>{t('textChat')}: {tooltipModel.supportsText ? '✅' : '❌'}</div>
            <div>{t('vision')}: {tooltipModel.supportsVision ? '✅' : '❌'}</div>
            <div>{t('imageGen')}: {tooltipModel.supportsImageGeneration ? '✅' : '❌'}</div>
            <div>{t('audioIn')}: {tooltipModel.supportsAudioInput ? '✅' : '❌'}</div>
            <div>{t('audioOut')}: {tooltipModel.supportsAudioOutput ? '✅' : '❌'}</div>
            <div>{t('functions')}: {tooltipModel.supportsFunctionCalling ? '✅' : '❌'}</div>
            <div>{t('reasoning')}: {tooltipModel.supportsReasoning || tooltipModel.userEnabledReasoning ? '✅' : '❌'}</div>
          </div>
          <div className="border-t border-[var(--border)] pt-1">
            <div>{t('context')}: {tooltipModel.contextWindow.toLocaleString()}</div>
            <div>{t('maxOutput')}: {tooltipModel.maxOutputTokens.toLocaleString()}</div>
          </div>
        </div>
      )}
    </div>
  );
}
