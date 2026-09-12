import { OpenAIAdapter } from './openai.adapter';
import type { AIModel } from '../../types';

export class OpenRouterAdapter extends OpenAIAdapter {
  protected buildHeaders(): Record<string, string> {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.config.apiKey}`,
      'HTTP-Referer': 'https://conecode.app',
      'X-Title': 'ConeCode',
    };
  }

  protected buildUrl(path: string): string {
    return `https://openrouter.ai/api/v1${path}`;
  }

  async listModels(): Promise<AIModel[]> {
    const response = await this.fetchWithTimeout(
      'https://openrouter.ai/api/v1/models',
      { headers: this.buildHeaders() }
    );
    if (!response.ok) {
      const error = await response.text().catch(() => 'Unknown error');
      throw new Error(`Failed to fetch models: ${response.status} ${error}`);
    }
    const data = await response.json();
    // OpenRouter returns rich per-model metadata (architecture.input/output
    // modalities + supported_parameters), so let mapModel derive every
    // capability flag from it rather than hardcoding guesses here.
    return (data.data || []).map((m: any) => this.mapModel(m, {
      contextWindow: this.detectContextWindow(m) ?? 128000,
      maxOutputTokens: this.detectMaxOutput(m) ?? 4096,
    }));
  }
}
