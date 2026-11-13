export interface TokenUsage {
  promptTokens: number;
  completionTokens: number;
  tokens: number;
  /** Undefined when the provider did not report cache usage. */
  cacheHitTokens?: number;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {};
}

function count(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 ? value : undefined;
}

/** Normalize the usage envelopes returned by the streaming adapters. */
export function normalizeTokenUsage(result: unknown): TokenUsage {
  const response = record(result);
  const usage = record(response.usage ?? response.usageMetadata);
  const reportedPrompt = count(usage.prompt_tokens) ?? count(usage.promptTokenCount);
  const uncachedInput = count(usage.input_tokens);
  const anthropicRead = count(usage.cache_read_input_tokens);
  const anthropicWrite = count(usage.cache_creation_input_tokens);
  const directHit = count(usage.prompt_cache_hit_tokens);
  const directMiss = count(usage.prompt_cache_miss_tokens);

  // Anthropic's input_tokens excludes both cache reads and cache writes.
  // OpenAI-compatible prompt_tokens and Gemini's promptTokenCount include cache reads.
  const inputFromParts = uncachedInput !== undefined
    ? uncachedInput + (anthropicRead ?? 0) + (anthropicWrite ?? 0)
    : directHit !== undefined && directMiss !== undefined ? directHit + directMiss : undefined;
  const promptTokens = reportedPrompt ?? inputFromParts ?? 0;
  const completionTokens = count(usage.completion_tokens) ?? count(usage.output_tokens)
    ?? count(usage.candidatesTokenCount) ?? 0;
  const tokens = count(usage.total_tokens) ?? count(usage.totalTokenCount) ?? promptTokens + completionTokens;
  const reportedHit = directHit ?? count(record(usage.prompt_tokens_details).cached_tokens)
    ?? anthropicRead ?? count(usage.cachedContentTokenCount);
  // Missing or inconsistent counters do not mean a 0% hit rate.
  const cacheHitTokens = reportedHit !== undefined && promptTokens > 0 && reportedHit <= promptTokens
    ? reportedHit
    : undefined;
  return { promptTokens, completionTokens, tokens, cacheHitTokens };
}
