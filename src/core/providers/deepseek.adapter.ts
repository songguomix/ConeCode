import { OpenAIAdapter } from './openai.adapter';
import type { AIModel } from '../../types';

export class DeepSeekAdapter extends OpenAIAdapter {
  protected override mapListModel(m: any): AIModel {
    return this.mapModel(m, {
      contextWindow: this.detectContextWindow(m) ?? 64000,
    });
  }
}
