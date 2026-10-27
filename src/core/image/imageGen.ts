import { v4 as uuidv4 } from 'uuid';
import type { AspectRatio, GenerateImageRequest, GeneratedImage, ImageGenConfig } from './types';
import { ASPECT_RATIOS, enrichPrompt } from './prompts';
import {
  buildImagesApiBody,
  detectImageModelFamily,
  mapQualityForFamily,
  resolveImageSizeForFamily,
  supportsNativeImageApi,
} from './imageModels';
import { FREE_PROVIDER_ID, FREE_PROVIDER } from '../providers/free.adapter';

/** Strip anything that looks like a provider address out of an error. */
export function sanitizeProviderError(message: string): string {
  return message
    .replace(/https?:\/\/\S+/gi, '[服务地址已隐藏]')
    .replace(/\b[a-z0-9-]+\.(?:com|cn|net|org|io|cc|ai|dev|app)\b\S*/gi, '[服务地址已隐藏]')
    .trim();
}

/**
 * Normalize a provider base URL to its API root, e.g.
 * "https://api.openai.com/v1/chat/completions" -> "https://api.openai.com/v1".
 */
function resolveApiRoot(baseUrl: string): string {
  let base = (baseUrl || '').trim().replace(/\/+$/, '');
  if (!base) base = FREE_PROVIDER.baseUrl;
  base = base.replace(/\/(?:chat\/completions|images\/generations)$/, '');
  if (base.endsWith('/v1')) return base;
  return `${base}/v1`;
}

export function resolveImageEndpoint(baseUrl: string): string {
  return `${resolveApiRoot(baseUrl)}/chat/completions`;
}

/** The dedicated image endpoint used by OpenAI-compatible image models. */
export function resolveImagesApiEndpoint(baseUrl: string): string {
  return `${resolveApiRoot(baseUrl)}/images/generations`;
}

export function resolveImageResolution(aspectRatio: AspectRatio, model: string): string {
  return resolveImageSizeForFamily(detectImageModelFamily(model), aspectRatio);
}

/**
 * Body for the chat-completions path. This is how image models that are
 * exposed as chat models (relayed image models, multimodal chat endpoints)
 * are reached: they answer a normal chat request and put the picture in the
 * reply.
 */
export function buildChatImageRequestBody(
  prompt: string,
  config: ImageGenConfig,
) {
  const model = config.model || '';
  const finalPrompt = config.artStyleId ? enrichPrompt(prompt, config.artStyleId) : prompt;

  const promptDetails: string[] = [finalPrompt];
  if (config.aspectRatio) {
    promptDetails.push(`比例: ${config.aspectRatio}`);
  }
  if (config.negativePrompt?.trim()) {
    promptDetails.push(`负向提示词: ${config.negativePrompt.trim()}`);
  }

  const promptText = promptDetails.join(', ');

  const body: Record<string, any> = {
    model,
    messages: [
      {
        role: 'user',
        content: `请生成图像：${promptText}`,
      },
    ],
    stream: false,
  };

  return { body, finalPrompt };
}

/**
 * Body for POST /v1/images/generations. Kept as a thin wrapper so the
 * response_format stays overridable for DALL-E, which is the only family
 * that accepts it.
 */
export function buildImageRequestBody(
  prompt: string,
  config: ImageGenConfig,
  responseFormat: 'b64_json' | 'url' = 'b64_json',
) {
  const { body, finalPrompt, size, family } = buildImagesApiBody(prompt, config);
  if (family === 'gpt-image') {
    // gpt-image always answers with base64 and rejects response_format.
    delete body.response_format;
  } else if (responseFormat) {
    body.response_format = responseFormat;
  }
  return { body, finalPrompt, size, family };
}

