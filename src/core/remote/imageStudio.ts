import { useChatStore } from '../../stores/chat.store';
import { useImageGenStore } from '../../stores/imageGen.store';
import { useModelStore } from '../../stores/model.store';
import { usePluginStore } from '../../stores/plugin.store';
import { useProviderStore } from '../../stores/provider.store';
import { getAvailableImageModels, sanitizeProviderError } from '../image/imageGen';
import { DALL_E_QUALITIES, GPT_IMAGE_QUALITIES } from '../image/imageModels';
import { ART_PRESET_STYLES, ASPECT_RATIOS, enrichPrompt } from '../image/prompts';
import type { GeneratedImage, ImageGenConfig } from '../image/types';

const PART_SIZE = 256_000;
const IMAGE_LIMIT = 24_000_000;
const RATIOS = ASPECT_RATIOS.map(({ id }) => id);
const QUALITIES = [...DALL_E_QUALITIES, ...GPT_IMAGE_QUALITIES];
const ok = { ok: true };
const fail = (error: string) => ({ ok: false, error });

function imageInfo(image: GeneratedImage) {
  const { id, prompt, revisedPrompt, model, aspectRatio, size, createdAt, url } = image;
  return { id, prompt, revisedPrompt, model, aspectRatio, size, createdAt, available: Boolean(url) };
}

function studioState() {
  const studio = useImageGenStore.getState();
  const { providerId, model, aspectRatio, quality, style, artStyleId, negativePrompt, background } = studio.config;
  return {
    ...ok,
    enabled: !usePluginStore.getState().disabled.includes('image-gen'),
    config: { providerId, model, aspectRatio, quality, style, artStyleId, negativePrompt, background },
    prompt: studio.prompt,
    running: studio.isGenerating,
    progress: studio.progressStep,
    error: studio.error ? sanitizeProviderError(studio.error) : null,
    selected: studio.currentResult ? imageInfo(studio.currentResult) : null,
    gallery: studio.history.map(imageInfo),
    models: getAvailableImageModels(useProviderStore.getState().providers, useModelStore.getState().models),
    presets: ART_PRESET_STYLES.map(({ id, name, nameEn }) => ({ id, name, nameEn })),
  };
}

function choice<T extends string>(values: readonly T[], value: unknown): value is T {
  return values.some((item) => item === value);
}

export async function remoteImageStudio(cmd: Record<string, unknown>) {
  const studio = useImageGenStore.getState();
  if (cmd.action === 'state') return studioState();
  if (usePluginStore.getState().disabled.includes('image-gen')) return fail('Image Studio is disabled');

  const image = studio.history.find(({ id }) => id === cmd.id)
    ?? (studio.currentResult?.id === cmd.id ? studio.currentResult : null);
  switch (cmd.action) {
    case 'generate': {
      if (studio.isGenerating) return fail('An image is already being generated');
      if (typeof cmd.prompt !== 'string' || !cmd.prompt.trim() || cmd.prompt.length > 20_000) return fail('Invalid image prompt');
      const patch: Partial<ImageGenConfig> = {};
      if (choice(RATIOS, cmd.aspectRatio)) patch.aspectRatio = cmd.aspectRatio;
      if (choice(QUALITIES, cmd.quality)) patch.quality = cmd.quality;
      if (choice(['vivid', 'natural'], cmd.style)) patch.style = cmd.style;
      if (choice(['auto', 'opaque', 'transparent'], cmd.background)) patch.background = cmd.background;
      if (typeof cmd.negativePrompt === 'string' && cmd.negativePrompt.length <= 6_000) patch.negativePrompt = cmd.negativePrompt;
      if (cmd.artStyleId === '' || ART_PRESET_STYLES.some(({ id }) => id === cmd.artStyleId)) patch.artStyleId = cmd.artStyleId as string;
      const groups = studioState().models;
      if (cmd.providerId === 'auto' || cmd.providerId === studio.config.providerId || groups.some(({ providerId }) => providerId === cmd.providerId)) {
        patch.providerId = cmd.providerId as string;
      }
      if (typeof cmd.model === 'string' && cmd.model.length <= 250) patch.model = cmd.model;
      studio.setConfig(patch);
      studio.setPrompt(cmd.prompt);
      void studio.generate();
      return studioState();
    }
    case 'random':
      studio.randomizePrompt();
      return studioState();
    case 'enhance':
      if (typeof cmd.prompt !== 'string' || !cmd.prompt.trim() || cmd.prompt.length > 20_000) return fail('Invalid image prompt');
      studio.setPrompt(enrichPrompt(cmd.prompt, typeof cmd.artStyleId === 'string' ? cmd.artStyleId : undefined));
      return studioState();
    case 'clearGallery':
      studio.clearHistory();
      return studioState();
    case 'cancel':
      studio.cancelGeneration();
      return studioState();
    case 'insert': {
      if (!image?.url) return fail('The image is unavailable');
      const chat = useChatStore.getState();
      if (chat.activeConversationId !== (cmd.conversationId || null) || chat.isStreaming || studio.isGenerating) {
        return fail('Conversation or studio is busy');
      }
      studio.clearError();
      await studio.insertToChat(image);
      return useImageGenStore.getState().error ? fail('Could not insert image') : ok;
    }
    case 'read': {
      if (!image?.url) return fail('The image is unavailable');
      if (/^https:\/\/[^\s]+$/i.test(image.url) && image.url.length <= 8192) return { ...ok, url: image.url };
      const url = image.url;
      const header = /^data:image\/(?:png|jpeg|webp|gif);base64,/.exec(url)?.[0];
      const offset = cmd.offset;
      if (!header || url.length > IMAGE_LIMIT || typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0) {
        return fail('Image format or size cannot be displayed on this phone');
      }
      const start = header.length + offset;
      return { ...ok, mime: header.slice(5, -8), data: url.slice(start, start + PART_SIZE), total: url.length - header.length };
    }
    default:
      return fail('Unknown image action');
  }
}
