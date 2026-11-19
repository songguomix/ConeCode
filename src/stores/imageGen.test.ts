import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useImageGenStore } from './imageGen.store';
import { useChatStore } from './chat.store';
import * as imageApi from '../core/image/imageGen';
import type { GeneratedImage } from '../core/image/types';

describe('useImageGenStore', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    useImageGenStore.setState({
      isOpen: false,
      prompt: '',
      isGenerating: false,
      progressStep: '',
      error: null,
      currentResult: null,
      history: [],
      activeTab: 'studio',
      abortController: null,
    });
  });

  it('opens modal with optional initial prompt', () => {
    const store = useImageGenStore.getState();
    store.openModal('a beautiful starry sky');

    expect(useImageGenStore.getState().isOpen).toBe(true);
    expect(useImageGenStore.getState().prompt).toBe('a beautiful starry sky');
    expect(useImageGenStore.getState().error).toBeNull();
  });

  it('closes modal and aborts active controller if any', () => {
    const mockAbort = vi.fn();
    useImageGenStore.setState({
      isOpen: true,
      abortController: { abort: mockAbort } as any,
      isGenerating: true,
    });

    useImageGenStore.getState().closeModal();

    expect(useImageGenStore.getState().isOpen).toBe(false);
    expect(mockAbort).toHaveBeenCalled();
    expect(useImageGenStore.getState().isGenerating).toBe(false);
  });

  it('updates config and persists to localStorage', () => {
    const store = useImageGenStore.getState();
    store.setConfig({ model: 'black-forest-labs/FLUX.1-schnell', aspectRatio: '16:9' });

    expect(useImageGenStore.getState().config.model).toBe('black-forest-labs/FLUX.1-schnell');
    expect(useImageGenStore.getState().config.aspectRatio).toBe('16:9');
  });

  it('randomizes prompt with curated inspiration', () => {
    const store = useImageGenStore.getState();
    store.randomizePrompt();

    expect(useImageGenStore.getState().prompt.length).toBeGreaterThan(5);
  });

  it('enhances prompt with visual style suffix', () => {
    const store = useImageGenStore.getState();
    store.setPrompt('cyberpunk car');
    store.setConfig({ artStyleId: 'cyberpunk' });
    store.enhanceCurrentPrompt();

    const enhanced = useImageGenStore.getState().prompt;
    expect(enhanced).toContain('cyberpunk car');
    expect(enhanced).toContain('neon glow');
  });

  it('sets error when generating with empty prompt', async () => {
    const store = useImageGenStore.getState();
    store.setPrompt('');
    const res = await store.generate();

    expect(res).toBeNull();
    expect(useImageGenStore.getState().error).toContain('请输入画作创意提示词');
  });

  it('keeps a new generation active when an earlier cancellation settles', async () => {
    const studio = useImageGenStore.getState();
    studio.setConfig({ providerId: 'custom', customBaseUrl: 'https://example.test', customApiKey: 'test', model: 'dall-e-3' });
    let rejectOld!: (error: Error) => void;
    let finishNew!: (image: GeneratedImage) => void;
    vi.spyOn(imageApi, 'requestImageGeneration')
      .mockImplementationOnce(() => new Promise((_, reject) => { rejectOld = reject; }))
      .mockImplementationOnce(() => new Promise((resolve) => { finishNew = resolve; }));

    const old = studio.generate('old');
    studio.cancelGeneration();
    const current = studio.generate('new');
    const controller = useImageGenStore.getState().abortController;
    rejectOld(new DOMException('cancelled', 'AbortError'));
    await old;
    expect(useImageGenStore.getState()).toMatchObject({ isGenerating: true, abortController: controller });

    const result: GeneratedImage = {
      id: 'new-art', url: 'https://example.test/art.png', prompt: 'new', model: 'dall-e-3',
      aspectRatio: '1:1', size: '1024x1024', createdAt: 1,
    };
    finishNew(result);
    expect(await current).toEqual(result);
    expect(useImageGenStore.getState().currentResult).toEqual(result);
  });

  it('inserts generated artwork into chat messages', async () => {
    // Mock electronAPI
    (globalThis as any).window = {
      electronAPI: {
        message: {
          create: vi.fn().mockResolvedValue({ id: 'msg-1' }),
        },
      },
    };

    useChatStore.setState({
      activeConversationId: 'conv-123',
      messages: [],
    });

    const mockArtwork = {
      id: 'art-1',
      url: 'data:image/png;base64,mockImage',
      prompt: 'a glowing neon cat',
      model: 'dall-e-3',
      aspectRatio: '1:1' as const,
      size: '1024x1024',
      createdAt: Date.now(),
    };

    useImageGenStore.setState({
      isOpen: true,
      currentResult: mockArtwork,
    });

    await useImageGenStore.getState().insertToChat();

    const chatMsgs = useChatStore.getState().messages;
    expect(chatMsgs.length).toBe(2);
    expect(chatMsgs[0].role).toBe('user');
    expect(chatMsgs[0].content).toContain('a glowing neon cat');
    expect(chatMsgs[1].role).toBe('assistant');
    expect(chatMsgs[1].images).toEqual(['data:image/png;base64,mockImage']);
    expect(chatMsgs[1].content).toContain('AI 视觉艺术画作已生成');

    // Modal should close on insert
    expect(useImageGenStore.getState().isOpen).toBe(false);
  });
});
