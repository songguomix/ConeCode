import { FreeAdapter, type FreeFetch } from './free.adapter';
import { BaseAdapter } from './base.adapter';
import { OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { DeepSeekAdapter } from './deepseek.adapter';
import { OpenRouterAdapter } from './openrouter.adapter';
import { CustomAdapter } from './custom.adapter';
import type { ProviderConfig, ProviderType, AIModel } from '../../types';

type AdapterConstructor = new (config: ProviderConfig) => BaseAdapter;

const adapterMap: Record<Exclude<ProviderType, 'conecode-free'>, AdapterConstructor> = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  gemini: GeminiAdapter,
  deepseek: DeepSeekAdapter,
  openrouter: OpenRouterAdapter,
  custom: CustomAdapter,
};

export class ProviderRegistry {
  private adapters = new Map<string, BaseAdapter>();

  constructor(private readonly freeFetch?: FreeFetch) {}

  private createAdapter(config: ProviderConfig): BaseAdapter {
    if (config.type === 'conecode-free') return new FreeAdapter(config, this.freeFetch);
    const AdapterClass = adapterMap[config.type] || CustomAdapter;
    return new AdapterClass(config);
  }

  register(config: ProviderConfig): void {
    this.adapters.set(config.id, this.createAdapter(config));
  }

  unregister(providerId: string): void {
    this.adapters.delete(providerId);
  }

  getAdapter(providerId: string): BaseAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new Error(`Provider not found: ${providerId}`);
    return adapter;
  }

  listAdapters(): BaseAdapter[] {
    return Array.from(this.adapters.values());
  }

  hasAdapter(providerId: string): boolean {
    return this.adapters.has(providerId);
  }

  async getModelsForProvider(providerId: string): Promise<AIModel[]> {
    const adapter = this.getAdapter(providerId);
    return adapter.listModels();
  }

  // List models for a config that has NOT been saved/registered yet — used by the
  // "detect models" button in the add-provider form. Builds a throwaway adapter
  // so we can probe the provider's /models endpoint (and its API-reported context
  // windows) before the user commits.
  async probeModels(config: ProviderConfig): Promise<AIModel[]> {
    return this.createAdapter(config).listModels();
  }

  async getAllModels(): Promise<AIModel[]> {
    const results = await Promise.allSettled(
      this.listAdapters().map((a) => a.listModels())
    );
    return results
      .filter((r): r is PromiseFulfilledResult<AIModel[]> => r.status === 'fulfilled')
      .flatMap((r) => r.value);
  }
}
