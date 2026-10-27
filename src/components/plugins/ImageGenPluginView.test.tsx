import { describe, it, expect, beforeEach } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import ImageGenPluginView from './ImageGenPluginView';
import { useLanguageStore } from '../../stores/language.store';

describe('ImageGenPluginView', () => {
  beforeEach(() => {
    useLanguageStore.getState().setLocale('zh');
  });

  const mockProviders = [
    {
      id: 'openai-1',
      name: 'OpenAI 官方',
      type: 'openai' as const,
      baseUrl: 'https://api.openai.com/v1',
      apiKey: 'sk-test-openai',
      defaultModel: 'dall-e-3',
      timeout: 30000,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
    {
      id: 'custom-1',
      name: '本地 SD 服务',
      type: 'custom' as const,
      baseUrl: 'http://127.0.0.1:7860/v1',
      apiKey: '',
      defaultModel: '',
      timeout: 30000,
      enabled: true,
      createdAt: 0,
      updatedAt: 0,
    },
  ];

  const mockConfig = {
    providerId: 'openai-1',
    customBaseUrl: 'https://api.openai.com/v1',
    customApiKey: '',
    model: 'dall-e-3',
    aspectRatio: '16:9' as const,
    quality: 'hd' as const,
    style: 'vivid' as const,
    artStyleId: 'anime',
    negativePrompt: '',
    background: 'auto' as const,
  };

  const mockHistory = [
    {
      id: 'hist-1',
      url: 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
      prompt: 'A cute anime cat',
      model: 'dall-e-3',
      aspectRatio: '16:9' as const,
      size: '1792x1024',
      createdAt: Date.now(),
    },
  ];

  it('renders provider and model selection reading configured credentials without reentry', () => {
    const html = renderToStaticMarkup(
      <ImageGenPluginView
        config={mockConfig}
        providers={mockProviders}
        history={mockHistory}
      />,
    );

    expect(html).toContain('AI 绘图插件');
    expect(html).toContain('免再次填写');
    expect(html).toContain('直接复用软件已填好的服务商');
    expect(html).toContain('原生对话工具已就绪');
    expect(html).toContain('OpenAI 官方');
    expect(html).toContain('凭据已就绪');

    // Check aspect ratios are rendered
    expect(html).toContain('16:9');
    expect(html).toContain('1:1');
    expect(html).toContain('9:16');
  });

  it('does NOT print baseUrl or endpoints in the UI', () => {
    const html = renderToStaticMarkup(
      <ImageGenPluginView
        config={mockConfig}
        providers={mockProviders}
      />,
    );

    // Verify "不要把地址写出来" - no API URLs printed
    expect(html).not.toContain('https://api.openai.com/v1');
    expect(html).not.toContain('http://127.0.0.1:7860/v1');
    expect(html).not.toContain('/chat/completions');
    expect(html).not.toContain('/images/generations');
  });

  it('renders preference settings including quality and art styles', () => {
    const html = renderToStaticMarkup(
      <ImageGenPluginView
        config={mockConfig}
        providers={mockProviders}
      />,
    );

    expect(html).toContain('画质等级');
    expect(html).toContain('色彩风格');
    expect(html).toContain('预设艺术风格');
    expect(html).toContain('在对话中调用');
  });

  it('renders recent history gallery preview with thumbnails', () => {
    const html = renderToStaticMarkup(
      <ImageGenPluginView
        config={mockConfig}
        providers={mockProviders}
        history={mockHistory}
      />,
    );

    expect(html).toContain('最近作品画廊');
    expect(html).toContain('A cute anime cat');
    expect(html).toContain('alt="A cute anime cat"');
  });

  it('only lists User models and ConeCode Free models, does not inject preset hardcoded models', () => {
    const html = renderToStaticMarkup(
      <ImageGenPluginView
        config={mockConfig}
        providers={mockProviders}
      />,
    );

    // Free option is present
    expect(html).toContain('ConeCode Free (官方免费)');
    // User configured provider is present
    expect(html).toContain('OpenAI 官方');
    // Hardcoded preset models from before must NOT be present
    expect(html).not.toContain('FLUX.1 schnell (极速高质量)');
    expect(html).not.toContain('Stable Diffusion 3.5 Large');
    expect(html).not.toContain('主流图像生成模型');
  });

  it('supports English and multilingual locale dynamically', () => {
    useLanguageStore.getState().setLocale('en');

    const html = renderToStaticMarkup(
      <ImageGenPluginView
        config={mockConfig}
        providers={mockProviders}
      />,
    );

    expect(html).toContain('AI Image Generation Plugin');
    expect(html).toContain('Native Chat Tool Ready');
    expect(html).toContain('Credentials Ready');
    expect(html).toContain('Aspect Ratio &amp; Style Preferences');
  });
});
