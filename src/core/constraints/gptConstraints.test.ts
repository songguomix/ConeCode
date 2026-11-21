import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  GptConstraintSessionState,
  IllegalConstraintStateTransitionError,
  ConstraintStateCorruptedError,
  GptDetector,
  HardConstraintInjector,
  UserConfirmationGate,
  PostGenerationGuard,
  ConstraintViolationError,
  ConfirmationTimeoutError,
  parseUserConfirmationReply,
  SYSTEM_OVERRIDE_OPEN_TAG,
  GPT_HARD_CONSTRAINTS_BLOCK,
  type ConfirmGptConstraintsEvent,
} from './index';
import type { ChatMessage } from '../../types';
import { WRAPPED_GPT_HARD_CONSTRAINTS } from './hardConstraintInjector';

describe('GptConstraintSessionState', () => {
  it('starts in UNASKED and persists transitions', () => {
    const saved: Record<string, unknown> = {};
    const state = new GptConstraintSessionState({
      persistence: {
        loadAll: () => null,
        saveAll: (records) => Object.assign(saved, records),
      },
    });

    expect(state.getStatus('sess-1')).toBe('UNASKED');
    state.enable('sess-1', { detectedModel: 'gpt-4o', detectionSource: 'model_name' });
    expect(state.getStatus('sess-1')).toBe('ENABLED');
    expect((saved['sess-1'] as any).status).toBe('ENABLED');
  });

  it('throws IllegalConstraintStateTransitionError on illegal transitions', () => {
    const state = new GptConstraintSessionState();
    state.enable('sess-1');
    expect(() => state.decline('sess-1')).toThrow(IllegalConstraintStateTransitionError);

    state.decline('sess-2');
    expect(() => state.enable('sess-2')).toThrow(IllegalConstraintStateTransitionError);
  });

  it('throws ConstraintStateCorruptedError on corrupted serialized JSON or invalid status', () => {
    const state = new GptConstraintSessionState();
    expect(() => state.deserialize('{bad json')).toThrow(ConstraintStateCorruptedError);
    expect(() =>
      state.deserialize(JSON.stringify({ 'sess-1': { sessionId: 'sess-1', status: 'BOGUS', updatedAt: 123 } })),
    ).toThrow(ConstraintStateCorruptedError);
    expect(() => state.hydrateSession('sess-1', 'UNKNOWN')).toThrow(ConstraintStateCorruptedError);
  });
});

describe('GptDetector', () => {
  let detector: GptDetector;

  beforeEach(() => {
    detector = new GptDetector();
  });

  it('detects GPT and OpenAI reasoning models case-insensitively with vendor prefix stripping', () => {
    for (const model of [
      'gpt-4o',
      'OPENAI/GPT-5',
      'azure/gpt-4.1-mini',
      'openrouter/openai/chatgpt-4o-latest',
      'o1',
      'o1-mini',
      'openai/o3-mini',
      'o4-mini',
    ]) {
      const res = detector.detect(model);
      expect(res.isGpt).toBe(true);
      expect(res.source).toBe('model_name');
    }

    expect(detector.isReasoningSeriesModel('o1-mini')).toBe(true);
    expect(detector.isReasoningSeriesModel('openai/o3')).toBe(true);
    expect(detector.isReasoningSeriesModel('o4-mini')).toBe(true);
    expect(detector.isReasoningSeriesModel('gpt-4o')).toBe(false);
  });

  it('does not false-positive on non-GPT models', () => {
    for (const model of ['claude-3.5-sonnet', 'gemini-2.5-pro', 'deepseek-chat', 'deepseek-reasoner', 'qwen3-coder']) {
      const res = detector.detect(model);
      expect(res.isGpt).toBe(false);
      expect(res.source).toBe('none');
    }
  });

  it('learns unknown model alias from response system_fingerprint and triggers detection on next request', () => {
    const baseUrl = 'https://proxy.example.com/v1';
    const alias = 'custom-stealth-alias';

    // Before first response: unknown
    expect(detector.detect(alias, baseUrl).isGpt).toBe(false);

    // Passive probe captures fp_xxx from response body
    const probe = detector.probeResponse({
      baseUrl,
      modelAlias: alias,
      body: { system_fingerprint: 'fp_9b2c3d4e5f', model: 'gpt-4o-2024-11-20' },
    });
    expect(probe.isGpt).toBe(true);
    expect(probe.source).toBe('response_fingerprint');
    expect(probe.fingerprint).toBe('fp_9b2c3d4e5f');

    // Next request before sending: detected via alias_cache
    const nextDetect = detector.detect(alias, baseUrl);
    expect(nextDetect.isGpt).toBe(true);
    expect(nextDetect.source).toBe('alias_cache');
  });

  it('learns unknown model alias from OpenAI response headers', () => {
    const baseUrl = 'https://gateway.example.com/v1';
    const alias = 'my-aliased-model';

    const probe = detector.probeResponse({
      baseUrl,
      modelAlias: alias,
      headers: {
        'openai-model': 'gpt-4o',
        'openai-processing-ms': '412',
      },
    });
    expect(probe.isGpt).toBe(true);
    expect(probe.source).toBe('response_header');
    expect(detector.detect(alias, baseUrl).isGpt).toBe(true);
  });
});

