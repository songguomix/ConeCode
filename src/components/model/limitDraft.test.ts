import { describe, expect, it } from 'vitest';
import { parseModelLimitDraft } from './limitDraft';

describe('model limit draft', () => {
  it('preserves human-readable token units', () => {
    expect(parseModelLimitDraft({ context: '20万', maxOutput: '8k' })).toEqual({
      contextWindow: 200000, maxOutputTokens: 8000,
    });
  });

  it('only treats an empty field as an explicit reset', () => {
    expect(parseModelLimitDraft({ context: ' ', maxOutput: '4096' })).toEqual({
      contextWindow: null, maxOutputTokens: 4096,
    });
    expect(parseModelLimitDraft({ context: '', maxOutput: '' })).toEqual({
      contextWindow: null, maxOutputTokens: null,
    });
  });

  it.each(['typo', '-1', '0', '128kb', '9'.repeat(400), '9007199254740992'])(
    'rejects %s without silently clearing saved limits', (invalid) => {
      expect(parseModelLimitDraft({ context: invalid, maxOutput: '8k' })).toBeNull();
      expect(parseModelLimitDraft({ context: '128k', maxOutput: invalid })).toBeNull();
    },
  );
});
