import { OpenAIAdapter } from './openai.adapter';
import type { AIModel } from '../../types';

export class OpenRouterAdapter extends OpenAIAdapter {
  protected override buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'HTTP-Referer': 'https://conecode.app',
      'X-Title': 'ConeCode',
    };
  }

  protected override buildUrl(path: string): string {
    return `https://openrouter.ai/api/v1${path}`;
  }

  protected override mapListModel(m: any): AIModel {
    // OpenRouter returns rich per-model metadata, so let mapModel derive every
    // capability flag from it rather than hardcoding guesses here.
    return this.mapModel(m, {
      contextWindow: this.detectContextWindow(m) ?? 128000,
      maxOutputTokens: this.detectMaxOutput(m) ?? 4096,
    });
  }
}
