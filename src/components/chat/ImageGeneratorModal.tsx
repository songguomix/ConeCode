import React, { useState, useEffect } from 'react';
import {
  FiX,
  FiImage,
  FiDownload,
  FiCopy,
  FiSend,
  FiMaximize2,
  FiRefreshCw,
  FiSliders,
  FiGrid,
  FiCheck,
  FiAlertCircle,
  FiEye,
  FiEyeOff,
  FiTrash2,
  FiChevronDown,
  FiChevronUp,
} from 'react-icons/fi';
import SparklesIcon from '../common/SparklesIcon';
import { useImageGenStore } from '../../stores/imageGen.store';
import { useProviderStore } from '../../stores/provider.store';
import { useModelStore } from '../../stores/model.store';
import { useLanguageStore } from '../../stores/language.store';
import {
  ART_PRESET_STYLES,
  ASPECT_RATIOS,
} from '../../core/image/prompts';
import { getAvailableImageModels } from '../../core/image/imageGen';
import { detectImageModelFamily, qualityOptionsFor, supportsColorStyle, supportsNegativePrompt } from '../../core/image/imageModels';
import { FREE_PROVIDER_ID } from '../../core/providers/free.adapter';
import type { AspectRatio, GeneratedImage, ImageStyle } from '../../core/image/types';

