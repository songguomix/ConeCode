export interface AIModel {
  id: string;
  name: string;
  providerId: string;
  supportsText: boolean;
  supportsVision: boolean;
  supportsImageGeneration: boolean;
  supportsAudioInput: boolean;
  supportsAudioOutput: boolean;
  supportsFunctionCalling: boolean;
  supportsReasoning: boolean;
  /**
   * Thinking-effort levels the provider declares for this model (auto-fetched
   * from /models metadata). Undefined = unknown, so the UI shows the full set;
   * a declared list is filtered down to exactly what the model accepts.
   */
  reasoningEfforts?: ReasoningEffort[];
  contextWindow: number;
  maxOutputTokens: number;
  enabled: boolean;
  userEnabledReasoning?: boolean;
  // The API-derived / auto-detected limits, preserved so a manual override can
  // be reset back to "auto". Only set once the model has passed through the
  // override layer; treat a missing value as "same as the effective limit".
  autoContextWindow?: number;
  autoMaxOutputTokens?: number;
}

export type ReasoningEffort = 'auto' | 'low' | 'medium' | 'high';

export interface ModelCapabilities {
  text: boolean;
  vision: boolean;
  imageGeneration: boolean;
  audioInput: boolean;
  audioOutput: boolean;
  functionCalling: boolean;
  reasoning: boolean;
}

export interface ModelSelectorItem {
  model: AIModel;
  providerName: string;
  isFavorite: boolean;
  isRecent: boolean;
}
