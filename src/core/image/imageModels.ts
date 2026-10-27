/**
 * Image model capabilities — the layer that decides HOW a picture is asked for.
 *
 * ChatGPT does not speak "chat" to an image model: it calls the image API
 * directly, with the parameters that model understands (size, quality,
 * background, output format). Different image models accept different values,
 * so guessing one model's settings breaks the other. This module keeps that
 * knowledge in one table instead of scattering `includes('dall-e-3')` checks
 * across the codebase.
 */
import type { AspectRatio, ImageGenConfig, ImageQuality } from './types';
import { ASPECT_RATIOS, enrichPrompt } from './prompts';

export type ImageModelFamily = 'gpt-image' | 'dall-e-3' | 'dall-e-2' | 'generic';

/**
 * gpt-image (gpt-image-1 / 1.5) accepts exactly three sizes. 16:9 and 4:3
 * therefore map onto the wide 3:2 canvas, 9:16 and 3:4 onto the tall one —
 * the same choice ChatGPT makes when it renders a 16:9 request.
 */
const GPT_IMAGE_SIZES: Record<AspectRatio, string> = {
  '1:1': '1024x1024',
  '16:9': '1536x1024',
  '9:16': '1024x1536',
  '4:3': '1536x1024',
  '3:4': '1024x1536',
};

export const GPT_IMAGE_QUALITIES: ImageQuality[] = ['auto', 'low', 'medium', 'high'];
export const DALL_E_QUALITIES: ImageQuality[] = ['standard', 'hd'];

/** Which family a model id belongs to. Unknown ids fall back to 'generic'. */
export function detectImageModelFamily(model: string): ImageModelFamily {
  const id = (model || '').toLowerCase();
  if (id.includes('gpt-image')) return 'gpt-image';
  if (/dall-?e-3/.test(id)) return 'dall-e-3';
  if (/dall-?e-2/.test(id)) return 'dall-e-2';
  return 'generic';
}

/** True for models that expose a dedicated /v1/images/generations endpoint. */
export function supportsNativeImageApi(model: string): boolean {
  const family = detectImageModelFamily(model);
  return family === 'gpt-image' || family === 'dall-e-3' || family === 'dall-e-2';
}

/** The pixel size a given model renders for the requested aspect ratio. */
export function resolveImageSizeForFamily(family: ImageModelFamily, aspectRatio: AspectRatio): string {
  const match = ASPECT_RATIOS.find((a) => a.id === aspectRatio) || ASPECT_RATIOS[0];
  switch (family) {
    case 'gpt-image':
      return GPT_IMAGE_SIZES[aspectRatio] || match.resolution;
    case 'dall-e-3':
      return match.dalleResolution;
    case 'dall-e-2':
      // DALL-E 2 is square-only.
      return '1024x1024';
    default:
      return match.resolution;
  }
}

/** Quality values the UI should offer for this model. */
export function qualityOptionsFor(family: ImageModelFamily): ImageQuality[] {
  if (family === 'gpt-image') return GPT_IMAGE_QUALITIES;
  if (family === 'dall-e-3') return DALL_E_QUALITIES;
  return [];
}

/** Only DALL-E 3 understands the vivid/natural colour style switch. */
export function supportsColorStyle(family: ImageModelFamily): boolean {
  return family === 'dall-e-3';
}

/**
 * Negative prompts are a Stable-Diffusion/FLUX concept. DALL-E and gpt-image
 * have no such parameter — the negative meaning has to live in the prompt.
 */
export function supportsNegativePrompt(family: ImageModelFamily): boolean {
  return family === 'generic';
}

/** Map our UI quality onto the vocabulary a given model accepts. */
export function mapQualityForFamily(family: ImageModelFamily, quality?: ImageQuality): string | undefined {
  if (family === 'gpt-image') {
    if (!quality) return 'auto';
    if (quality === 'standard') return 'medium';
    if (quality === 'hd') return 'high';
    return quality;
  }
  if (family === 'dall-e-3') {
    if (!quality) return undefined;
    return quality === 'hd' ? 'hd' : 'standard';
  }
  return undefined;
}

/**
 * Build the body for POST /v1/images/generations.
 *
 * Only the parameters the target model actually accepts are included — sending
 * an unknown field is the fastest way to get a 400 from a strict endpoint.
 */
export function buildImagesApiBody(prompt: string, config: ImageGenConfig) {
  const family = detectImageModelFamily(config.model);
  const finalPrompt = config.artStyleId ? enrichPrompt(prompt, config.artStyleId) : prompt;
  const size = resolveImageSizeForFamily(family, config.aspectRatio);

  const body: Record<string, any> = {
    model: config.model,
    prompt: finalPrompt,
    n: 1,
    size,
  };

  if (family === 'gpt-image') {
    body.quality = mapQualityForFamily(family, config.quality);
    body.output_format = 'png';
    if (config.background === 'transparent') body.background = 'transparent';
  } else if (family === 'dall-e-3') {
    const quality = mapQualityForFamily(family, config.quality);
    if (quality) body.quality = quality;
    if (config.style) body.style = config.style;
    body.response_format = 'b64_json';
  } else if (family === 'dall-e-2') {
    body.response_format = 'b64_json';
  } else if (config.negativePrompt?.trim()) {
    // Generic endpoints (FLUX / SD style) take a real negative_prompt field;
    // for the families above the negative meaning is folded into the prompt.
    body.negative_prompt = config.negativePrompt.trim();
  }

  return { body, finalPrompt, size, family };
}
