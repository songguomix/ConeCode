import type { DreamLlm } from './types';
import { extractJsonObject } from './wiki';

type Request = Parameters<DreamLlm>[0];
const MIN_OUTPUT_TOKENS = 8192;
const MAX_OUTPUT_TOKENS = 24_576;
const RETRY_INSTRUCTION = '\n\nReturn a complete JSON object only. Keep the result concise: include only the highest-value items and keep each topic body short. Escape newlines and quotes in JSON strings.';

function textParts(parts: unknown): string {
  return Array.isArray(parts)
    ? parts.filter((part) => !part?.thought && (!part?.type || part.type === 'text') && typeof part?.text === 'string')
        .map((part) => part.text).join('')
    : '';
}

function finalAnswer(result: any): { text: string; truncated: boolean } {
  const choice = result?.choices?.[0];
  const candidate = result?.candidates?.[0];
  const reason = choice?.finish_reason ?? result?.finish_reason ?? result?.stop_reason ?? candidate?.finishReason;
  const truncated = ['length', 'max_tokens', 'max_output_tokens'].includes(String(reason).toLowerCase());
  const content = choice?.message?.content ?? result?.content ?? candidate?.content?.parts;
  // Some compatible endpoints inline the thinking in the text instead of
  // sending reasoning_content. Never parse an object inside that prefix.
  const text = (typeof content === 'string' ? content : textParts(content))
    .replace(/^\s*(?:<think>[\s\S]*?<\/think>\s*)+/i, '')
    .trim();
  return { text: /^<think>/i.test(text) ? '' : text, truncated };
}

/** Request complete final JSON; reasoning tokens count against the output cap too. */
export async function completeDream(
  request: Request,
  modelLimit: number | undefined,
  send: (request: Request) => Promise<unknown>
): Promise<string> {
  const limit = typeof modelLimit === 'number' && Number.isFinite(modelLimit) && modelLimit >= 1
    ? Math.min(Math.floor(modelLimit), MAX_OUTPUT_TOKENS)
    : MAX_OUTPUT_TOKENS;
  const firstBudget = Math.min(limit, Math.max(request.maxTokens ?? MIN_OUTPUT_TOKENS, MIN_OUTPUT_TOKENS));
  let result = finalAnswer(await send({ ...request, maxTokens: firstBudget }));
  if (result.truncated || !extractJsonObject(result.text)) {
    result = finalAnswer(await send({
      ...request,
      system: request.system + RETRY_INSTRUCTION,
      maxTokens: Math.min(limit, firstBudget * 2),
    }));
  }
  if (result.truncated) throw new Error('Dream model output reached its token limit before finishing');
  return result.text;
}
