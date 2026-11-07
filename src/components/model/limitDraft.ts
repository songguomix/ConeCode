import { parseLimitInput } from '../../core/model/limitInput';

export interface ModelLimitDraft {
  context: string;
  maxOutput: string;
}

/** Empty fields reset an override; invalid nonempty fields must never erase it. */
export function parseModelLimitDraft(draft: ModelLimitDraft) {
  const contextWindow = parseLimitInput(draft.context);
  const maxOutputTokens = parseLimitInput(draft.maxOutput);
  if ((draft.context.trim() && (contextWindow == null || !Number.isSafeInteger(contextWindow))) ||
      (draft.maxOutput.trim() && (maxOutputTokens == null || !Number.isSafeInteger(maxOutputTokens)))) {
    return null;
  }
  return { contextWindow, maxOutputTokens };
}