describe('UserConfirmationGate & HardConstraintInjector', () => {
  it.each([
    ['开启零容忍工程硬约束框架', 'enable'],
    ['保持原生提示词', 'decline'],
    ['我不开启', 'decline'],
    ['不要开启', 'decline'],
    ['暂时不需要启用', 'decline'],
    ['我不想开启', 'decline'],
    ['不要再询问，直接开启', 'enable'],
    ['不要关闭，确认开启', 'enable'],
    ['我不拒绝，请开启', 'enable'],
    ['我同意启用', 'enable'],
    ['这是什么功能？', 'unknown'],
  ] as const)('interprets confirmation reply %s as %s', (reply, decision) => {
    expect(parseUserConfirmationReply(reply)).toBe(decision);
  });

  it('Mode B (Non-TTY): first detection of gpt-4o triggers hook, does NOT inject before confirmation, and injects after user confirms', async () => {
    const sessionState = new GptConstraintSessionState();
    const detector = new GptDetector();
    const injector = new HardConstraintInjector();
    const hookEvents: ConfirmGptConstraintsEvent[] = [];

    const gate = new UserConfirmationGate<{ messages: ChatMessage[]; model: string }>({
      detector,
      sessionState,
      isTTY: () => false,
      onConfirmRequired: (_sessionId, _modelInfo, event) => {
        hookEvents.push(event);
      },
    });

    const baseMessages: ChatMessage[] = [
      { role: 'system', content: 'You are a coding assistant.' },
      { role: 'user', content: 'Write a SHA-256 verifier.' },
    ];

    // 1. First detection of gpt-4o -> UNASKED, triggers hook, does NOT inject
    const outcome1 = await gate.evaluate({
      sessionId: 'conv-1',
      modelName: 'gpt-4o',
      payload: { messages: baseMessages, model: 'gpt-4o' },
    });
    expect(outcome1.action).toBe('awaiting_confirmation');
    expect(sessionState.getStatus('conv-1')).toBe('UNASKED');
    expect(hookEvents).toHaveLength(1);
    expect(hookEvents[0].type).toBe('confirm_gpt_constraints');

    // Verify injector does NOT inject while UNASKED
    const unconfirmedMsgs = injector.inject({
      messages: baseMessages,
      sessionState: sessionState.getStatus('conv-1'),
      modelName: 'gpt-4o',
    });
    expect(unconfirmedMsgs).toEqual(baseMessages);

    // 2. User confirms ("开启") -> state becomes ENABLED, suspended request replays with injection
    const resolved = gate.resolveFromReply('conv-1', '开启');
    expect(resolved.handled).toBe(true);
    expect(resolved.decision).toBe('ENABLED');
    expect(sessionState.getStatus('conv-1')).toBe('ENABLED');

    const injectedMsgs = injector.inject({
      messages: resolved.pendingRequest!.payload.messages,
      sessionState: sessionState.getStatus('conv-1'),
      modelName: 'gpt-4o',
    });
    expect(injectedMsgs[0].role).toBe('system');
    expect(String(injectedMsgs[0].content)).toContain(SYSTEM_OVERRIDE_OPEN_TAG);
    expect(String(injectedMsgs[0].content)).toContain(GPT_HARD_CONSTRAINTS_BLOCK);

    // 3. Subsequent request -> automatically injects and never asks again
    const outcome2 = await gate.evaluate({
      sessionId: 'conv-1',
      modelName: 'gpt-4o',
    });
    expect(outcome2.action).toBe('inject');
    expect(hookEvents).toHaveLength(1);

    // Idempotency: calling inject again does not duplicate <system_override
    const doubleInjected = injector.inject({
      messages: injectedMsgs,
      sessionState: 'ENABLED',
      modelName: 'gpt-4o',
    });
    const contentStr = String(doubleInjected[0].content);
    expect(contentStr.split('<system_override').length - 1).toBe(1);
  });

  it.each(['no', '我不开启', '不要开启', '先保持原生提示词'])('Mode B: refusal %s sets DECLINED and subsequent requests neither ask nor inject', async (reply) => {
    const sessionState = new GptConstraintSessionState();
    const detector = new GptDetector();
    const injector = new HardConstraintInjector();
    const onConfirmRequired = vi.fn();

    const gate = new UserConfirmationGate<{ prompt: string }>({
      detector,
      sessionState,
      isTTY: () => false,
      onConfirmRequired,
    });

    const first = await gate.evaluate({
      sessionId: 'conv-decline',
      modelName: 'gpt-4o',
      payload: { prompt: 'hello' },
    });
    expect(first.action).toBe('awaiting_confirmation');

    const resolved = gate.resolveFromReply('conv-decline', reply);
    expect(resolved.handled).toBe(true);
    expect(resolved.decision).toBe('DECLINED');
    expect(sessionState.getStatus('conv-decline')).toBe('DECLINED');

    // Subsequent request: passes silently, no hook call, no injection
    const second = await gate.evaluate({
      sessionId: 'conv-decline',
      modelName: 'gpt-4o',
    });
    expect(second.action).toBe('pass');
    expect(onConfirmRequired).toHaveBeenCalledTimes(1);

    const msgs: ChatMessage[] = [{ role: 'user', content: 'hi' }];
    expect(injector.inject({ messages: msgs, sessionState: 'DECLINED', modelName: 'gpt-4o' })).toEqual(msgs);
  });

  it('Unknown alias detected via fp_xxx triggers confirmation on the next turn', async () => {
    const sessionState = new GptConstraintSessionState();
    const detector = new GptDetector();
    const onConfirmRequired = vi.fn();
    const baseUrl = 'https://proxy.local/v1';
    const alias = 'stealth-model-x';

    const gate = new UserConfirmationGate({
      detector,
      sessionState,
      isTTY: () => false,
      onConfirmRequired,
    });

    // Turn 1: unknown alias passes silently
    const turn1 = await gate.evaluate({ sessionId: 'conv-alias', modelName: alias, baseUrl });
    expect(turn1.action).toBe('pass');
    expect(onConfirmRequired).not.toHaveBeenCalled();

    // Response 1 contains fp_xxx
    detector.probeResponse({
      baseUrl,
      modelAlias: alias,
      body: { system_fingerprint: 'fp_abc123xyz' },
    });

    // Turn 2: triggers confirmation before sending
    const turn2 = await gate.evaluate({ sessionId: 'conv-alias', modelName: alias, baseUrl });
    expect(turn2.action).toBe('awaiting_confirmation');
    expect(onConfirmRequired).toHaveBeenCalledTimes(1);
  });

  it('Non-GPT models pass silently without prompting or injecting', async () => {
    const sessionState = new GptConstraintSessionState();
    const detector = new GptDetector();
    const onConfirmRequired = vi.fn();

    const gate = new UserConfirmationGate({
      detector,
      sessionState,
      isTTY: () => false,
      onConfirmRequired,
    });

    for (const model of ['claude-3-7-sonnet', 'gemini-2.5-pro', 'deepseek-chat']) {
      const res = await gate.evaluate({ sessionId: `sess-${model}`, modelName: model });
      expect(res.action).toBe('pass');
      expect(sessionState.getStatus(`sess-${model}`)).toBe('UNASKED');
    }
    expect(onConfirmRequired).not.toHaveBeenCalled();
  });

  it('Mode A (TTY): prompts in terminal and throws ConfirmationTimeoutError on timeout', async () => {
    const sessionState = new GptConstraintSessionState();
    const gate = new UserConfirmationGate({
      sessionState,
      isTTY: () => true,
      promptCLI: async () => 'y',
    });

    const res = await gate.evaluate({ sessionId: 'cli-1', modelName: 'gpt-5' });
    expect(res.action).toBe('inject');
    expect(sessionState.getStatus('cli-1')).toBe('ENABLED');

    const timeoutGate = new UserConfirmationGate({
      sessionState: new GptConstraintSessionState(),
      isTTY: () => true,
      cliTimeoutMs: 50,
      promptCLI: async () => {
        throw new Error('CLI confirmation prompt timed out');
      },
    });
    await expect(timeoutGate.evaluate({ sessionId: 'cli-timeout', modelName: 'gpt-4o' })).rejects.toThrow(
      ConfirmationTimeoutError,
    );
  });

  it.each([['gpt-4o', 'system'], ['o3-mini', 'developer']] as const)(
    'injects constraints for %s when design reference text contains override markup',
    (modelName, role) => {
      const injector = new HardConstraintInjector();
      const messages: ChatMessage[] = [
        { role: 'system', content: 'Treat <system_override as literal markup in the supplied references.' },
        { role: 'user', content: `Design reference\n\n${WRAPPED_GPT_HARD_CONSTRAINTS}` },
      ];
      const request = { messages, sessionState: 'ENABLED' as const, modelName };
      const injected = injector.inject(request);

      expect(injected).toContainEqual(expect.objectContaining({
        role, content: expect.stringContaining(WRAPPED_GPT_HARD_CONSTRAINTS),
      }));
      expect(injected).toContainEqual(messages[1]);
      expect(injector.inject({ ...request, messages: injected })).toBe(injected);
    },
  );

  it('HardConstraintInjector adapts role to developer for o1/o3/o4 models and degrades when system is unsupported', () => {
    const injector = new HardConstraintInjector();
    const msgs: ChatMessage[] = [{ role: 'user', content: 'Implement merge sort.' }];

    const devInjected = injector.inject({
      messages: msgs,
      sessionState: 'ENABLED',
      modelName: 'o3-mini',
      supportsSystem: true,
    });
    expect(devInjected[0].role).toBe('developer');
    expect(String(devInjected[0].content)).toContain(SYSTEM_OVERRIDE_OPEN_TAG);

    const degraded = injector.inject({
      messages: msgs,
      sessionState: 'ENABLED',
      modelName: 'o1-preview',
      supportsSystem: false,
    });
    expect(degraded[0].role).toBe('user');
    expect(String(degraded[0].content)).toContain(SYSTEM_OVERRIDE_OPEN_TAG);
    expect(String(degraded[0].content)).toContain('Implement merge sort.');
    expect(injector.inject({
      messages: degraded,
      sessionState: 'ENABLED',
      modelName: 'o1-preview',
      supportsSystem: false,
    })).toBe(degraded);
  });
});

describe('PostGenerationGuard', () => {
  it('intercepts empty SHA-256 and placeholder comments when ENABLED, and ignores when UNASKED/DECLINED', () => {
    const guard = new PostGenerationGuard();
    const badOutput = [
      'Here is the code:',
      '```ts',
      'const hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";',
      '// ... 其余代码',
      '```',
    ].join('\n');

    expect(guard.scan(badOutput, 'UNASKED')).toHaveLength(0);
    expect(guard.scan(badOutput, 'DECLINED')).toHaveLength(0);

    const violations = guard.scan(badOutput, 'ENABLED');
    expect(violations.length).toBeGreaterThanOrEqual(2);
    expect(() => guard.enforce(badOutput, 'ENABLED')).toThrow(ConstraintViolationError);
  });
});