export function extractImageUrlFromContent(content: string): string | null {
  if (!content || typeof content !== 'string') return null;

  // 1. Direct base64 image data URI
  const dataUriMatch = content.match(/data:image\/(?:png|jpeg|webp|gif|svg\+xml);base64,[A-Za-z0-9+/=]+/);
  if (dataUriMatch) return dataUriMatch[0];

  // 2. Direct SVG xml block. Encoded as base64 so the result passes
  // isSafeImageUrl (which only accepts base64 data URLs) and saveImageToDisk's
  // base64 stripping — a URL-encoded data URL would be rejected as unsafe and
  // saved as a corrupt file.
  const svgMatch = content.match(/<svg[\s\S]*?<\/svg>/i);
  if (svgMatch) {
    const bytes = new TextEncoder().encode(svgMatch[0]);
    let binary = '';
    for (const b of bytes) binary += String.fromCharCode(b);
    return `data:image/svg+xml;base64,${btoa(binary)}`;
  }

  // 3. Markdown image syntax: ![alt](url)
  const mdMatch = content.match(/!\[.*?\]\((https?:\/\/[^\s\)]+)\)/);
  if (mdMatch) return mdMatch[1];

  // 4. HTML img tag: <img src="url" ...>
  const htmlMatch = content.match(/<img[^>]+src=["'](https?:\/\/[^"']+)["']/i);
  if (htmlMatch) return htmlMatch[1];

  // 5. Parentheses / brackets containing direct image URL: (http...png)
  const parenMatch = content.match(/[\(\[]\s*(https?:\/\/[^\s\(\)\]]+\.(?:png|jpg|jpeg|webp|gif|svg)(?:\?[^\s\(\)\]]*)?)\s*[\)\]]/i);
  if (parenMatch) return parenMatch[1];

  // 6. Direct HTTP URL ending in image extension
  const directImgMatch = content.match(/https?:\/\/[^\s"']+\.(?:png|jpg|jpeg|webp|gif|svg)(?:\?[^\s"']*)?/i);
  if (directImgMatch) return directImgMatch[0];

  // 7. General HTTP/HTTPS URL
  const anyUrlMatch = content.match(/https?:\/\/[^\s"'\<\>]+/);
  if (anyUrlMatch) return anyUrlMatch[0];

  return null;
}

export function extractImageUrl(data: any): string | null {
  if (!data) return null;

  // choices[0].message
  const choice = data.choices?.[0];
  if (choice) {
    const msg = choice.message || choice;
    if (typeof msg.image === 'string' && msg.image) return msg.image;
    if (typeof msg.image_url === 'string' && msg.image_url) return msg.image_url;
    if (Array.isArray(msg.images) && msg.images[0]) {
      const img = msg.images[0];
      if (typeof img === 'string') return img;
      if (typeof img?.url === 'string') return img.url;
    }

    const content = msg.content;
    if (typeof content === 'string') {
      const extracted = extractImageUrlFromContent(content);
      if (extracted) return extracted;
    }
  }

  // data[0].b64_json or url
  if (Array.isArray(data.data) && data.data[0]) {
    if (data.data[0].b64_json) {
      return `data:image/png;base64,${data.data[0].b64_json}`;
    }
    if (data.data[0].url) {
      return data.data[0].url;
    }
  }

  if (typeof data.url === 'string') return data.url;
  if (typeof data.image_url === 'string') return data.image_url;

  return null;
}

export interface ImageGenerationOptions {
  /**
   * Called with every partial preview the provider streams while the picture
   * is being drawn. This is what makes the wait feel like ChatGPT's: you
   * watch the image appear instead of staring at a spinner.
   */
  onPartial?: (dataUrl: string) => void;
}

function toDataUrl(b64: string): string {
  return `data:image/png;base64,${b64}`;
}

/** Parse the SSE stream of a streaming images request. */
async function readImageStream(
  res: Response,
  onPartial?: (dataUrl: string) => void,
): Promise<string | null> {
  const reader = res.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let pending = '';
  let finalUrl: string | null = null;

  const handle = (line: string) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith('data:')) return;
    const data = trimmed.slice(5).trim();
    if (!data || data === '[DONE]') return;
    let parsed: any;
    try {
      parsed = JSON.parse(data);
    } catch {
      return;
    }
    const b64 = parsed?.b64_json || parsed?.partial_image?.b64_json || parsed?.image?.b64_json;
    if (!b64) return;
    const type = String(parsed?.type || '');
    if (type.includes('partial')) {
      onPartial?.(toDataUrl(b64));
    } else {
      finalUrl = toDataUrl(b64);
    }
  };

  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      pending += decoder.decode(value, { stream: true });
      const lines = pending.split('\n');
      pending = lines.pop() || '';
      for (const line of lines) handle(line);
    }
    pending += decoder.decode();
    if (pending.trim()) handle(pending);
  } finally {
    try { reader.releaseLock(); } catch { /* already released */ }
  }
  return finalUrl;
}

