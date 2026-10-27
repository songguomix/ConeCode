import { create } from 'zustand';
import { v4 as uuidv4 } from 'uuid';
import type { AspectRatio, GeneratedImage, ImageGenConfig, ImageQuality, ImageStyle } from '../core/image/types';
import { enrichPrompt, getRandomPrompt } from '../core/image/prompts';
import {
  copyImageToClipboard,
  requestImageGeneration,
  resolveImageGenCredentials,
  saveImageToDisk,
} from '../core/image/imageGen';
import { useProviderStore } from './provider.store';
import { useChatStore } from './chat.store';
import { useModelStore } from './model.store';
import type { Message } from '../types';

const STORAGE_CONFIG_KEY = 'conecode.imageGenConfig';
const STORAGE_HISTORY_KEY = 'conecode.imageGenHistory';

const DEFAULT_CONFIG: ImageGenConfig = {
  providerId: 'auto',
  customBaseUrl: '',
  customApiKey: '',
  model: '',
  aspectRatio: '1:1',
  quality: 'standard',
  style: 'vivid',
  artStyleId: '',
  negativePrompt: '',
  background: 'auto',
};

function loadStoredConfig(): ImageGenConfig {
  try {
    const raw = localStorage.getItem(STORAGE_CONFIG_KEY);
    if (raw) {
      return { ...DEFAULT_CONFIG, ...JSON.parse(raw) };
    }
  } catch {}
  return DEFAULT_CONFIG;
}

function loadStoredHistory(): GeneratedImage[] {
  try {
    const raw = localStorage.getItem(STORAGE_HISTORY_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed.slice(0, 40);
    }
  } catch {}
  return [];
}

interface ImageGenStore {
  isOpen: boolean;
  activeTab: 'studio' | 'gallery' | 'settings';
  prompt: string;
  config: ImageGenConfig;
  isGenerating: boolean;
  progressStep: string;
  error: string | null;
  currentResult: GeneratedImage | null;
  history: GeneratedImage[];
  abortController: AbortController | null;

  openModal: (initialPrompt?: string) => void;
  closeModal: () => void;
  setActiveTab: (tab: 'studio' | 'gallery' | 'settings') => void;
  setPrompt: (prompt: string) => void;
  setConfig: (patch: Partial<ImageGenConfig>) => void;
  clearError: () => void;

  enhanceCurrentPrompt: () => void;
  randomizePrompt: () => void;

  generate: (overridePrompt?: string) => Promise<GeneratedImage | null>;
  cancelGeneration: () => void;
  insertToChat: (image?: GeneratedImage) => Promise<void>;
  saveImage: (image?: GeneratedImage) => Promise<boolean>;
  copyImage: (image?: GeneratedImage) => Promise<boolean>;
  clearHistory: () => void;
  selectHistoryItem: (item: GeneratedImage) => void;
  addToGallery: (result: GeneratedImage) => void;
}

