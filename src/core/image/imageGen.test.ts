import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  resolveImageEndpoint,
  resolveImageResolution,
  buildImageRequestBody,
  requestImageGeneration,
  resolveImageGenCredentials,
  getAvailableImageModels,
  extractImageUrlFromContent,
} from './imageGen';
import { enrichPrompt } from './prompts';
import { FREE_PROVIDER_ID, FREE_PROVIDER } from '../providers/free.adapter';
import { isSafeImageUrl } from '../markdown/markdown';
import type { ImageGenConfig } from './types';

describe('imageGen core', () => {
  const defaultConfig: ImageGenConfig = {
    providerId: 'auto',
    customBaseUrl: 'https://api.openai.com/v1',
    customApiKey: 'sk-test-123456',
    model: 'dall-e-3',
    aspectRatio: '1:1',
    quality: 'standard',
    style: 'vivid',
    artStyleId: '',
    negativePrompt: '',
    background: 'auto',
  };

  describe('resolveImageEndpoint', () => {
    it('appends /chat/completions to standard baseUrl with v1', () => {
      expect(resolveImageEndpoint('https://api.openai.com/v1')).toBe(
        'https://api.openai.com/v1/chat/completions',
      );
    });

    it('adds /v1/chat/completions when v1 is missing', () => {
      expect(resolveImageEndpoint('https://api.openai.com')).toBe(
        'https://api.openai.com/v1/chat/completions',
      );
    });

    it('normalizes legacy /images/generations to /chat/completions', () => {
      expect(resolveImageEndpoint('https://my-proxy.com/api/v1/images/generations')).toBe(
        'https://my-proxy.com/api/v1/chat/completions',
      );
    });

    it('defaults to conecode free /v1/chat/completions endpoint if empty', () => {
      expect(resolveImageEndpoint('')).toBe(
        'https://conellm.cc.cd/v1/chat/completions',
      );
    });
  });

  describe('resolveImageResolution', () => {
    it('returns DALL-E 3 1:1 resolution', () => {
      expect(resolveImageResolution('1:1', 'dall-e-3')).toBe('1024x1024');
    });

    it('returns DALL-E 3 16:9 resolution', () => {
      expect(resolveImageResolution('16:9', 'dall-e-3')).toBe('1792x1024');
    });

    it('returns DALL-E 3 9:16 resolution', () => {
      expect(resolveImageResolution('9:16', 'dall-e-3')).toBe('1024x1792');
    });

    it('maps 4:3 to 1792x1024 on DALL-E 3 and 1024x768 on other models', () => {
      expect(resolveImageResolution('4:3', 'dall-e-3')).toBe('1792x1024');
      expect(resolveImageResolution('4:3', 'black-forest-labs/FLUX.1-schnell')).toBe('1024x768');
    });
  });

  describe('buildImageRequestBody', () => {
    it('builds body for DALL-E 3 with quality and style', () => {
      const { body, finalPrompt, size } = buildImageRequestBody(
        'a cute puppy',
        { ...defaultConfig, quality: 'hd', style: 'natural' },
        'b64_json',
      );

      expect(body.model).toBe('dall-e-3');
      expect(body.prompt).toBe('a cute puppy');
      expect(body.size).toBe('1024x1024');
      expect(body.quality).toBe('hd');
      expect(body.style).toBe('natural');
      expect(body.response_format).toBe('b64_json');
      expect(body.negative_prompt).toBeUndefined();
      expect(finalPrompt).toBe('a cute puppy');
      expect(size).toBe('1024x1024');
    });

    it('omits quality and style for DALL-E 2', () => {
      const { body } = buildImageRequestBody(
        'a retro car',
        { ...defaultConfig, model: 'dall-e-2' },
        'url',
      );

      expect(body.model).toBe('dall-e-2');
      expect(body.quality).toBeUndefined();
      expect(body.style).toBeUndefined();
      expect(body.response_format).toBe('url');
    });

    it('attaches negative prompt for FLUX / SD models', () => {
      const { body } = buildImageRequestBody(
        'cyberpunk city',
        {
          ...defaultConfig,
          model: 'black-forest-labs/FLUX.1-schnell',
          negativePrompt: 'blurry, low quality',
        },
        'url',
      );

      expect(body.model).toBe('black-forest-labs/FLUX.1-schnell');
      expect(body.negative_prompt).toBe('blurry, low quality');
      expect(body.quality).toBeUndefined();
      expect(body.style).toBeUndefined();
    });

    it('applies art style preset in finalPrompt', () => {
      const { finalPrompt } = buildImageRequestBody(
        'a futuristic cat',
        { ...defaultConfig, artStyleId: 'anime' },
      );

      expect(finalPrompt).toContain('a futuristic cat');
      expect(finalPrompt).toContain('Makoto Shinkai anime aesthetic');
    });
  });

  describe('enrichPrompt', () => {
    it('returns empty for empty prompt', () => {
      expect(enrichPrompt('')).toBe('');
      expect(enrichPrompt('   ')).toBe('');
    });

    it('enriches prompt with style suffix', () => {
      const enriched = enrichPrompt('a peaceful mountain lake', 'ink_wash');
      expect(enriched).toContain('a peaceful mountain lake');
      expect(enriched).toContain('traditional Chinese ink wash painting');
    });
  });

  describe('requestImageGeneration', () => {
    beforeEach(() => {
      vi.restoreAllMocks();
    });

    it('throws when prompt is empty', async () => {
      await expect(
        requestImageGeneration(
          { prompt: '', config: defaultConfig },
          'sk-key',
          'https://api.openai.com/v1',
        ),
      ).rejects.toThrow('请输入生成图片的提示词');
    });

    it('throws when apiKey is empty', async () => {
      await expect(
        requestImageGeneration(
          { prompt: 'a flower', config: defaultConfig },
          '',
          'https://api.openai.com/v1',
        ),
      ).rejects.toThrow('未配置 API Key');
    });

    it('calls API and returns generated image with b64_json', async () => {
      const mockResponse = {
        data: [
          {
            b64_json: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
            revised_prompt: 'A refined description of a neon flower',
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as any);

      const result = await requestImageGeneration(
        { prompt: 'a neon flower', config: defaultConfig },
        'sk-test-key',
        'https://api.openai.com/v1',
      );

      expect(result).toBeDefined();
      expect(result.url).toContain('data:image/png;base64,iVBORw');
      expect(result.revisedPrompt).toBe('A refined description of a neon flower');
      expect(result.model).toBe('dall-e-3');
      expect(result.aspectRatio).toBe('1:1');
    });

    it.each([
      [{ error: { code: 'free_rate_limited', message: 'https://private.example sk-secret' } }, 429],
      [{ error: { code: 'free_request_too_large', message: 'https://private.example sk-secret' } }, 413],
      [{ error: { code: 'free_unavailable', status: 401, message: 'https://private.example sk-secret' } }, 401],
      [{ type: 'error', status: 403, message: 'https://private.example sk-secret' }, 403],
      [{ error: 'https://private.example sk-secret' }, 502],
    ] as const)('rejects a streamed image error without starting another generation (%j)', async (error, status) => {
      const cancel = vi.fn();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(
            'data: {"type":"image_generation.partial_image","b64_json":"cHJldmlldw=="}\n\n'
            + `data: ${JSON.stringify(error)}\n\n`,
          ));
          // Leave the stream open: the error must cancel it immediately.
        },
        cancel,
      });
      global.fetch = vi.fn(async () => new Response(body, { headers: { 'content-type': 'text/event-stream' } }));
      const onPartial = vi.fn();
      const failure = await requestImageGeneration(
        { prompt: 'a flower', config: { ...defaultConfig, providerId: FREE_PROVIDER_ID, model: 'gpt-image-1' } },
        '', FREE_PROVIDER.baseUrl, { onPartial },
      ).catch((error) => error);

      expect(failure).toBeInstanceOf(Error);
      expect(failure.message).toContain(`HTTP ${status}`);
      expect(failure.message).not.toMatch(/private|sk-secret|https?:/);
      expect(global.fetch).toHaveBeenCalledOnce();
      expect(onPartial).toHaveBeenCalledWith('data:image/png;base64,cHJldmlldw==');
      expect(cancel).toHaveBeenCalledOnce();
      expect(body.locked).toBe(false);
    });

    it('recognizes a named SSE error event without exposing its raw text', async () => {
      global.fetch = vi.fn(async () => new Response('event: error\ndata: https://private.example sk-secret\n\n', {
        headers: { 'content-type': 'text/event-stream' },
      }));
      await expect(requestImageGeneration(
        { prompt: 'a flower', config: { ...defaultConfig, model: 'gpt-image-1' } },
        '', FREE_PROVIDER.baseUrl,
      )).rejects.toThrow('图像生成失败，请稍后重试。 (HTTP 502)');
      expect(global.fetch).toHaveBeenCalledOnce();
    });

    it('still retries unstreamed when a successful stream has no final image', async () => {
      global.fetch = vi.fn()
        .mockResolvedValueOnce(new Response('data: [DONE]\n\n', { headers: { 'content-type': 'text/event-stream' } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ data: [{ b64_json: 'aW1hZ2U=' }] })));
      const result = await requestImageGeneration(
        { prompt: 'a flower', config: { ...defaultConfig, model: 'gpt-image-1' } },
        '', FREE_PROVIDER.baseUrl,
      );
      expect(result.url).toBe('data:image/png;base64,aW1hZ2U=');
      expect(global.fetch).toHaveBeenCalledTimes(2);
    });

    it('calls /chat/completions and extracts markdown image URL from chat content', async () => {
      const mockResponse = {
        choices: [
          {
            message: {
              content: 'Here is your artwork: ![A mountain lake](https://images.example.com/lake.png)',
            },
          },
        ],
      };

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        status: 200,
        json: async () => mockResponse,
      } as any);

      // A relayed (generic-family) model has no /images/generations endpoint,
      // so it must be reached through a chat completion.
      const result = await requestImageGeneration(
        { prompt: 'a peaceful lake', config: { ...defaultConfig, model: 'free-image-relay' } },
        'sk-test-key',
        'https://api.openai.com/v1',
      );

      expect(result).toBeDefined();
      expect(result.url).toBe('https://images.example.com/lake.png');
      expect(global.fetch).toHaveBeenCalledWith(
        'https://api.openai.com/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          body: expect.stringContaining('"messages"'),
        }),
      );
    });
  });

  describe('extractImageUrlFromContent', () => {
    it('returns an SVG as a base64 data URL that passes isSafeImageUrl', () => {
      const url = extractImageUrlFromContent('Here: <svg xmlns="http://www.w3.org/2000/svg"><circle/></svg>');
      expect(url).toMatch(/^data:image\/svg\+xml;base64,/);
      expect(isSafeImageUrl(url!)).toBe(true);
    });

    it('extracts markdown and plain image URLs', () => {
      expect(extractImageUrlFromContent('![x](https://a.example/cat.png)')).toBe('https://a.example/cat.png');
      expect(extractImageUrlFromContent('see https://a.example/dog.jpg?w=2')).toBe('https://a.example/dog.jpg?w=2');
      expect(extractImageUrlFromContent('no picture here')).toBeNull();
    });
  });

  describe('getAvailableImageModels', () => {
    it('strictly returns only Free models and user provider models without hardcoded lists', () => {
      const mockProviders = [
        { id: 'prov-user-1', name: 'My Custom Provider', defaultModel: 'custom-model-1', enabled: true },
        { id: 'prov-disabled', name: 'Disabled Provider', defaultModel: 'ignore-me', enabled: false },
      ];

      const mockModelsMap = new Map([
        [FREE_PROVIDER_ID, [{ id: 'free-vision-1', name: 'Free Vision Model', providerId: FREE_PROVIDER_ID }]],
        ['prov-user-1', [{ id: 'custom-flux-dev', name: 'FLUX Dev Custom', providerId: 'prov-user-1' }]],
      ]);

      const groups = getAvailableImageModels(mockProviders, mockModelsMap);

      // Group 1: Free
      expect(groups.length).toBe(2);
      expect(groups[0].label).toBe('ConeCode Free (官方免费)');
      expect(groups[0].providerId).toBe(FREE_PROVIDER_ID);
      expect(groups[0].models).toHaveLength(1);
      expect(groups[0].models[0].id).toBe('free-vision-1');

      // Group 2: User provider
      expect(groups[1].label).toBe('My Custom Provider');
      expect(groups[1].providerId).toBe('prov-user-1');
      expect(groups[1].models[0].id).toBe('custom-flux-dev');

      // Ensure disabled provider is excluded
      expect(groups.some((g) => g.providerId === 'prov-disabled')).toBe(false);
    });

    it('falls back to provider defaultModel when provider has no fetched models in map', () => {
      const mockProviders = [
        { id: 'prov-empty', name: 'Empty Provider', defaultModel: 'my-default-model', enabled: true },
      ];

      const groups = getAvailableImageModels(mockProviders, new Map());
      expect(groups).toHaveLength(1);
      expect(groups[0].label).toBe('Empty Provider');
      expect(groups[0].models[0].id).toBe('my-default-model');
    });

    it('returns empty array when neither free models nor user models are available', () => {
      const groups = getAvailableImageModels([], new Map());
      expect(groups).toEqual([]);
    });
  });

  describe('resolveImageGenCredentials', () => {
    it('resolves Free provider credentials without requiring an API key', () => {
      const creds = resolveImageGenCredentials(
        { ...defaultConfig, providerId: FREE_PROVIDER_ID, model: 'free-model' },
        [],
      );
      expect(creds.isFree).toBe(true);
      expect(creds.apiKey).toBe('');
      expect(creds.baseUrl).toBe(FREE_PROVIDER.baseUrl);
      expect(creds.providerName).toBe('ConeCode Free');
      expect(creds.model).toBe('free-model');
    });

    it('auto-resolves to user provider with API key if available', () => {
      const creds = resolveImageGenCredentials(
        { ...defaultConfig, providerId: 'auto', model: '' },
        [
          {
            id: 'openai-1',
            name: 'OpenAI',
            type: 'openai',
            baseUrl: 'https://api.openai.com/v1',
            apiKey: 'sk-user-key',
            defaultModel: 'user-dalle',
            enabled: true,
          },
        ],
      );
      expect(creds.isFree).toBe(false);
      expect(creds.apiKey).toBe('sk-user-key');
      expect(creds.baseUrl).toBe('https://api.openai.com/v1');
      expect(creds.model).toBe('user-dalle');
    });

    it('auto-resolves to ConeCode Free when no user providers have API keys', () => {
      const creds = resolveImageGenCredentials(
        { ...defaultConfig, providerId: 'auto', customApiKey: '', model: '' },
        [],
      );
      expect(creds.isFree).toBe(true);
      expect(creds.apiKey).toBe('');
      expect(creds.baseUrl).toBe(FREE_PROVIDER.baseUrl);
      expect(creds.providerName).toBe('ConeCode Free');
    });
  });
});

