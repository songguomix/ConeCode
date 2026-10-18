import { describe, expect, it } from 'vitest';
import type { Message } from '../../types';
import { responseHealth } from './responseHealth';
const message = (id: string, patch: Partial<Message> = {}): Message => ({ id, conversationId: 'c', role: 'assistant', providerId: 'p', modelId: 'm', content: 'answer', createdAt: 0, ...patch });
describe('response evidence', () => {
  it('does not label a single missing reasoning response as an anomaly', () => {
    expect(responseHealth([message('1')], 'p', 'm', true).missingReasoning).toBe(false);
  });
  it('requires repeated observations and a declared reasoning capability', () => {
    const messages = [message('1'), message('2'), message('3')];
    expect(responseHealth(messages, 'p', 'm', true).missingReasoning).toBe(true);
    expect(responseHealth(messages, 'p', 'm', false).missingReasoning).toBe(false);
  });
  it('isolates providers and models, ignoring tool results and local notices', () => {
    const messages = [message('1'), message('2', { providerId: 'other' }), message('3', { isToolResult: true }), message('4', { isLocalNotice: true })];
    expect(responseHealth(messages, 'p', 'm', true).samples).toBe(1);
  });
  it('recognizes thinking blocks and reports interruptions independently', () => {
    const result = responseHealth([message('1', { thinkingBlocks: [{ thinking: 'summary' }] }), message('2', { interrupted: true }), message('3', { interrupted: true })], 'p', 'm', true);
    expect(result.reasoning).toBe(1);
    expect(result.missingReasoning).toBe(false);
    expect(result.repeatedInterruptions).toBe(true);
  });
});