/** Turn a provider error response into a message that leaks no address. */
async function readProviderError(res: Response): Promise<string> {
  let detail = '';
  try {
    const text = await res.text();
    try {
      const json = JSON.parse(text);
      detail = json?.error?.message || json?.message || json?.error || '';
      if (typeof detail !== 'string') detail = '';
    } catch {
      detail = text.slice(0, 300);
    }
  } catch { /* body already consumed */ }
  const safe = sanitizeProviderError(detail);
  return safe ? `生成失败 (HTTP ${res.status}): ${safe}` : `生成失败 (HTTP ${res.status})`;
}

async function toDisplayableUrl(rawUrl: string): Promise<string> {
  if (!rawUrl.startsWith('http')) return rawUrl;
  // A remote picture is downloaded once and kept inline, so the artwork still
  // shows up when the provider's link expires.
  try {
    const blobRes = await fetch(rawUrl);
    if (blobRes.ok) {
      const blob = await blobRes.blob();
      const reader = new FileReader();
      return await new Promise<string>((resolve) => {
        reader.onloadend = () => resolve((reader.result as string) || rawUrl);
        reader.onerror = () => resolve(rawUrl);
        reader.readAsDataURL(blob);
      });
    }
  } catch {
    // Retain the original URL if the download fails.
  }
  return rawUrl;
}

function buildResult(
  url: string,
  prompt: string,
  config: ImageGenConfig,
  revisedPrompt?: string,
): GeneratedImage {
  return {
    id: uuidv4(),
    url,
    prompt,
    revisedPrompt,
    model: config.model,
    aspectRatio: config.aspectRatio,
    size: resolveImageResolution(config.aspectRatio, config.model),
    quality: config.quality,
    style: config.style,
    artStyleId: config.artStyleId,
    createdAt: Date.now(),
  };
}

/** Request the picture through the dedicated images endpoint. */
async function requestViaImagesApi(
  prompt: string,
  config: ImageGenConfig,
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal | undefined,
  options: ImageGenerationOptions,
): Promise<GeneratedImage> {
  const endpoint = resolveImagesApiEndpoint(baseUrl);
  const { body, finalPrompt } = buildImagesApiBody(prompt, config);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
  };

  const post = (payload: Record<string, any>) => fetch(endpoint, {
    method: 'POST',
    headers,
    body: JSON.stringify(payload),
    signal,
  });

  let res: Response;
  try {
    // A streaming request shows partial previews; providers that do not
    // support it answer with a normal JSON body, which is handled below.
    res = await post({ ...body, stream: true, partial_images: 1 });
  } catch (err: any) {
    if (err.name === 'AbortError') throw new Error('图片生成已取消');
    throw new Error(`网络请求失败: ${sanitizeProviderError(err.message || '无法连接至图像生成服务')}`);
  }

  if (!res.ok) {
    if (res.status === 404 || res.status === 405 || res.status === 501) {
      // This provider has no images endpoint — the caller falls back to chat.
      throw new Error('__IMAGE_API_UNSUPPORTED__');
    }
    throw new Error(await readProviderError(res));
  }

  const contentType = res.headers?.get?.('content-type') || '';
  if (contentType.includes('text/event-stream')) {
    const streamed = await readImageStream(res, options.onPartial);
    if (streamed) {
      return buildResult(await toDisplayableUrl(streamed), finalPrompt, config);
    }
    // The stream ended without a final image — ask once more, unstreamed.
    res = await post(body);
    if (!res.ok) throw new Error(await readProviderError(res));
  }

  const data = await res.json();
  const rawUrl = extractImageUrl(data);
  if (!rawUrl) {
    const snippet = data?.choices?.[0]?.message?.content?.slice(0, 100) || '';
    throw new Error(
      snippet
        ? `模型未返回有效图像链接。模型回复: "${sanitizeProviderError(snippet)}"`
        : 'API 返回的数据为空，未检测到生成的图片',
    );
  }
  const revised = data?.data?.[0]?.revised_prompt;
  return buildResult(await toDisplayableUrl(rawUrl), finalPrompt, config, revised);
}