export default function ImageGeneratorModal() {
  const isOpen = useImageGenStore((s) => s.isOpen);
  const closeModal = useImageGenStore((s) => s.closeModal);
  const activeTab = useImageGenStore((s) => s.activeTab);
  const setActiveTab = useImageGenStore((s) => s.setActiveTab);
  const prompt = useImageGenStore((s) => s.prompt);
  const setPrompt = useImageGenStore((s) => s.setPrompt);
  const config = useImageGenStore((s) => s.config);
  const setConfig = useImageGenStore((s) => s.setConfig);
  const isGenerating = useImageGenStore((s) => s.isGenerating);
  const progressStep = useImageGenStore((s) => s.progressStep);
  const error = useImageGenStore((s) => s.error);
  const currentResult = useImageGenStore((s) => s.currentResult);
  const history = useImageGenStore((s) => s.history);
  const generate = useImageGenStore((s) => s.generate);
  const cancelGeneration = useImageGenStore((s) => s.cancelGeneration);
  const enhanceCurrentPrompt = useImageGenStore((s) => s.enhanceCurrentPrompt);
  const randomizePrompt = useImageGenStore((s) => s.randomizePrompt);
  const insertToChat = useImageGenStore((s) => s.insertToChat);
  const saveImage = useImageGenStore((s) => s.saveImage);
  const copyImage = useImageGenStore((s) => s.copyImage);
  const clearHistory = useImageGenStore((s) => s.clearHistory);
  const selectHistoryItem = useImageGenStore((s) => s.selectHistoryItem);

  const providers = useProviderStore((s) => s.providers);
  const modelsMap = useModelStore((s) => s.models);
  const { t } = useLanguageStore();

  const modelGroups = React.useMemo(
    () => getAvailableImageModels(providers, modelsMap),
    [providers, modelsMap],
  );

  const [copied, setCopied] = useState(false);
  const [downloadSuccess, setDownloadSuccess] = useState(false);
  const [showKey, setShowKey] = useState(false);
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [showRevised, setShowRevised] = useState(false);
  const [isCustomModelInput, setIsCustomModelInput] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  // Auto-select a model when none is set — but only from the group that the
  // credentials will actually resolve to. Picking across providers sends one
  // provider's model id to another provider's endpoint, which 404s.
  useEffect(() => {
    if (config.model) return;
    let candidateGroup: (typeof modelGroups)[number] | undefined;
    if (config.providerId === 'custom') {
      return; // model is typed by hand; any preset id would mismatch
    }
    if (config.providerId && config.providerId !== 'auto') {
      candidateGroup = modelGroups.find((g) => g.providerId === config.providerId);
    } else {
      // Mirror resolveImageGenCredentials' auto heuristic: prefer a keyed
      // OpenAI/custom/OpenRouter provider, then any keyed one, then Free.
      const matched =
        providers.find(
          (p) => p.enabled !== false && p.apiKey && (p.type === 'openai' || p.type === 'custom' || p.type === 'openrouter'),
        ) || providers.find((p) => p.enabled !== false && p.apiKey);
      candidateGroup = matched
        ? modelGroups.find((g) => g.providerId === matched.id)
        : modelGroups.find((g) => g.isFree);
    }
    const first = candidateGroup?.models[0];
    if (first) setConfig({ model: first.id });
  }, [config.model, config.providerId, modelGroups, providers, setConfig]);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        if (lightboxImage) {
          setLightboxImage(null);
        } else {
          closeModal();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [isOpen, lightboxImage, closeModal]);

  if (!isOpen) return null;

  // Capabilities come from the model-family table, not a name grep: gpt-image
  // offers auto/low/medium/high qualities plus transparent backgrounds, and
  // only DALL-E 3 has the vivid/natural colour style.
  const imageFamily = detectImageModelFamily(config.model);
  const qualityChoices = qualityOptionsFor(imageFamily);
  const hasColorStyle = supportsColorStyle(imageFamily);
  const hasNegativePrompt = supportsNegativePrompt(imageFamily);

  const handleCopy = async (target?: GeneratedImage) => {
    const success = await copyImage(target);
    if (success) {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  };

  const handleDownload = async (target?: GeneratedImage) => {
    const success = await saveImage(target);
    if (success) {
      setDownloadSuccess(true);
      setTimeout(() => setDownloadSuccess(false), 2000);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-6 bg-black/60 backdrop-blur-xl anim-scrim">
      {/* Modal Container */}
      <div className="relative flex flex-col w-full max-w-4xl h-[90vh] max-h-[860px] rounded-3xl bg-[var(--glass-surface)] border border-[var(--glass-border)] shadow-[0_25px_60px_-15px_rgba(0,0,0,0.5)] overflow-hidden text-[var(--text-primary)]">
        {/* Ambient Top Glow */}
        <div className="absolute top-0 inset-x-0 h-40 bg-gradient-to-b from-[color-mix(in_srgb,var(--accent)_15%,transparent)] via-[color-mix(in_srgb,var(--accent)_5%,transparent)] to-transparent pointer-events-none" />

        {/* Header */}
        <div className="relative flex items-center justify-between px-4 sm:px-5 py-3.5 border-b border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_50%,transparent)] backdrop-blur-md z-10 shrink-0">
          <div className="flex min-w-0 items-center gap-3">
            <div>
              <div className="flex items-center gap-2">
                <h2 className="text-base sm:text-lg font-bold font-serif tracking-tight text-[var(--text-primary)]">
                  {t('imageStudio')}
                </h2>
                {config.model && (
                  <span className="max-w-full truncate text-[11px] px-2 py-0.5 rounded-full bg-[var(--accent-soft)] text-[var(--accent)] font-mono font-medium border border-[color-mix(in_srgb,var(--accent)_30%,transparent)]" title={config.model}>
                    {config.model}
                  </span>
                )}
              </div>
              <p className="text-xs text-[var(--text-muted)]">
                {t('imageStudioSubtitle')}
              </p>
            </div>
          </div>

          {/* Navigation Tabs */}
          <div className="flex items-center gap-1.5 p-1 rounded-xl bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] border border-[var(--glass-border)]">
            <button
              onClick={() => setActiveTab('studio')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'studio'
                  ? 'bg-[var(--glass-card)] text-[var(--text-primary)] shadow-xs font-semibold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <SparklesIcon size={13} />
              <span>{t('imageStudioTab')}</span>
            </button>
            <button
              onClick={() => setActiveTab('gallery')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'gallery'
                  ? 'bg-[var(--glass-card)] text-[var(--text-primary)] shadow-xs font-semibold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <FiGrid size={13} />
              <span>{t('imageGalleryTab')} {history.length > 0 && `(${history.length})`}</span>
            </button>
            <button
              onClick={() => setActiveTab('settings')}
              className={`flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-xs font-medium transition-all cursor-pointer ${
                activeTab === 'settings'
                  ? 'bg-[var(--glass-card)] text-[var(--text-primary)] shadow-xs font-semibold'
                  : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
              }`}
            >
              <FiSliders size={13} />
              <span>{t('imageSettingsTab')}</span>
            </button>
          </div>

          {/* Close Button */}
          <button
            onClick={closeModal}
            aria-label={t('close')}
            className="w-8 h-8 rounded-full flex items-center justify-center text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] transition-colors cursor-pointer"
          >
            <FiX size={18} />
          </button>
        </div>

        {/* Content Body */}
        <div className="relative flex-1 min-h-0 overflow-y-auto px-4 sm:px-5 py-4 space-y-5">
          {/* Global Alert Notification */}
          {error && (
            <div className="p-3.5 rounded-2xl bg-[color-mix(in_srgb,var(--error)_10%,transparent)] border border-[color-mix(in_srgb,var(--error)_30%,transparent)] text-[var(--error)] text-xs flex items-center justify-between gap-3 anim-shake">
              <div className="flex items-center gap-2 min-w-0">
                <FiAlertCircle size={16} className="shrink-0" />
                <span className="leading-snug break-words">{error}</span>
              </div>
              {activeTab !== 'settings' && (
                <button
                  onClick={() => setActiveTab('settings')}
                  className="px-2.5 py-1 rounded-xl bg-[var(--error)] text-white text-[11px] font-medium shrink-0 hover:opacity-90 cursor-pointer"
                >
                  {t('imageSettingsTab')}
                </button>
              )}
            </div>
          )}

          {/* TAB 1: STUDIO */}
          {activeTab === 'studio' && (
            <div className="space-y-5">
              {/* Prompt Editor Box */}
              <div className="rounded-3xl p-4 bg-[var(--glass-card)] border border-[var(--glass-border)] shadow-xs space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)] flex items-center gap-1.5">
                    <SparklesIcon size={12} className="text-[var(--accent)]" />
                    {t('promptLabel')}
                  </label>
                  <div className="flex items-center gap-1.5">
                    <button
                      onClick={randomizePrompt}
                      type="button"
                      title={t('randomPrompt')}
                      className="px-2.5 py-1 rounded-xl text-xs font-medium bg-[color-mix(in_srgb,var(--bg-3)_60%,transparent)] hover:bg-[var(--bg-3)] text-[var(--text-secondary)] hover:text-[var(--text-primary)] border border-[var(--glass-border)] transition-colors flex items-center gap-1 cursor-pointer"
                    >
                      <span>{t('randomPrompt')}</span>
                    </button>
                    <button
                      onClick={enhanceCurrentPrompt}
                      disabled={!prompt.trim()}
                      type="button"
                      title={t('enhancePrompt')}
                      className="px-2.5 py-1 rounded-xl text-xs font-medium bg-[var(--accent-soft)] text-[var(--accent)] hover:bg-[var(--accent)] hover:text-white border border-[color-mix(in_srgb,var(--accent)_30%,transparent)] transition-all disabled:opacity-40 flex items-center gap-1 cursor-pointer"
                    >
                      <SparklesIcon size={11} />
                      <span>{t('enhancePrompt')}</span>
                    </button>
                    {prompt && (
                      <button
                        onClick={() => setPrompt('')}
                        type="button"
                        className="p-1 rounded-lg text-[var(--text-muted)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] cursor-pointer"
                        title={t('clearPrompt')}
                      >
                        <FiTrash2 size={13} />
                      </button>
                    )}
                  </div>
                </div>

                <textarea
                  value={prompt}
                  onChange={(e) => setPrompt(e.target.value)}
                  placeholder={t('promptPlaceholder')}
                  rows={3}
                  className="w-full bg-transparent text-[15px] leading-relaxed text-[var(--text-primary)] placeholder:text-[color-mix(in_srgb,var(--text-muted)_60%,transparent)] outline-none resize-none"
                />
              </div>

              {/* Art Style Presets */}
              <div className="space-y-2.5">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                    {t('artStylePresets')}
                  </span>
                  {config.artStyleId && (
                    <button
                      onClick={() => setConfig({ artStyleId: '' })}
                      className="text-xs text-[var(--text-muted)] hover:text-[var(--accent)] transition-colors cursor-pointer"
                    >
                      {t('clearStyle')}
                    </button>
                  )}
                </div>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  {ART_PRESET_STYLES.map((style) => {
                    const isSelected = config.artStyleId === style.id;
                    return (
                      <button
                        key={style.id}
                        type="button"
                        onClick={() =>
                          setConfig({
                            artStyleId: isSelected ? '' : style.id,
                          })
                        }
                        className={`flex flex-col items-start p-3 rounded-2xl border text-left transition-all ${
                          isSelected
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)] shadow-md shadow-[var(--accent)]/15 scale-[1.02]'
                            : 'bg-[color-mix(in_srgb,var(--glass-card)_80%,transparent)] hover:bg-[var(--glass-card)] border-[var(--glass-border)] hover:border-[color-mix(in_srgb,var(--text-muted)_40%,transparent)]'
                        }`}
                      >
                        <div className="flex items-center justify-end w-full mb-1 min-h-[20px]">
                          {isSelected && (
                            <span className="w-2 h-2 rounded-full bg-[var(--accent)] shadow-xs" />
                          )}
                        </div>
                        <span className="text-[13px] font-bold text-[var(--text-primary)] font-serif">
                          {style.name}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)] truncate w-full mt-0.5">
                          {style.description}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Aspect Ratio Selector */}
              <div className="space-y-2.5">
                <span className="text-xs font-semibold uppercase tracking-wider text-[var(--text-muted)]">
                  {t('aspectRatio')}
                </span>
                <div className="grid grid-cols-2 sm:grid-cols-5 gap-2.5">
                  {ASPECT_RATIOS.map((ratio) => {
                    const isSelected = config.aspectRatio === ratio.id;
                    return (
                      <button
                        key={ratio.id}
                        type="button"
                        onClick={() => setConfig({ aspectRatio: ratio.id })}
                        className={`flex flex-col items-center justify-center p-3 rounded-2xl border transition-all cursor-pointer ${
                          isSelected
                            ? 'bg-[var(--accent-soft)] border-[var(--accent)] text-[var(--accent)] shadow-md shadow-[var(--accent)]/15 scale-[1.02]'
                            : 'bg-[color-mix(in_srgb,var(--glass-card)_80%,transparent)] hover:bg-[var(--glass-card)] border-[var(--glass-border)] text-[var(--text-secondary)] hover:text-[var(--text-primary)]'
                        }`}
                      >
                        {/* Visual Ratio Box */}
                        <div className="h-9 flex items-center justify-center mb-1.5">
                          <div
                            style={{
                              width: `${ratio.w}px`,
                              height: `${ratio.h}px`,
                            }}
                            className={`rounded-md border-2 transition-colors ${
                              isSelected
                                ? 'border-[var(--accent)] bg-[color-mix(in_srgb,var(--accent)_20%,transparent)]'
                                : 'border-[color-mix(in_srgb,var(--text-muted)_50%,transparent)] bg-[var(--bg-3)]'
                            }`}
                          />
                        </div>
                        <span className="text-[13px] font-bold font-mono">
                          {ratio.label}
                        </span>
                        <span className="text-[10px] text-[var(--text-muted)]">
                          {ratio.name}
                        </span>
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Advanced Settings Collapsible */}
              <div className="rounded-2xl border border-[var(--glass-border)] bg-[color-mix(in_srgb,var(--glass-card)_40%,transparent)] overflow-hidden">
                <button
                  type="button"
                  onClick={() => setShowAdvanced((v) => !v)}
                  className="w-full flex items-center justify-between px-4 py-2.5 text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] transition-colors cursor-pointer"
                >
                  <span className="font-semibold flex items-center gap-1.5">
                    <FiSliders size={12} />
                    {t('advancedOptions')}
                  </span>
                  {showAdvanced ? <FiChevronUp size={14} /> : <FiChevronDown size={14} />}
                </button>

                {showAdvanced && (
                  <div className="p-4 pt-1 border-t border-[var(--glass-border)] space-y-4 text-xs">
                    <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
                      {/* Model Selector */}
                      <div className="sm:col-span-1">
                        <div className="flex items-center justify-between mb-1">
                          <label className="text-[11px] text-[var(--text-muted)] font-medium">
                            {t('visualModel')}
                          </label>
                          <button
                            type="button"
                            onClick={() => setIsCustomModelInput((v) => !v)}
                            className="text-[10px] text-[var(--accent)] hover:underline cursor-pointer"
                          >
                            {isCustomModelInput ? t('selectFromProvider') : t('customInput')}
                          </button>
                        </div>

                        {isCustomModelInput ? (
                          <input
                            type="text"
                            value={config.model}
                            onChange={(e) => setConfig({ model: e.target.value })}
                            placeholder={t('customModelPlaceholder')}
                            className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-[var(--text-primary)] outline-none text-xs"
                          />
                        ) : modelGroups.length > 0 ? (
                          <select
                            value={config.model}
                            onChange={(e) => {
                              if (e.target.value === '__custom__') {
                                setIsCustomModelInput(true);
                              } else {
                                setConfig({ model: e.target.value });
                              }
                            }}
                            className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-[var(--text-primary)] outline-none text-xs cursor-pointer"
                          >
                            {!config.model && (
                              <option value="" disabled>{t('pleaseSelectModel')}</option>
                            )}
                            {modelGroups.map((g) => (
                              <optgroup key={g.providerId} label={g.label}>
                                {g.models.map((m) => (
                                  <option key={`${g.providerId}-${m.id}`} value={m.id}>
                                    {m.name}
                                  </option>
                                ))}
                              </optgroup>
                            ))}
                            <option value="__custom__">{t('customInput')}...</option>
                          </select>
                        ) : (
                          <input
                            type="text"
                            value={config.model}
                            onChange={(e) => setConfig({ model: e.target.value })}
                            placeholder={t('customModelPlaceholder')}
                            className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-[var(--text-primary)] outline-none text-xs"
                          />
                        )}
                      </div>

                      {/* Quality — only what the selected model understands */}
                      {qualityChoices.length > 0 && (
                        <div>
                          <label className="block text-[11px] text-[var(--text-muted)] mb-1 font-medium">
                            {t('qualityLevel')}
                          </label>
                          <div className={`grid gap-1 p-0.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] ${qualityChoices.length > 2 ? 'grid-cols-4' : 'grid-cols-2'}`}>
                            {qualityChoices.map((q) => (
                              <button
                                key={q}
                                type="button"
                                onClick={() => setConfig({ quality: q })}
                                className={`py-1 rounded-lg text-center font-medium capitalize transition-all ${
                                  config.quality === q
                                    ? 'bg-[var(--accent)] text-white shadow-xs'
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                }`}
                              >
                                {q === 'auto' ? t('qualityAuto')
                                  : q === 'low' ? t('qualityLow')
                                  : q === 'medium' ? t('qualityMedium')
                                  : q === 'high' ? t('qualityHigh')
                                  : q === 'hd' ? t('hdQuality')
                                  : t('standardQuality')}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* DALL-E Style */}
                      {hasColorStyle && (
                        <div>
                          <label className="block text-[11px] text-[var(--text-muted)] mb-1 font-medium">
                            {t('colorStyle')}
                          </label>
                          <div className="grid grid-cols-2 gap-1 p-0.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)]">
                            {(['vivid', 'natural'] as ImageStyle[]).map((st) => (
                              <button
                                key={st}
                                type="button"
                                onClick={() => setConfig({ style: st })}
                                className={`py-1 rounded-lg text-center font-medium capitalize transition-all ${
                                  config.style === st
                                    ? 'bg-[var(--accent)] text-white shadow-xs'
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                }`}
                              >
                                {st === 'vivid' ? t('vividStyle') : t('naturalStyle')}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}

                      {/* Transparent background — gpt-image only */}
                      {imageFamily === 'gpt-image' && (
                        <div>
                          <label className="block text-[11px] text-[var(--text-muted)] mb-1 font-medium">
                            {t('imageBackground')}
                          </label>
                          <div className="grid grid-cols-2 gap-1 p-0.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)]">
                            {(['auto', 'transparent'] as const).map((bg) => (
                              <button
                                key={bg}
                                type="button"
                                onClick={() => setConfig({ background: bg })}
                                className={`py-1 rounded-lg text-center font-medium transition-all ${
                                  config.background === bg
                                    ? 'bg-[var(--accent)] text-white shadow-xs'
                                    : 'text-[var(--text-muted)] hover:text-[var(--text-primary)]'
                                }`}
                              >
                                {bg === 'auto' ? t('backgroundAuto') : t('backgroundTransparent')}
                              </button>
                            ))}
                          </div>
                        </div>
                      )}
                    </div>

                    {/* Negative Prompt — only models with a real parameter for it */}
                    {hasNegativePrompt && (
                      <div>
                        <label className="block text-[11px] text-[var(--text-muted)] mb-1 font-medium">
                          {t('negativePrompt')}
                        </label>
                        <input
                          type="text"
                          value={config.negativePrompt}
                          onChange={(e) => setConfig({ negativePrompt: e.target.value })}
                          placeholder={t('negativePromptPlaceholder')}
                          className="w-full px-3 py-1.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-[var(--text-primary)] outline-none"
                        />
                      </div>
                    )}
                  </div>
                )}
              </div>

              {/* Action Area: Generate Button or Generating Shimmer */}
              <div className="pt-2">
                {isGenerating ? (
                  <div className="p-6 rounded-3xl border border-[color-mix(in_srgb,var(--accent)_40%,transparent)] bg-gradient-to-r from-[var(--accent-soft)] via-[var(--bg-2)] to-[var(--accent-soft)] flex flex-col items-center justify-center gap-3 text-center animate-pulse shadow-lg">
                    <div className="w-12 h-12 rounded-2xl bg-gradient-to-tr from-[var(--accent)] to-[#f09375] text-white flex items-center justify-center shadow-lg shadow-[var(--accent)]/30 animate-spin">
                      <FiRefreshCw size={22} />
                    </div>
                    <div>
                      <h4 className="text-sm font-bold font-serif text-[var(--text-primary)]">
                        {progressStep || t('generatingArt')}
                      </h4>
                    </div>
                    <button
                      type="button"
                      onClick={cancelGeneration}
                      className="px-4 py-1.5 rounded-xl text-xs text-[var(--text-muted)] hover:text-[var(--error)] border border-[var(--glass-border)] hover:border-[color-mix(in_srgb,var(--error)_30%,transparent)] transition-colors mt-1 cursor-pointer"
                    >
                      {t('cancelGenerate')}
                    </button>
                  </div>
                ) : (
                  <button
                    type="button"
                    onClick={() => generate()}
                    disabled={!prompt.trim()}
                    className="w-full py-3.5 px-6 rounded-2xl bg-gradient-to-r from-[var(--accent)] via-[#db6d4a] to-[#ea7e5c] text-white font-bold font-serif text-[15px] shadow-[0_8px_25px_rgba(201,100,66,0.35)] hover:shadow-[0_10px_30px_rgba(201,100,66,0.45)] hover:scale-[1.01] active:scale-[0.99] disabled:opacity-40 disabled:shadow-none transition-all flex items-center justify-center gap-2 group cursor-pointer"
                  >
                    <SparklesIcon size={18} className="group-hover:rotate-12 transition-transform" />
                    <span>{t('startGenerate')}</span>
                  </button>
                )}
              </div>

              {/* Image Result Section */}
              {currentResult && !isGenerating && (
                <div className="rounded-3xl p-5 bg-[var(--glass-card)] border border-[var(--glass-border)] shadow-lg space-y-4 anim-slide-up">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-2">
                      <span className="w-2.5 h-2.5 rounded-full bg-[var(--success)]" />
                      <span className="text-[11px] text-[var(--text-muted)] font-mono">
                        {currentResult.size} · {currentResult.aspectRatio}
                      </span>
                    </div>

                    {/* Quick Result Action Buttons */}
                    <div className="flex items-center gap-1.5">
                      <button
                        onClick={() => insertToChat(currentResult)}
                        className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-all shadow-xs cursor-pointer"
                        title={t('insertToChat')}
                      >
                        <FiSend size={12} />
                        <span>{t('insertToChat')}</span>
                      </button>
                      <button
                        onClick={() => handleDownload(currentResult)}
                        className="p-2 rounded-xl text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] border border-[var(--glass-border)] transition-colors cursor-pointer"
                        title={t('saveArtwork')}
                      >
                        {downloadSuccess ? <FiCheck size={13} className="text-[var(--success)]" /> : <FiDownload size={13} />}
                      </button>
                      <button
                        onClick={() => handleCopy(currentResult)}
                        className="p-2 rounded-xl text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] border border-[var(--glass-border)] transition-colors cursor-pointer"
                        title={t('copyArtwork')}
                      >
                        {copied ? <FiCheck size={13} className="text-[var(--success)]" /> : <FiCopy size={13} />}
                      </button>
                      <button
                        onClick={() => setLightboxImage(currentResult.url)}
                        className="p-2 rounded-xl text-xs text-[var(--text-secondary)] hover:text-[var(--text-primary)] hover:bg-[var(--bg-3)] border border-[var(--glass-border)] transition-colors"
                        title={t('fullscreenView')}
                      >
                        <FiMaximize2 size={13} />
                      </button>
                    </div>
                  </div>

                  {/* Artwork Showcase */}
                  <div
                    onClick={() => setLightboxImage(currentResult.url)}
                    className="relative group cursor-zoom-in rounded-2xl overflow-hidden bg-black/5 dark:bg-black/30 border border-[var(--glass-border)] flex items-center justify-center max-h-[440px]"
                  >
                    <img
                      src={currentResult.url}
                      alt={currentResult.prompt}
                      className="max-h-[440px] w-auto max-w-full object-contain group-hover:scale-[1.01] transition-transform duration-300"
                    />
                    <div className="absolute inset-0 bg-black/30 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                      <span className="px-3.5 py-1.5 rounded-full bg-black/60 text-white text-xs backdrop-blur-md flex items-center gap-1.5">
                        <FiMaximize2 size={13} />
                        {t('clickToFullscreen')}
                      </span>
                    </div>
                  </div>

                  {/* Revised Prompt Disclosure (DALL-E 3) */}
                  {currentResult.revisedPrompt && (
                    <div className="text-xs space-y-1">
                      <button
                        type="button"
                        onClick={() => setShowRevised((v) => !v)}
                        className="text-[var(--text-muted)] hover:text-[var(--text-primary)] transition-colors flex items-center gap-1 font-medium"
                      >
                        <span>{showRevised ? t('collapseRevisedPrompt') : t('expandRevisedPrompt')}</span>
                        {showRevised ? <FiChevronUp size={12} /> : <FiChevronDown size={12} />}
                      </button>
                      {showRevised && (
                        <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-[var(--text-secondary)] italic leading-relaxed text-[13px] font-serif">
                          {currentResult.revisedPrompt}
                        </div>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          )}

          {/* TAB 2: GALLERY */}
          {activeTab === 'gallery' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between">
                <div>
                  <h3 className="text-sm font-bold font-serif">{t('sessionArtworks')}</h3>
                  <p className="text-xs text-[var(--text-muted)]">
                    {t('sessionArtworksDesc')} ({history.length})
                  </p>
                </div>
                {history.length > 0 && (
                  <button
                    onClick={clearHistory}
                    className="flex items-center gap-1 px-3 py-1.5 rounded-xl text-xs text-[var(--text-muted)] hover:text-[var(--error)] hover:bg-[var(--bg-3)] transition-colors"
                  >
                    <FiTrash2 size={12} />
                    <span>{t('clearHistory')}</span>
                  </button>
                )}
              </div>

              {history.length === 0 ? (
                <div className="py-10 flex flex-col items-center justify-center text-center space-y-3">
                  <div className="w-16 h-16 rounded-3xl bg-[var(--bg-3)] text-[var(--text-muted)] flex items-center justify-center">
                    <FiImage size={28} />
                  </div>
                  <div>
                    <h4 className="text-sm font-bold text-[var(--text-primary)]">
                      {t('noHistoryYet')}
                    </h4>
                    <p className="text-xs text-[var(--text-muted)] mt-1 max-w-xs">
                      {t('noHistoryArtworksDesc')}
                    </p>
                  </div>
                  <button
                    onClick={() => setActiveTab('studio')}
                    className="px-4 py-2 rounded-xl text-xs font-medium bg-[var(--accent)] text-white hover:bg-[var(--accent-hover)] transition-colors"
                  >
                    {t('goToCreateNow')}
                  </button>
                </div>
              ) : (
                <div className="grid grid-cols-2 sm:grid-cols-3 gap-3.5">
                  {/* Big payloads are stripped from stored history; only real
                      images belong in the grid — text stubs stay remixable in
                      the studio but would render as broken tiles here. */}
                  {history.filter((item) => item.url).map((item) => (
                    <div
                      key={item.id}
                      className="group relative rounded-2xl overflow-hidden border border-[var(--glass-border)] bg-[var(--glass-card)] shadow-xs aspect-square flex items-center justify-center"
                    >
                      <img
                        src={item.url}
                        alt={item.prompt}
                        className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
                      />
                      {/* Hover Overlay */}
                      <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-black/30 to-transparent opacity-0 group-hover:opacity-100 transition-opacity p-3 flex flex-col justify-between">
                        <div className="flex justify-end gap-1">
                          <button
                            onClick={() => setLightboxImage(item.url)}
                            className="p-1.5 rounded-lg bg-black/60 text-white hover:bg-black/80 transition-colors"
                            title={t('fullscreenView')}
                          >
                            <FiMaximize2 size={13} />
                          </button>
                        </div>
                        <div className="space-y-1.5">
                          <p className="text-[11px] text-white/90 line-clamp-2 leading-tight">
                            {item.prompt}
                          </p>
                          <div className="flex items-center gap-1">
                            <button
                              onClick={() => insertToChat(item)}
                              className="flex-1 py-1 rounded-lg bg-[var(--accent)] text-white text-[11px] font-medium hover:bg-[var(--accent-hover)] transition-colors text-center"
                            >
                              {t('insertToChat')}
                            </button>
                            <button
                              onClick={() => handleDownload(item)}
                              className="p-1.5 rounded-lg bg-white/20 text-white hover:bg-white/30 transition-colors"
                              title={t('download')}
                            >
                              <FiDownload size={12} />
                            </button>
                          </div>
                        </div>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}

          {/* TAB 3: SETTINGS */}
          {activeTab === 'settings' && (
            <div className="max-w-2xl mx-auto space-y-6">
              <div>
                <h3 className="text-base font-bold font-serif">{t('apiProviderConfig')}</h3>
                <p className="text-xs text-[var(--text-muted)] mt-0.5">
                  {t('apiProviderConfigDesc')}
                </p>
              </div>

              {/* Provider Selection */}
              <div className="space-y-2">
                <label className="text-xs font-semibold text-[var(--text-secondary)]">
                  {t('selectApiProvider')}
                </label>
                <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setConfig({ providerId: 'auto' })}
                    className={`p-3 rounded-2xl border text-left transition-all ${
                      config.providerId === 'auto'
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs'
                        : 'border-[var(--glass-border)] bg-[var(--glass-card)]'
                    }`}
                  >
                    <div className="font-bold text-[13px]">{t('autoSelect')}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                      {t('autoSelectDesc')}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfig({ providerId: FREE_PROVIDER_ID })}
                    className={`p-3 rounded-2xl border text-left transition-all ${
                      config.providerId === FREE_PROVIDER_ID
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs'
                        : 'border-[var(--glass-border)] bg-[var(--glass-card)]'
                    }`}
                  >
                    <div className="font-bold text-[13px]">{t('conecodeFreeOption')}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                      {t('conecodeFreeOptionDesc')}
                    </div>
                  </button>

                  <button
                    type="button"
                    onClick={() => setConfig({ providerId: 'custom' })}
                    className={`p-3 rounded-2xl border text-left transition-all ${
                      config.providerId === 'custom'
                        ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs'
                        : 'border-[var(--glass-border)] bg-[var(--glass-card)]'
                    }`}
                  >
                    <div className="font-bold text-[13px]">{t('customApiOption')}</div>
                    <div className="text-[11px] text-[var(--text-muted)] mt-0.5">
                      {t('customApiOptionDesc')}
                    </div>
                  </button>

                  {/* List configured providers from conecode */}
                  {providers
                    .filter((p) => p.enabled && p.id !== FREE_PROVIDER_ID)
                    .map((p) => (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => setConfig({ providerId: p.id })}
                        className={`p-3 rounded-2xl border text-left transition-all ${
                          config.providerId === p.id
                            ? 'border-[var(--accent)] bg-[var(--accent-soft)] shadow-xs'
                            : 'border-[var(--glass-border)] bg-[var(--glass-card)]'
                        }`}
                      >
                        <div className="font-bold text-[13px] truncate">{p.name}</div>
                        <div className="text-[11px] text-[var(--text-muted)] mt-0.5 truncate">
                          {t('providerType')}: {p.type}
                        </div>
                      </button>
                    ))}
                </div>
              </div>

              {/* Custom API Credentials - only shown when custom is selected */}
              {config.providerId === 'custom' && (
              <div className="p-4 rounded-3xl bg-[var(--glass-card)] border border-[var(--glass-border)] space-y-4">
                <h4 className="text-xs font-bold uppercase tracking-wider text-[var(--text-muted)]">
                  {t('apiConnectionInfo')}
                </h4>

                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                    {t('apiBaseUrl')}
                  </label>
                  <input
                    type="text"
                    value={config.customBaseUrl}
                    onChange={(e) => setConfig({ customBaseUrl: e.target.value })}
                    placeholder="https://..."
                    className="w-full px-3.5 py-2.5 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-sm outline-none focus:border-[var(--accent)] transition-colors font-mono"
                  />
                  <span className="text-[11px] text-[var(--text-muted)] mt-1 block">
                    {t('chatCompletionEndpointTip')}
                  </span>
                </div>

                <div>
                  <label className="block text-xs font-medium text-[var(--text-secondary)] mb-1">
                    {t('apiKey')}
                  </label>
                  <div className="relative">
                    <input
                      type={showKey ? 'text' : 'password'}
                      value={config.customApiKey}
                      onChange={(e) => setConfig({ customApiKey: e.target.value })}
                      placeholder="sk-..."
                      className="w-full px-3.5 py-2.5 pr-10 rounded-xl bg-[var(--bg-2)] border border-[var(--glass-border)] text-sm outline-none focus:border-[var(--accent)] transition-colors font-mono"
                    />
                    <button
                      type="button"
                      onClick={() => setShowKey((v) => !v)}
                      className="absolute right-3 top-1/2 -translate-y-1/2 text-[var(--text-muted)] hover:text-[var(--text-primary)]"
                    >
                      {showKey ? <FiEyeOff size={15} /> : <FiEye size={15} />}
                    </button>
                  </div>
                  <span className="text-[11px] text-[var(--text-muted)] mt-1 block">
                    {t('keyLocalSecurityTip')}
                  </span>
                </div>
              </div>
              )}

              <div className="flex justify-end gap-2 pt-2">
                <button
                  type="button"
                  onClick={() => setActiveTab('studio')}
                  className="px-5 py-2 rounded-xl bg-[var(--accent)] text-white text-xs font-bold shadow-xs hover:bg-[var(--accent-hover)] transition-colors"
                >
                  {t('saveAndStart')}
                </button>
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Lightbox / Fullscreen Image Viewer */}
      {lightboxImage && (
        <div
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-60 bg-black/90 backdrop-blur-2xl flex items-center justify-center p-4 anim-scrim cursor-zoom-out"
        >
          <button
            onClick={() => setLightboxImage(null)}
            className="absolute top-5 right-5 w-10 h-10 rounded-full bg-white/10 hover:bg-white/20 text-white flex items-center justify-center transition-colors"
          >
            <FiX size={20} />
          </button>
          <img
            src={lightboxImage}
            alt="Fullscreen preview"
            onClick={(e) => e.stopPropagation()}
            className="max-h-[90vh] max-w-[90vw] object-contain rounded-2xl shadow-2xl cursor-default"
          />
        </div>
      )}
    </div>
  );
}
