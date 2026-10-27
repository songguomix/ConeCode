export type AspectRatio = '1:1' | '16:9' | '9:16' | '4:3' | '3:4';
/**
 * Quality vocabulary differs per model family: DALL-E 3 speaks standard/hd,
 * gpt-image speaks auto/low/medium/high. The UI only offers what the
 * selected model understands.
 */
export type ImageQuality = 'standard' | 'hd' | 'auto' | 'low' | 'medium' | 'high';
export type ImageStyle = 'vivid' | 'natural';
/** Transparent background is only meaningful for gpt-image. */
export type ImageBackground = 'auto' | 'opaque' | 'transparent';

export interface ArtPresetStyle {
  id: string;
  name: string;
  nameEn: string;
  description: string;
  promptSuffix: string;
  negativePrompt?: string;
  badgeColor?: string;
}

export interface ImageModelOption {
  id: string;
  name: string;
  provider: 'openai' | 'siliconflow' | 'together' | 'custom' | 'gemini';
  description: string;
  supportsQuality?: boolean;
  supportsStyle?: boolean;
  supportsNegativePrompt?: boolean;
  defaultAspectRatio?: AspectRatio;
}

export interface ImageGenConfig {
  providerId: string; // 'auto' | configured provider ID | 'custom'
  customBaseUrl: string;
  customApiKey: string;
  model: string;
  aspectRatio: AspectRatio;
  quality: ImageQuality;
  style: ImageStyle;
  artStyleId: string; // selected preset style ID or ''
  negativePrompt: string;
  /** 'transparent' asks the model for a cut-out background (gpt-image only). */
  background: ImageBackground;
}

export interface GeneratedImage {
  id: string;
  url: string; // base64 dataUrl or remote https URL
  prompt: string;
  revisedPrompt?: string;
  model: string;
  aspectRatio: AspectRatio;
  size: string;
  quality?: ImageQuality;
  style?: ImageStyle;
  artStyleId?: string;
  createdAt: number;
}

export interface GenerateImageRequest {
  prompt: string;
  config: ImageGenConfig;
  signal?: AbortSignal;
}
