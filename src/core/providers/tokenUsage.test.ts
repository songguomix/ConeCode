import { describe, expect, it } from 'vitest';
import { normalizeTokenUsage } from './tokenUsage';

describe('normalizeTokenUsage', () => {
  it('includes Anthropic cache reads and writes in total prompt usage', () => {
    expect(normalizeTokenUsage({ usage: {
      input_tokens: 100,
      output_tokens: 30,
      cache_read_input_tokens: 800,
      cache_creation_input_tokens: 200,
    } })).toEqual({ promptTokens: 1_100, completionTokens: 30, tokens: 1_130, cacheHitTokens: 800 });
  });

  it('does not double-count OpenAI-compatible or Gemini cache reads', () => {
    const expected = { promptTokens: 1_000, completionTokens: 20, tokens: 1_020, cacheHitTokens: 900 };
    expect(normalizeTokenUsage({ usage: {
      prompt_tokens: 1_000,
      completion_tokens: 20,
      prompt_tokens_details: { cached_tokens: 900 },
    } })).toEqual(expected);
    expect(normalizeTokenUsage({ usage: {
      prompt_cache_hit_tokens: 900,
      prompt_cache_miss_tokens: 100,
      completion_tokens: 20,
    } })).toEqual(expected);
    expect(normalizeTokenUsage({ usageMetadata: {
      promptTokenCount: 1_000,
      cachedContentTokenCount: 900,
      candidatesTokenCount: 20,
      totalTokenCount: 1_020,
    } })).toEqual(expected);
  });

  it('keeps zero hits distinct from missing or inconsistent cache data', () => {
    expect(normalizeTokenUsage({ usage: {
      input_tokens: 100, cache_read_input_tokens: 0, cache_creation_input_tokens: 200,
    } }).cacheHitTokens).toBe(0);
    expect(normalizeTokenUsage({ usage: { prompt_tokens: 20 } }).cacheHitTokens).toBeUndefined();
    expect(normalizeTokenUsage({ usage: { prompt_cache_hit_tokens: 20 } }).cacheHitTokens).toBeUndefined();
    expect(normalizeTokenUsage({ usage: {
      prompt_tokens: 20, prompt_cache_hit_tokens: 40,
    } }).cacheHitTokens).toBeUndefined();
  });
});