/** Request the picture through a chat completion (relayed image models). */
async function requestViaChatApi(
  prompt: string,
  config: ImageGenConfig,
  apiKey: string,
  baseUrl: string,
  signal: AbortSignal | undefined,
): Promise<GeneratedImage> {
  const endpoint = resolveImageEndpoint(baseUrl);
  const { body: chatBody, finalPrompt } = buildChatImageRequestBody(prompt, config);

  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(apiKey.trim() ? { Authorization: `Bearer ${apiKey.trim()}` } : {}),
  };

  let res: Response;
  try {
    res = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify(chatBody),
      signal,
    });
  } catch (err: any) {
    if (err.name === 'AbortError') {
      throw new Error('图片生成已取消');
    }
    throw new Error(`网络请求失败: ${sanitizeProviderError(err.message || '无法连接至图像生成服务')}`);
  }

  if (!res.ok) {
    throw new Error(await readProviderError(res));
  }

  const data = await res.json();
  const rawUrl = extractImageUrl(data);

  if (!rawUrl) {
    const textSnippet = data?.choices?.[0]?.message?.content?.slice(0, 100) || '';
    throw new Error(
      textSnippet
        ? `模型未返回有效图像链接。模型回复: "${sanitizeProviderError(textSnippet)}"`
        : 'API 返回的数据为空，未检测到生成的图片',
    );
  }

  return buildResult(await toDisplayableUrl(rawUrl), finalPrompt, config);
}

/**
 * Generate one picture.
 *
 * The route follows the model, not a fixed guess: models that expose a real
 * image API are called on it (with the parameters they accept, and with
 * partial previews while they draw), and everything else is reached through a
 * chat completion. A provider without an image endpoint is not an error — the
 * chat route covers it.
 */
export async function requestImageGeneration(
  request: GenerateImageRequest,
  apiKey: string,
  baseUrl: string,
  options: ImageGenerationOptions = {},
): Promise<GeneratedImage> {
  const { prompt, config, signal } = request;
  if (!prompt.trim()) {
    throw new Error('请输入生成图片的提示词 (Prompt)');
  }
  const isFreeEndpoint = baseUrl.includes('conellm.cc.cd') || baseUrl === FREE_PROVIDER.baseUrl;
  if (!apiKey.trim() && !isFreeEndpoint) {
    throw new Error('未配置 API Key。请在设置中配置或输入有效的 API 密钥');
  }

  if (supportsNativeImageApi(config.model)) {
    try {
      return await requestViaImagesApi(prompt, config, apiKey, baseUrl, signal, options);
    } catch (err: any) {
      if (err?.message !== '__IMAGE_API_UNSUPPORTED__') throw err;
    }
  }

  return requestViaChatApi(prompt, config, apiKey, baseUrl, signal);
}

/**
 * Save an image to local disk via Electron dialog or browser download
 */
