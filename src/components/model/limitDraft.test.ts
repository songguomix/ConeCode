import { describe, expect, it } from 'vitest';
import { parseModelLimitDraft } from './limitDraft';

describe('model limit draft', () => {
  it('preserves human-readable token units', () => {
    expect(parseModelLimitDraft({ context: '20万' })).toEqual({ contextWindow: 200000 });
  });

  it('only treats an empty field as an explicit reset', () => {
    expect(parseModelLimitDraft({ context: ' ' })).toEqual({ contextWindow: null });
    expect(parseModelLimitDraft({ context: '' })).toEqual({ contextWindow: null });
  });

  it.each(['typo', '-1', '0', '128kb', '9'.repeat(400), '9007199254740992'])(
    'rejects %s without silently clearing saved limits', (invalid) => {
      expect(parseModelLimitDraft({ context: invalid })).toBeNull();
    },
  );
});
