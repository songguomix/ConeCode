import { useMemo, useState } from 'react';
import {
  FiImage, FiCheckCircle, FiAlertCircle, FiSliders,
  FiCpu, FiExternalLink, FiKey,
} from 'react-icons/fi';
import SparklesIcon from '../common/SparklesIcon';
import { useImageGenStore } from '../../stores/imageGen.store';
import { useProviderStore } from '../../stores/provider.store';
import { useModelStore } from '../../stores/model.store';
import { useLanguageStore } from '../../stores/language.store';
import { ASPECT_RATIOS, ART_PRESET_STYLES } from '../../core/image/prompts';
import { resolveImageGenCredentials, getAvailableImageModels } from '../../core/image/imageGen';
import { FREE_PROVIDER_ID } from '../../core/providers/free.adapter';
import type { AspectRatio, ImageQuality, ImageStyle } from '../../core/image/types';

export interface ImageGenPluginViewProps {
  config?: import('../../core/image/types').ImageGenConfig;
  providers?: import('../../types').ProviderConfig[];
  models?: Map<string, import('../../types').AIModel[]> | Record<string, import('../../types').AIModel[]>;
  history?: import('../../core/image/types').GeneratedImage[];
}

export default function ImageGenPluginView(props: ImageGenPluginViewProps = {}) {
  const storeConfig = useImageGenStore((s) => s.config);
  const config = props.config ?? storeConfig;
  const setConfig = useImageGenStore((s) => s.setConfig);
  const openModal = useImageGenStore((s) => s.openModal);
  const storeHistory = useImageGenStore((s) => s.history);
  const history = props.history ?? storeHistory;
  const storeProviders = useProviderStore((s) => s.providers);
  const providers = props.providers ?? storeProviders;
  const storeModels = useModelStore((s) => s.models);
  const models = props.models ?? storeModels;
  const { t } = useLanguageStore();

  const [customModelInput, setCustomModelInput] = useState('');
  const [isCustomModel, setIsCustomModel] = useState(false);

  // Strictly dynamic models from user providers and Free provider
  const modelGroups = useMemo(
    () => getAvailableImageModels(providers, models),
    [providers, models],
  );

  // Available models for currently selected provider
  const activeGroups = useMemo(() => {
    if (!config.providerId || config.providerId === 'auto') {
      return modelGroups;
    }
    return modelGroups.filter((g) => g.providerId === config.providerId);
  }, [config.providerId, modelGroups]);

  // Compute resolved credentials live to show current status to user
  const resolved = useMemo(
    () => resolveImageGenCredentials(config, providers),
    [config, providers],
  );

  const handleProviderChange = (providerId: string) => {
    if (providerId === 'auto') {
      setConfig({ providerId: 'auto' });
    } else if (providerId === FREE_PROVIDER_ID) {
      const freeGroup = modelGroups.find((g) => g.providerId === FREE_PROVIDER_ID);
      setConfig({
        providerId: FREE_PROVIDER_ID,
        model: freeGroup?.models[0]?.id || config.model,
      });
    } else {
      const p = providers.find((item) => item.id === providerId);
      const pGroup = modelGroups.find((g) => g.providerId === providerId);
      setConfig({
        providerId,
        model: pGroup?.models[0]?.id || p?.defaultModel || config.model,
      });
    }
  };

  const handleModelSelect = (modelId: string) => {
    if (modelId === 'custom') {
      setIsCustomModel(true);
    } else {
      setIsCustomModel(false);
      setConfig({ model: modelId });
    }
  };

  return (
    <div className="space-y-4 text-xs">
      {/* Intro & Tool Status Banner */}
      <div className="p-3.5 rounded-2xl bg-gradient-to-r from-pink-500/10 via-[var(--accent-soft)] to-violet-500/10 border border-pink-500/20 shadow-2xs">
        <div className="flex items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <span className="p-1.5 rounded-xl bg-pink-500 text-white shadow-2xs">
                <FiImage size={15} />
              </span>
              <h3 className="font-semibold text-sm text-[var(--text-primary)]">
                {t('imageGenPluginTitle')}
              </h3>
              <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border border-emerald-500/30">
                <FiCheckCircle size={10} /> {t('nativeToolReady')}
              </span>
            </div>
            <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
              {t('imageGenPluginDesc')}
            </p>
          </div>
          <button
            onClick={() => openModal()}
            className="px-3 py-1.5 rounded-xl bg-gradient-to-r from-[var(--accent)] to-[#e88a6a] text-white font-medium text-xs flex items-center gap-1.5 hover:opacity-95 shadow-2xs transition-all shrink-0 cursor-pointer"
          >
            <SparklesIcon size={13} />
            {t('openStudio')}
          </button>
        </div>
      </div>

      {/* Zero Configuration Banner: Uses Software Credentials Directly */}
      <div className="p-3 rounded-xl bg-[var(--bg-2)] border border-[var(--border)] flex items-start gap-2.5">
        <span className="p-1 rounded-lg bg-[var(--accent)]/15 text-[var(--accent)] shrink-0 mt-0.5">
          <FiKey size={13} />
        </span>
        <div className="flex-1 space-y-0.5">
          <p className="font-medium text-[var(--text-primary)] text-xs">
            {t('reuseConfigTip')}
          </p>
          <p className="text-[11px] text-[var(--text-muted)] leading-relaxed">
            {t('reuseConfigDesc')}
          </p>
        </div>
      </div>

      {/* Model & Provider Settings */}
      <div className="p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] space-y-3 shadow-2xs">
        <div className="flex items-center gap-2 pb-2 border-b border-[var(--border)]/60 text-[var(--text-primary)] font-medium">
          <FiCpu size={14} className="text-[var(--accent)]" />
          <span>{t('providerModelSelect')}</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          {/* Provider Select */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center gap-1">
              <span>{t('callProvider')}</span>
            </label>
            <select
              value={config.providerId || 'auto'}
              onChange={(e) => handleProviderChange(e.target.value)}
              className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-all cursor-pointer"
            >
              <option value="auto">{t('autoSelect')}</option>
              <option value={FREE_PROVIDER_ID}>{t('conecodeFreeOption')}</option>
              {providers
                .filter((p) => p.id !== FREE_PROVIDER_ID)
                .map((p) => {
                  const hasKey = !!p.apiKey;
                  const status = hasKey ? t('credentialReady') : t('missingApiKey');
                  return (
                    <option key={p.id} value={p.id}>
                      {p.name} ({status})
                    </option>
                  );
                })}
            </select>
          </div>

          {/* Model Select */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--text-secondary)] flex items-center justify-between">
              <span>{t('genModel')}</span>
              {isCustomModel ? (
                <button
                  type="button"
                  onClick={() => setIsCustomModel(false)}
                  className="text-[10px] text-[var(--accent)] hover:underline cursor-pointer"
                >
                  {t('selectFromProvider')}
                </button>
              ) : (
                <button
                  type="button"
                  onClick={() => setIsCustomModel(true)}
                  className="text-[10px] text-[var(--accent)] hover:underline cursor-pointer"
                >
                  {t('customInput')}
                </button>
              )}
            </label>

            {!isCustomModel ? (
              <select
                value={config.model}
                onChange={(e) => handleModelSelect(e.target.value)}
                className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-all cursor-pointer"
              >
                {!config.model && (
                  <option value="" disabled>{t('pleaseSelectModel')}</option>
                )}
                {activeGroups.map((g) => (
                  <optgroup key={g.providerId} label={g.label}>
                    {g.models.map((m) => (
                      <option key={`${g.providerId}-${m.id}`} value={m.id}>
                        {m.name}
                      </option>
                    ))}
                  </optgroup>
                ))}
                <option value="custom">{t('customModelName')}</option>
              </select>
            ) : (
              <div className="flex gap-1.5">
                <input
                  type="text"
                  value={customModelInput || config.model}
                  onChange={(e) => {
                    setCustomModelInput(e.target.value);
                    setConfig({ model: e.target.value });
                  }}
                  placeholder={t('customModelPlaceholder')}
                  className="flex-1 px-2.5 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)]"
                />
              </div>
            )}
          </div>
        </div>

        {/* Live Credential Status Preview (Address hidden) */}
        <div className="p-2.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)]/70 flex flex-wrap items-center justify-between gap-2 text-[11px]">
          <div className="flex items-center gap-2 text-[var(--text-secondary)]">
            <span className="font-medium text-[var(--text-secondary)]">
              {resolved.providerName || t('matchedProvider')}
            </span>
          </div>
          <div className="flex items-center gap-1.5">
            {resolved.apiKey || resolved.isFree ? (
              <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400 font-medium text-[10px]">
                <FiCheckCircle size={11} />
                {t('credentialReady')}
              </span>
            ) : (
              <span className="inline-flex items-center gap-1 text-amber-500 font-medium text-[10px]">
                <FiAlertCircle size={11} />
                {t('missingApiKey')}
              </span>
            )}
          </div>
        </div>
      </div>

      {/* Default Aspect Ratio & Art Style Settings */}
      <div className="p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] space-y-3 shadow-2xs">
        <div className="flex items-center gap-2 pb-2 border-b border-[var(--border)]/60 text-[var(--text-primary)] font-medium">
          <FiSliders size={14} className="text-[var(--accent)]" />
          <span>{t('aspectRatioPref')}</span>
        </div>

        {/* Aspect Ratio Buttons */}
        <div className="space-y-1.5">
          <label className="text-[11px] font-medium text-[var(--text-secondary)]">
            {t('defaultAspectRatio')}
          </label>
          <div className="grid grid-cols-5 gap-1.5">
            {ASPECT_RATIOS.map((ratio) => {
              const active = config.aspectRatio === ratio.id;
              return (
                <button
                  key={ratio.id}
                  type="button"
                  onClick={() => setConfig({ aspectRatio: ratio.id as AspectRatio })}
                  className={`py-1.5 px-2 rounded-xl text-center border transition-all cursor-pointer ${
                    active
                      ? 'bg-[var(--accent)] text-white border-[var(--accent)] shadow-2xs font-medium'
                      : 'bg-[var(--bg-1)] text-[var(--text-secondary)] border-[var(--border)] hover:bg-[var(--bg-3)]'
                  }`}
                >
                  <div className="text-[11px] font-mono">{ratio.id}</div>
                  <div className={`text-[9px] truncate ${active ? 'text-white/80' : 'text-[var(--text-muted)]'}`}>
                    {ratio.label}
                  </div>
                </button>
              );
            })}
          </div>
        </div>

        {/* Quality, Style & Art Style Preset */}
        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2.5 pt-1">
          {/* Quality */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t('qualityLevel')}
            </label>
            <select
              value={config.quality || 'standard'}
              onChange={(e) => setConfig({ quality: e.target.value as ImageQuality })}
              className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-all cursor-pointer"
            >
              <option value="standard">{t('standardQuality')}</option>
              <option value="hd">{t('hdQuality')}</option>
            </select>
          </div>

          {/* Color Style */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t('colorStyle')}
            </label>
            <select
              value={config.style || 'vivid'}
              onChange={(e) => setConfig({ style: e.target.value as ImageStyle })}
              className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-all cursor-pointer"
            >
              <option value="vivid">{t('vividStyle')}</option>
              <option value="natural">{t('naturalStyle')}</option>
            </select>
          </div>

          {/* Art Style Preset */}
          <div className="space-y-1">
            <label className="text-[11px] font-medium text-[var(--text-secondary)]">
              {t('presetArtStyle')}
            </label>
            <select
              value={config.artStyleId || ''}
              onChange={(e) => setConfig({ artStyleId: e.target.value })}
              className="w-full px-2.5 py-1.5 rounded-xl bg-[var(--bg-1)] border border-[var(--border)] text-xs text-[var(--text-primary)] outline-none focus:border-[var(--accent)] transition-all cursor-pointer"
            >
              <option value="">{t('noPresetStyle')}</option>
              {ART_PRESET_STYLES.map((style) => (
                <option key={style.id} value={style.id}>
                  {style.name} ({style.nameEn})
                </option>
              ))}
            </select>
          </div>
        </div>
      </div>

      {/* How to use in Dialogue Tool Calling */}
      <div className="p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] space-y-2.5 shadow-2xs">
        <div className="flex items-center gap-2 text-[var(--text-primary)] font-medium">
          <SparklesIcon size={14} className="text-[var(--accent)]" />
          <span>{t('callInChat')}</span>
        </div>
        <p className="text-[11px] text-[var(--text-secondary)] leading-relaxed">
          {t('callInChatDesc')}
        </p>
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px]">
          <div className="p-2 rounded-xl bg-[var(--bg-1)] border border-[var(--border)]/70 text-[var(--text-secondary)] italic">
            {t('examplePrompt1')}
          </div>
          <div className="p-2 rounded-xl bg-[var(--bg-1)] border border-[var(--border)]/70 text-[var(--text-secondary)] italic">
            {t('examplePrompt2')}
          </div>
        </div>
        <p className="text-[10px] text-[var(--text-muted)]">
          {t('chatInputImageTip')}
        </p>
      </div>

      {/* Recent History Gallery preview */}
      {history.length > 0 && (
        <div className="p-3.5 rounded-2xl bg-[var(--bg-2)] border border-[var(--border)] space-y-2.5 shadow-2xs">
          <div className="flex items-center justify-between">
            <span className="font-medium text-[var(--text-primary)]">{t('recentGallery')} ({history.length})</span>
            <button
              onClick={() => {
                useImageGenStore.getState().setActiveTab('gallery');
                openModal();
              }}
              className="text-[11px] text-[var(--accent)] hover:underline flex items-center gap-1 cursor-pointer"
            >
              <span>{t('viewAllGallery')}</span>
              <FiExternalLink size={11} />
            </button>
          </div>
          <div className="grid grid-cols-3 sm:grid-cols-6 gap-2">
            {history.filter((item) => item.url).slice(0, 6).map((item) => (
              <div
                key={item.id}
                onClick={() => {
                  useImageGenStore.getState().selectHistoryItem(item);
                  openModal();
                }}
                className="group relative aspect-square rounded-xl overflow-hidden border border-[var(--border)] bg-[var(--bg-1)] hover:border-[var(--accent)] transition-all cursor-pointer shadow-2xs"
                title={item.prompt}
              >
                <img
                  src={item.url}
                  alt={item.prompt}
                  className="w-full h-full object-cover transition-transform group-hover:scale-105"
                  loading="lazy"
                />
                <div className="absolute inset-x-0 bottom-0 p-1 bg-gradient-to-t from-black/80 to-transparent opacity-0 group-hover:opacity-100 transition-opacity">
                  <p className="text-[9px] text-white truncate">{item.prompt}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
