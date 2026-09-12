import { OpenAIAdapter } from './openai.adapter';
import type { AIModel } from '../../types';

export class DeepSeekAdapter extends OpenAIAdapter {
  async listModels(): Promise<AIModel[]> {
    const response = await this.fetchWithTimeout(
      this.buildUrl('/models'),
      { headers: this.buildHeaders() }
    );
    if (!response.ok) {
      const error = await response.text().catch(() => 'Unknown error');
      throw new Error(`Failed to fetch models: ${response.status} ${error}`);
    }
    const data = await response.json();
    return (data.data || []).map((m: any) => this.mapModel(m, {
      contextWindow: this.detectContextWindow(m) ?? 64000,
    }));
  }
}
