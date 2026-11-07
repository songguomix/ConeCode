import { CuaError } from '../protocol/errors.js';
import type { ModelAdapter, ModelCapabilities, ModelRequest, ModelResponse, ModelToolCall } from './types.js';

export type ScriptStep =
  | { kind: 'tool'; name: string; arguments: Record<string, unknown>; id?: string }
  | { kind: 'text'; text: string }
  | { kind: 'error'; code: string; message: string; retryable?: boolean }
  | { kind: 'response'; response: ModelResponse }
  | { kind: 'delay'; ms: number };

/**
 * Deterministic adapter used by controller and browser tests. It is explicitly
 * labelled "scripted" everywhere so its results are never presented as a real
 * model evaluation.
 */
export class ScriptedAdapter implements ModelAdapter {
  readonly id: string;
  readonly requests: ModelRequest[] = [];
  private readonly steps: ScriptStep[];
  private cursor = 0;
  private readonly capabilitiesValue: ModelCapabilities;

  constructor(steps: ScriptStep[], options: { id?: string; capabilities?: Partial<ModelCapabilities> } = {}) {
    this.steps = steps;
    this.id = options.id ?? 'scripted-deterministic';
    this.capabilitiesValue = {
      tools: true,
      images: false,
      structuredOutput: false,
      nativeComputerActions: false,
      notes: ['Deterministic test adapter. No model inference is performed.'],
      ...options.capabilities,
    };
  }

  capabilities(): ModelCapabilities {
    return this.capabilitiesValue;
  }

  get remaining(): number {
    return Math.max(0, this.steps.length - this.cursor);
  }

  async complete(request: ModelRequest): Promise<ModelResponse> {
    this.requests.push(structuredClone(request));
    const step = this.steps[this.cursor++];
    if (!step) {
      throw new CuaError('MODEL_ERROR', 'Scripted adapter ran out of steps.', {
        details: { step: this.cursor, total: this.steps.length },
      });
    }
    if (step.kind === 'delay') {
      await new Promise((r) => setTimeout(r, step.ms));
      return this.complete(request);
    }
    if (step.kind === 'error') {
      throw new CuaError(step.code as any, step.message, { retryable: step.retryable ?? false });
    }
    if (step.kind === 'text') {
      return {
        text: step.text,
        toolCalls: [],
        usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
        stopReason: 'stop',
      };
    }
    if (step.kind === 'response') return step.response;
    const call: ModelToolCall = {
      id: step.id ?? `call_${this.cursor}`,
      name: step.name,
      arguments: JSON.stringify(step.arguments),
    };
    return {
      toolCalls: [call],
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      stopReason: 'tool_calls',
    };
  }
}
