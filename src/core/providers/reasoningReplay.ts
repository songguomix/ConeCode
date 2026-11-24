import { gptDetector } from '../constraints/gptDetector';
import type { ProviderConfig } from '../../types';

type EndpointConfig = Pick<ProviderConfig, 'type' | 'baseUrl'>;
type ReasoningReplay = 'none' | 'tools' | 'all';

export function isOfficialOpenAIEndpoint(config: EndpointConfig | undefined): boolean {
  // OpenAI and Custom use the configured URL for Chat Completions. OpenRouter
  // has its own fixed URL and must keep its compatible message format.
  if (config?.type !== 'openai' && config?.type !== 'custom') return false;
  return URL.parse(config.baseUrl)?.origin === 'https://api.openai.com';
}

export function reasoningReplayFor(config: EndpointConfig | undefined, modelId: string): ReasoningReplay {
  if (isOfficialOpenAIEndpoint(config)) return 'none';

  const type = config?.type;
  if (type === 'deepseek' || type === 'anthropic' || type === 'gemini') return 'all';

  const detected = gptDetector.detect(modelId, config?.baseUrl);
  // A gateway can imitate OpenAI headers without serving a GPT model. Only
  // use a learned alias when its resolved name identifies an actual GPT model.
  const knownGpt = detected.source === 'model_name' || (detected.source === 'alias_cache'
    && gptDetector.detect(detected.normalizedModel).source === 'model_name');
  return knownGpt ? 'tools' : 'all';
}
