import { OpenAIAdapter } from './openai.adapter';

import type { AIModel } from '../../types';

export class CustomAdapter extends OpenAIAdapter {
  protected override mapListModel(m: any): AIModel {
    return this.mapModel(m, {
      contextWindow: this.detectContextWindow(m) ?? 32_000,
    });
  }
}