export async function saveImageToDisk(url: string, defaultFilename?: string): Promise<boolean> {
  const filename = defaultFilename || `conecode-art-${Date.now()}.png`;

  // Electron native dialog & file write
  if (window.electronAPI?.dialog?.saveFile && window.electronAPI?.fs?.writeFileBase64) {
    try {
      const targetPath = await window.electronAPI.dialog.saveFile(filename);
      if (!targetPath) return false;

      let base64Data = '';
      // [\w+.-]+ covers subtypes like svg+xml that \w alone truncates. The
      // ;base64, check keeps non-base64 data URLs on the fetch path instead of
      // writing the whole URL out as if it were file content.
      if (url.startsWith('data:image/') && url.includes(';base64,')) {
        base64Data = url.replace(/^data:image\/[\w+.-]+;base64,/, '');
      } else {
        const res = await fetch(url);
        const buffer = await res.arrayBuffer();
        base64Data = btoa(
          new Uint8Array(buffer).reduce((data, byte) => data + String.fromCharCode(byte), ''),
        );
      }

      await window.electronAPI.fs.writeFileBase64(targetPath, base64Data);
      return true;
    } catch (e) {
      console.error('Failed to save file via electron:', e);
    }
  }

  // Fallback to web download anchor
  try {
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    return true;
  } catch (err) {
    console.error('Failed to trigger web download:', err);
    return false;
  }
}

/**
 * Copy image data to clipboard
 */
export async function copyImageToClipboard(url: string): Promise<boolean> {
  try {
    // If browser supports ClipboardItem with image/png
    if (typeof ClipboardItem !== 'undefined' && navigator.clipboard?.write) {
      const blob = await fetch(url).then((r) => r.blob());
      // Ensure PNG format for clipboard compatibility
      if (blob.type === 'image/png') {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
        return true;
      }

      // Convert to png using canvas
      const img = new Image();
      img.crossOrigin = 'anonymous';
      await new Promise((res, rej) => {
        img.onload = res;
        img.onerror = rej;
        img.src = url;
      });

      const canvas = document.createElement('canvas');
      canvas.width = img.naturalWidth;
      canvas.height = img.naturalHeight;
      const ctx = canvas.getContext('2d');
      if (ctx) {
        ctx.drawImage(img, 0, 0);
        const pngBlob = await new Promise<Blob | null>((res) => canvas.toBlob(res, 'image/png'));
        if (pngBlob) {
          await navigator.clipboard.write([new ClipboardItem({ 'image/png': pngBlob })]);
          return true;
        }
      }
    }

    // Fallback: copy image URL/data to clipboard as text
    await navigator.clipboard.writeText(url);
    return true;
  } catch (e) {
    console.warn('Could not copy image binary, falling back to copying link/text:', e);
    try {
      await navigator.clipboard.writeText(url);
      return true;
    } catch {
      return false;
    }
  }
}

export interface ImageModelOption {
  id: string;
  name: string;
  providerId: string;
  providerName: string;
  isFree?: boolean;
}

export interface ImageModelGroup {
  label: string;
  providerId: string;
  isFree?: boolean;
  models: ImageModelOption[];
}

/**
 * Retrieve strictly available image models:
 * 1. ConeCode Free (官方免费) models
 * 2. User configured providers' pulled models or default models
 * Never injects hardcoded third-party model lists.
 */
