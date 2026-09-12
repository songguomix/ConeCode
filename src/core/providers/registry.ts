import { BaseAdapter } from './base.adapter';
import { OpenAIAdapter } from './openai.adapter';
import { AnthropicAdapter } from './anthropic.adapter';
import { GeminiAdapter } from './gemini.adapter';
import { DeepSeekAdapter } from './deepseek.adapter';
import { OpenRouterAdapter } from './openrouter.adapter';
import { CustomAdapter } from './custom.adapter';
import type { ProviderConfig, ProviderType, AIModel } from '../../types';

type AdapterConstructor = new (config: ProviderConfig) => BaseAdapter;

const adapterMap: Record<ProviderType, AdapterConstructor> = {
  openai: OpenAIAdapter,
  anthropic: AnthropicAdapter,
  gemini: GeminiAdapter,
  deepseek: DeepSeekAdapter,
  openrouter: OpenRouterAdapter,
  custom: CustomAdapter,
};

export class ProviderRegistry {
  private adapters = new Map<string, BaseAdapter>();

  register(config: ProviderConfig): void {
    const AdapterClass = adapterMap[config.type] || CustomAdapter;
    this.adapters.set(config.id, new AdapterClass(config));
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
    const AdapterClass = adapterMap[config.type] || CustomAdapter;
    const adapter = new AdapterClass(config);
    return adapter.listModels();
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

export const providerRegistry = new ProviderRegistry();
