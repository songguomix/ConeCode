import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { gptDetector, type GptDetectionResult } from '../core/constraints/gptDetector';
import type { AIModel, ProviderConfig } from '../types';
import { getGptConstraintStatus, learnGptConstraintAlias } from './gptConstraintChoice';
import { useModelStore } from './model.store';
import { useProviderStore } from './provider.store';

const GPT = 'gpt-4o';
const OTHER = 'claude-sonnet';
const ALIAS = 'private-deployment';
const probe: GptDetectionResult = {
  isGpt: true, rawModel: ALIAS, normalizedModel: GPT, isReasoningSeries: false,
  source: 'response_fingerprint', fingerprint: 'fp_abc',
};

type Answer = 'enable' | 'decline' | 'cancel';
const confirm = vi.fn<(id: string) => Promise<Answer>>();
const select = useModelStore.getState().selectModel;

function provider(id: string): ProviderConfig {
  return {
    id, name: id, type: 'custom', baseUrl: 'https://' + id + '.example', apiKey: '',
    defaultModel: GPT, timeout: 60000, enabled: true, createdAt: 1, updatedAt: 1,
  };
}

function model(providerId: string, id: string): AIModel {
  return {
    id, providerId, name: id, enabled: true, supportsText: true, supportsVision: false,
    supportsImageGeneration: false, supportsAudioInput: false, supportsAudioOutput: false,
    supportsFunctionCalling: true, supportsReasoning: false, contextWindow: 8192, maxOutputTokens: 1024,
  };
}

beforeEach(() => {
  confirm.mockReset().mockResolvedValue('enable');
  vi.stubGlobal('window', { electronAPI: {
    app: { confirmGptConstraints: confirm },
    recent: { add: async (id: string) => [id] },
  } });
  const providers = [provider('first'), provider('second')];
  useProviderStore.setState({ providers });
  useModelStore.setState({
    models: new Map(providers.map(({ id }) => [id, [GPT, OTHER, ALIAS].map((name) => model(id, name))])),
    selectedModelId: null, selectedProviderId: null,
  });
  gptDetector.clearAliasCache();
});

afterEach(() => {
  vi.unstubAllGlobals();
  localStorage.clear();
  gptDetector.clearAliasCache();
});

describe('GPT constraint consent on model selection', () => {
  it('asks on an explicit GPT pick after a silent restore, once for that selection', async () => {
    select(GPT, 'first', false);
    expect(confirm).not.toHaveBeenCalled();
    expect(getGptConstraintStatus('first', GPT)).toBe('UNASKED');

    select(GPT, 'first');
    select(GPT, 'first');
    expect(confirm.mock.calls).toEqual([[GPT]]);
    await Promise.resolve();
    expect(getGptConstraintStatus('first', GPT)).toBe('ENABLED');
    select(GPT, 'first');
    expect(confirm).toHaveBeenCalledTimes(1);
  });

  it('clears the decision when switching to a non-GPT model, then asks on a return pick', async () => {
    confirm.mockResolvedValueOnce('decline');
    select(GPT, 'first');
    await Promise.resolve();
    expect(getGptConstraintStatus('first', GPT)).toBe('DECLINED');
    select(OTHER, 'first');
    expect(getGptConstraintStatus('first', GPT)).toBe('UNASKED');
    expect(confirm).toHaveBeenCalledTimes(1);

    select(GPT, 'first');
    await Promise.resolve();
    expect(confirm.mock.calls).toEqual([[GPT], [GPT]]);
    expect(getGptConstraintStatus('first', GPT)).toBe('ENABLED');
  });

  it('discards an old dialog answer after switching providers and back to the same model ID', async () => {
    let answerFirst!: (choice: Answer) => void;
    confirm.mockImplementationOnce(() => new Promise<Answer>((resolve) => { answerFirst = resolve; }));
    select(GPT, 'first');
    select(GPT, 'second');
    await Promise.resolve();
    expect(getGptConstraintStatus('second', GPT)).toBe('ENABLED');
    expect(getGptConstraintStatus('first', GPT)).toBe('UNASKED');

    confirm.mockResolvedValueOnce('decline');
    select(GPT, 'first');
    await Promise.resolve();
    answerFirst('enable');
    await Promise.resolve();
    expect(confirm).toHaveBeenCalledTimes(3);
    expect(getGptConstraintStatus('first', GPT)).toBe('DECLINED');
    expect(getGptConstraintStatus('second', GPT)).toBe('UNASKED');
  });

  it('waits for alias identification and deduplicates repeated probes, even after cancellation', async () => {
    confirm.mockResolvedValueOnce('cancel');
    select(ALIAS, 'first');
    expect(confirm).not.toHaveBeenCalled();
    learnGptConstraintAlias('first', ALIAS, probe);
    learnGptConstraintAlias('first', ALIAS, probe);
    await Promise.resolve();
    learnGptConstraintAlias('first', ALIAS, probe);
    expect(confirm.mock.calls).toEqual([[ALIAS]]);
    expect(getGptConstraintStatus('first', ALIAS)).toBe('UNASKED');

    select(ALIAS, 'first');
    await Promise.resolve();
    expect(confirm.mock.calls).toEqual([[ALIAS], [ALIAS]]);
    expect(getGptConstraintStatus('first', ALIAS)).toBe('ENABLED');
  });

  it('keeps a late alias probe scoped to its provider and a restored alias silent', async () => {
    select(ALIAS, 'first');
    select(ALIAS, 'second');
    learnGptConstraintAlias('first', ALIAS, probe);
    select(ALIAS, 'second');
    select(ALIAS, 'first', false);
    learnGptConstraintAlias('first', ALIAS, probe);
    expect(confirm).not.toHaveBeenCalled();

    select(ALIAS, 'first');
    await Promise.resolve();
    expect(confirm.mock.calls).toEqual([[ALIAS]]);
    expect(getGptConstraintStatus('first', ALIAS)).toBe('ENABLED');
  });
});