export function getAvailableImageModels(
  providers: { id: string; name: string; defaultModel?: string; enabled?: boolean }[],
  modelsMap?: Map<string, { id: string; name: string; providerId?: string }[]> | Record<string, { id: string; name: string; providerId?: string }[]>,
): ImageModelGroup[] {
  const groups: ImageModelGroup[] = [];

  const getModelsForProvider = (pId: string): { id: string; name: string; providerId?: string }[] => {
    if (!modelsMap) return [];
    if (modelsMap instanceof Map) {
      return modelsMap.get(pId) || [];
    }
    return (modelsMap as Record<string, any[]>)[pId] || [];
  };

  // 1. ConeCode Free (官方免费)
  const freeLabel = 'ConeCode Free (官方免费)';
  const freeModels = getModelsForProvider(FREE_PROVIDER_ID);
  if (freeModels.length > 0) {
    groups.push({
      label: freeLabel,
      providerId: FREE_PROVIDER_ID,
      isFree: true,
      models: freeModels.map((m) => ({
        id: m.id,
        name: m.name || m.id,
        providerId: FREE_PROVIDER_ID,
        providerName: freeLabel,
        isFree: true,
      })),
    });
  }

  // 2. User configured providers
  for (const p of providers) {
    if (p.id === FREE_PROVIDER_ID || p.enabled === false) continue;
    const pModels = getModelsForProvider(p.id);
    const items: ImageModelOption[] = pModels.map((m) => ({
      id: m.id,
      name: m.name || m.id,
      providerId: p.id,
      providerName: p.name,
    }));

    // If provider has defaultModel but no fetched models in map, include defaultModel
    if (items.length === 0 && p.defaultModel) {
      items.push({
        id: p.defaultModel,
        name: p.defaultModel,
        providerId: p.id,
        providerName: p.name,
      });
    }

    if (items.length > 0) {
      groups.push({
        label: p.name,
        providerId: p.id,
        models: items,
      });
    }
  }

  return groups;
}

/**
 * Resolve API credentials and endpoint from software's configured providers.
 * Directly reuses the models and credentials saved in the software, so the user
 * never has to enter their API key or endpoint a second time.
 * If provider is ConeCode Free, credentials require no API key.
 */
export function resolveImageGenCredentials(
  config: ImageGenConfig,
  providers: { id: string; name: string; type: string; baseUrl: string; apiKey: string; defaultModel?: string; enabled?: boolean }[],
): {
  apiKey: string;
  baseUrl: string;
  model: string;
  providerName?: string;
  isFree?: boolean;
} {
  let apiKey = '';
  let baseUrl = '';
  let model = config.model || '';
  let providerName = '';
  let isFree = false;

  if (config.providerId === FREE_PROVIDER_ID) {
    baseUrl = FREE_PROVIDER.baseUrl;
    apiKey = '';
    model = config.model || '';
    providerName = 'ConeCode Free';
    isFree = true;
  } else if (config.providerId === 'custom') {
    apiKey = config.customApiKey;
    baseUrl = config.customBaseUrl || 'https://api.openai.com/v1';
    providerName = '自定义端点';
  } else if (config.providerId && config.providerId !== 'auto') {
    const matched = providers.find((p) => p.id === config.providerId);
    if (matched) {
      apiKey = matched.apiKey;
      baseUrl = matched.baseUrl;
      model = config.model || matched.defaultModel || '';
      providerName = matched.name;
    }
  } else {
    // Auto: prioritize OpenAI, Custom, or OpenRouter user providers with an API key
    const matched = providers.find(
      (p) => p.enabled !== false && p.apiKey && (p.type === 'openai' || p.type === 'custom' || p.type === 'openrouter'),
    ) || providers.find((p) => p.enabled !== false && p.apiKey);

    if (matched) {
      apiKey = matched.apiKey;
      baseUrl = matched.baseUrl;
      model = config.model || matched.defaultModel || '';
      providerName = matched.name;
    } else if (config.customApiKey) {
      apiKey = config.customApiKey;
      baseUrl = config.customBaseUrl || 'https://api.openai.com/v1';
      providerName = '自定义端点';
    } else {
      // Fallback to Free provider if no user keys configured
      baseUrl = FREE_PROVIDER.baseUrl;
      apiKey = '';
      providerName = 'ConeCode Free';
      isFree = true;
    }
  }

  return { apiKey, baseUrl, model, providerName, isFree };
}

export { detectImageModelFamily, mapQualityForFamily, resolveImageSizeForFamily, supportsNativeImageApi };
