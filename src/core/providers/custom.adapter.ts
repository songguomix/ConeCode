import { OpenAIAdapter } from './openai.adapter';

// Plain OpenAI-compatible endpoint. Inherits listModels/send/stream from
// OpenAIAdapter with no overrides.
export class CustomAdapter extends OpenAIAdapter {}
