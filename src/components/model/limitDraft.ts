import { parseLimitInput } from '../../core/model/limitInput';

/**
 * Only the context window is user-editable. Max output is owned by the
 * provider API and can never be typed in, so the draft has no field for it.
 */
export interface ModelLimitDraft {
  context: string;
}

/** An empty field resets the override; an invalid nonempty one must never erase it. */
export function parseModelLimitDraft(draft: ModelLimitDraft) {
  const contextWindow = parseLimitInput(draft.context);
  if (draft.context.trim() && (contextWindow == null || !Number.isSafeInteger(contextWindow))) {
    return null;
  }
  return { contextWindow };
}