export const useImageGenStore = create<ImageGenStore>((set, get) => ({
  isOpen: false,
  activeTab: 'studio',
  prompt: '',
  config: loadStoredConfig(),
  isGenerating: false,
  progressStep: '',
  error: null,
  currentResult: null,
  history: loadStoredHistory(),
  abortController: null,

  openModal: (initialPrompt?: string) => {
    set((s) => ({
      isOpen: true,
      error: null,
      prompt: initialPrompt !== undefined && initialPrompt !== '' ? initialPrompt : s.prompt,
    }));
  },

  closeModal: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
    }
    set({ isOpen: false, abortController: null, isGenerating: false });
  },

  setActiveTab: (tab) => set({ activeTab: tab }),

  setPrompt: (prompt) => set({ prompt, error: null }),

  setConfig: (patch) => {
    set((s) => {
      const next = { ...s.config, ...patch };
      try {
        localStorage.setItem(STORAGE_CONFIG_KEY, JSON.stringify(next));
      } catch {}
      return { config: next, error: null };
    });
  },

  clearError: () => set({ error: null }),

  enhanceCurrentPrompt: () => {
    const { prompt, config } = get();
    if (!prompt.trim()) return;
    const enriched = enrichPrompt(prompt, config.artStyleId);
    set({ prompt: enriched });
  },

  randomizePrompt: () => {
    const random = getRandomPrompt();
    set({ prompt: random, error: null });
  },

  cancelGeneration: () => {
    const { abortController } = get();
    if (abortController) {
      abortController.abort();
    }
    set({ isGenerating: false, abortController: null, progressStep: '' });
  },

  generate: async (overridePrompt?: string) => {
    const { config, prompt: statePrompt } = get();
    const promptToUse = (overridePrompt !== undefined ? overridePrompt : statePrompt).trim();

    if (!promptToUse) {
      set({ error: '请输入画作创意提示词 (Prompt)' });
      return null;
    }

    // Resolve API Key, Base URL and Model from user providers or Free provider
    const providers = useProviderStore.getState().providers;
    const creds = resolveImageGenCredentials(config, providers);
    const effectiveModel = config.model || creds.model;

    if (!effectiveModel) {
      set({
        error: '请先在高级选项中选择或输入要调用的图像生成模型',
      });
      return null;
    }

    if (!creds.apiKey && !creds.isFree) {
      set({
        error: '未检测到可用的 API Key。请在【API 配置】中配置您的服务商密钥，或选择【ConeCode Free (官方免费)】',
        activeTab: 'settings',
      });
      return null;
    }

    const controller = new AbortController();
    set({
      isGenerating: true,
      error: null,
      progressStep: '正在解析创意构思与光影参数...',
      abortController: controller,
    });

    // Step animation timer for smooth delightful UI feedback
    const stepTimer1 = setTimeout(() => {
      if (get().isGenerating) set({ progressStep: '正在通过视觉大模型渲染细节...' });
    }, 2800);

    const stepTimer2 = setTimeout(() => {
      if (get().isGenerating) set({ progressStep: '正在润色并输出超清画质...' });
    }, 6000);

    try {
      const result = await requestImageGeneration(
        {
          prompt: promptToUse,
          config: {
            ...config,
            model: effectiveModel,
          },
          signal: controller.signal,
        },
        creds.apiKey,
        creds.baseUrl,
      );

      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);

      set((s) => {
        const nextHistory = [result, ...s.history.filter((h) => h.id !== result.id)].slice(0, 40);
        try {
          // Store minimal payload without huge base64 in localStorage to prevent quota exceeded
          const saveable = nextHistory.map((h) => ({
            ...h,
            url: h.url.length > 50000 ? '' : h.url,
          }));
          localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(saveable));
        } catch {}
        return {
          isGenerating: false,
          progressStep: '',
          abortController: null,
          currentResult: result,
          history: nextHistory,
          activeTab: 'studio',
        };
      });

      return result;
    } catch (err: any) {
      clearTimeout(stepTimer1);
      clearTimeout(stepTimer2);
      if (err.name === 'AbortError' || err.message?.includes('取消')) {
        set({ isGenerating: false, progressStep: '', abortController: null });
        return null;
      }
      set({
        isGenerating: false,
        progressStep: '',
        abortController: null,
        error: err.message || '生成失败，请检查网络或 API 配置',
      });
      return null;
    }
  },

  insertToChat: async (targetImage?: GeneratedImage) => {
    const image = targetImage || get().currentResult;
    if (!image) return;
    // History entries whose base64 was stripped for storage have no picture
    // left to insert — only the prompt survived.
    if (!image.url) {
      set({ error: '该历史记录的图片数据未保存，无法插入对话' });
      return;
    }

    const chatStore = useChatStore.getState();
    let convId = chatStore.activeConversationId;

    if (!convId) {
      const selModel = useModelStore.getState().getSelectedModel();
      if (selModel) {
        convId = await chatStore.createConversation(selModel.providerId, selModel.id);
      }
    }

    if (!convId) {
      set({ error: '未能找到或创建当前对话' });
      return;
    }

    // 1. Add User request turn
    const userMsg: Message = {
      id: uuidv4(),
      conversationId: convId,
      role: 'user',
      content: `生成图片: ${image.prompt}`,
      createdAt: Date.now() - 500,
    };

    // 2. Add Assistant turn with the visual artwork markdown
    const mdLines = [
      `### AI 视觉艺术画作已生成`,
      `**提示词**: ${image.prompt}`,
    ];
    if (image.revisedPrompt && image.revisedPrompt !== image.prompt) {
      mdLines.push(`> **DALL·E 优化提示词**: ${image.revisedPrompt}`);
    }
    mdLines.push(`*模型: \`${image.model}\` · 比例: \`${image.aspectRatio}\` · 尺寸: \`${image.size}\`*`);
    mdLines.push('');
    mdLines.push(`![${image.prompt.slice(0, 30).replace(/[[\]]/g, '')}](${image.url})`);

    const assistantMsg: Message = {
      id: uuidv4(),
      conversationId: convId,
      role: 'assistant',
      content: mdLines.join('\n\n'),
      images: [image.url],
      modelId: image.model,
      providerId: 'image-studio',
      createdAt: Date.now(),
    };

    try {
      if (window.electronAPI?.message?.create) {
        await window.electronAPI.message.create(userMsg);
        await window.electronAPI.message.create(assistantMsg);
      }
    } catch (e) {
      console.error('Failed to persist image messages to database:', e);
    }

    // Update messages in chatStore
    useChatStore.setState((s) => ({
      messages: [...s.messages, userMsg, assistantMsg],
    }));

    // Close image generator modal so user can view it in the chat
    get().closeModal();
  },

  saveImage: async (targetImage?: GeneratedImage) => {
    const image = targetImage || get().currentResult;
    if (!image?.url) return false;
    const cleanPrompt = image.prompt.slice(0, 20).replace(/[^a-zA-Z0-9\u4e00-\u9fa5_-]/g, '_');
    const filename = `art-${cleanPrompt || Date.now()}-${image.aspectRatio.replace(':', 'x')}.png`;
    return saveImageToDisk(image.url, filename);
  },

  copyImage: async (targetImage?: GeneratedImage) => {
    const image = targetImage || get().currentResult;
    if (!image?.url) return false;
    return copyImageToClipboard(image.url);
  },

  clearHistory: () => {
    set({ history: [] });
    try {
      localStorage.removeItem(STORAGE_HISTORY_KEY);
    } catch {}
  },

  selectHistoryItem: (item) => {
    set({
      currentResult: item,
      prompt: item.prompt,
      activeTab: 'studio',
    });
  },

  addToGallery: (result: GeneratedImage) => {
    set((s) => {
      const nextHistory = [result, ...s.history.filter((h) => h.id !== result.id)].slice(0, 40);
      try {
        const saveable = nextHistory.map((h) => ({
          ...h,
          url: h.url.length > 50000 ? '' : h.url,
        }));
        localStorage.setItem(STORAGE_HISTORY_KEY, JSON.stringify(saveable));
      } catch {}
      return {
        history: nextHistory,
        currentResult: result,
      };
    });
  },
}));
