import { GptDetector, gptDetector, type GptDetectionResult } from './gptDetector';
import {
  GptConstraintSessionState,
  gptConstraintSessionState,
  type ConstraintSessionStatus,
} from './gptSessionState';

export class ConfirmationTimeoutError extends Error {
  readonly sessionId: string;
  readonly timeoutMs: number;

  constructor(sessionId: string, timeoutMs: number) {
    super(`GPT constraint confirmation timed out after ${timeoutMs}ms for session "${sessionId}"`);
    this.name = 'ConfirmationTimeoutError';
    this.sessionId = sessionId;
    this.timeoutMs = timeoutMs;
  }
}

export interface ConfirmGptConstraintsEvent {
  type: 'confirm_gpt_constraints';
  sessionId: string;
  modelInfo: GptDetectionResult;
  promptText: string;
  options: [string, string];
}

export interface PendingConfirmationRequest<TPayload = unknown> {
  sessionId: string;
  modelName: string;
  baseUrl?: string;
  modelInfo: GptDetectionResult;
  payload: TPayload;
  createdAt: number;
}

export type ConfirmationGateOutcome<TPayload = unknown> =
  | { action: 'pass'; state: ConstraintSessionStatus; modelInfo: GptDetectionResult }
  | { action: 'inject'; state: 'ENABLED'; modelInfo: GptDetectionResult }
  | {
      action: 'awaiting_confirmation';
      state: 'UNASKED';
      modelInfo: GptDetectionResult;
      event: ConfirmGptConstraintsEvent;
    }
  | {
      action: 'resolved';
      state: 'ENABLED' | 'DECLINED';
      modelInfo: GptDetectionResult;
      replayedRequest?: PendingConfirmationRequest<TPayload>;
    };

export type OnConfirmRequiredHook = (
  sessionId: string,
  modelInfo: GptDetectionResult,
  event: ConfirmGptConstraintsEvent,
) => void | Promise<void>;

export interface UserConfirmationGateOptions {
  detector?: GptDetector;
  sessionState?: GptConstraintSessionState;
  onConfirmRequired?: OnConfirmRequiredHook;
  /** Override TTY detection (primarily for deterministic testing). */
  isTTY?: () => boolean;
  /** Override CLI prompt reader (primarily for deterministic testing). */
  promptCLI?: (promptText: string, timeoutMs: number) => Promise<string>;
  /** Timeout in milliseconds for CLI confirmation input (default 60000ms). */
  cliTimeoutMs?: number;
}

const ENABLE_REPLIES = new Set(['y', 'yes', '1', 'true', '开启', '确认', '启用', '同意', '是']);
const DECLINE_REPLIES = new Set(['n', 'no', '0', 'false', '拒绝', '关闭', '不开启', '保持原生', '否']);

export function formatCliConfirmationPrompt(modelName: string): string {
  return `[检测到 GPT 系列模型: ${modelName}] 是否开启「零容忍工程硬约束框架」？（可防止代码省略、静默吞异常、假 SHA-256 占位等模型惯性）[Y/n]: `;
}

export function formatInteractiveConfirmationPrompt(modelName: string): string {
  return `[检测到 GPT 系列模型: ${modelName}] 是否开启「零容忍工程硬约束框架」？（可防止代码省略、静默吞异常、假 SHA-256 占位等模型惯性）`;
}

export function parseUserConfirmationReply(reply: string): 'enable' | 'decline' | 'unknown' {
  const normalized = reply.trim().toLowerCase();
  if (ENABLE_REPLIES.has(normalized)) return 'enable';
  if (DECLINE_REPLIES.has(normalized)) return 'decline';
  // Match a negated action before its affirmative substring, while keeping
  // unrelated negatives such as “不要再询问，直接开启” affirmative.
  if (/(?:不(?:要|用|想|必|需要)?|无需|无须|暂不|先不|别)\s*(?:开启|启用|确认|同意)|(?<!不)(?:拒绝|保持原生)/.test(normalized)) return 'decline';
  if (/开启|启用|确认|同意/.test(normalized)) return 'enable';
  return 'unknown';
}

function defaultIsTTY(): boolean {
  return typeof process !== 'undefined'
    && Boolean(process.stdin?.isTTY)
    && Boolean(process.stdout?.isTTY);
}

async function defaultPromptCLI(promptText: string, timeoutMs: number): Promise<string> {
  // The desktop renderer uses the interactive confirmation event instead.
  const readline = await import('node:readline');
  return new Promise<string>((resolve, reject) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      rl.close();
      reject(new Error('CLI confirmation prompt timed out'));
    }, timeoutMs);

    rl.question(promptText, (answer) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      rl.close();
      resolve(answer);
    });
  });
}

/**
 * Confirmation gate that bridges GptDetector and GptConstraintSessionState:
 * - Mode A (CLI / TTY): suspends request, prints interactive `[Y/n]` prompt, updates state.
 * - Mode B (Web / API / Non-TTY): fires `onConfirmRequired`, returns structured
 *   `confirm_gpt_constraints` event, and suspends the original request in a per-session
 *   queue until the user replies with confirmation or declination.
 */
export class UserConfirmationGate<TPayload = unknown> {
  private readonly detector: GptDetector;
  private readonly sessionState: GptConstraintSessionState;
  private readonly pendingRequests = new Map<string, PendingConfirmationRequest<TPayload>>();
  private onConfirmRequired?: OnConfirmRequiredHook;
  private readonly isTTYFn: () => boolean;
  private readonly promptCLIFn: (promptText: string, timeoutMs: number) => Promise<string>;
  private readonly cliTimeoutMs: number;

  constructor(options: UserConfirmationGateOptions = {}) {
    this.detector = options.detector ?? gptDetector;
    this.sessionState = options.sessionState ?? gptConstraintSessionState;
    this.onConfirmRequired = options.onConfirmRequired;
    this.isTTYFn = options.isTTY ?? defaultIsTTY;
    this.promptCLIFn = options.promptCLI ?? defaultPromptCLI;
    this.cliTimeoutMs = options.cliTimeoutMs ?? 60_000;
  }

  setOnConfirmRequired(hook: OnConfirmRequiredHook | undefined): void {
    this.onConfirmRequired = hook;
  }

  hasPendingConfirmation(sessionId: string): boolean {
    return this.pendingRequests.has(sessionId);
  }

  getPendingConfirmation(sessionId: string): PendingConfirmationRequest<TPayload> | undefined {
    return this.pendingRequests.get(sessionId);
  }

  clearPendingConfirmation(sessionId: string): boolean {
    return this.pendingRequests.delete(sessionId);
  }

  async evaluate(params: {
    sessionId: string;
    modelName: string;
    baseUrl?: string;
    payload?: TPayload;
  }): Promise<ConfirmationGateOutcome<TPayload>> {
    const modelInfo = this.detector.detect(params.modelName, params.baseUrl);
    if (!modelInfo.isGpt) {
      return {
        action: 'pass',
        state: this.sessionState.getStatus(params.sessionId),
        modelInfo,
      };
    }

    const currentState = this.sessionState.getStatus(params.sessionId);
    if (currentState === 'ENABLED') {
      return {
        action: 'inject',
        state: 'ENABLED',
        modelInfo,
      };
    }

    if (currentState === 'DECLINED') {
      return {
        action: 'pass',
        state: 'DECLINED',
        modelInfo,
      };
    }

    // Current state is UNASKED and target is GPT.
    if (this.isTTYFn()) {
      const cliPrompt = formatCliConfirmationPrompt(params.modelName);
      let rawAnswer: string;
      try {
        rawAnswer = await this.promptCLIFn(cliPrompt, this.cliTimeoutMs);
      } catch (error) {
        if (error instanceof ConfirmationTimeoutError) {
          throw error;
        }
        if (error instanceof Error && /timed? ?out/i.test(error.message)) {
          throw new ConfirmationTimeoutError(params.sessionId, this.cliTimeoutMs);
        }
        throw error;
      }

      const trimmed = rawAnswer.trim();
      // Empty Enter defaults to Yes (`[Y/n]`)
      const intent = trimmed === '' ? 'enable' : parseUserConfirmationReply(trimmed);
      if (intent === 'decline') {
        this.sessionState.decline(params.sessionId, {
          detectedModel: modelInfo.normalizedModel,
          detectionSource: modelInfo.source,
        });
        return {
          action: 'pass',
          state: 'DECLINED',
          modelInfo,
        };
      }

      this.sessionState.enable(params.sessionId, {
        detectedModel: modelInfo.normalizedModel,
        detectionSource: modelInfo.source,
      });
      return {
        action: 'inject',
        state: 'ENABLED',
        modelInfo,
      };
    }

    // Mode B: Non-TTY / Web / Desktop streaming UI
    const event: ConfirmGptConstraintsEvent = {
      type: 'confirm_gpt_constraints',
      sessionId: params.sessionId,
      modelInfo,
      promptText: formatInteractiveConfirmationPrompt(params.modelName),
      options: ['开启零容忍工程硬约束框架', '保持原生提示词'],
    };

    if (params.payload !== undefined) {
      this.pendingRequests.set(params.sessionId, {
        sessionId: params.sessionId,
        modelName: params.modelName,
        baseUrl: params.baseUrl,
        modelInfo,
        payload: params.payload,
        createdAt: Date.now(),
      });
    }

    if (this.onConfirmRequired) {
      await this.onConfirmRequired(params.sessionId, modelInfo, event);
    }

    return {
      action: 'awaiting_confirmation',
      state: 'UNASKED',
      modelInfo,
      event,
    };
  }

  /**
   * Resolve a suspended confirmation in Mode B using the user's next message or button click.
   */
  resolveFromReply(
    sessionId: string,
    replyText: string,
  ): {
    handled: boolean;
    decision?: 'ENABLED' | 'DECLINED';
    pendingRequest?: PendingConfirmationRequest<TPayload>;
  } {
    const pending = this.pendingRequests.get(sessionId);
    if (!pending) {
      return { handled: false };
    }

    const intent = parseUserConfirmationReply(replyText);
    if (intent === 'unknown') {
      return { handled: false };
    }

    this.pendingRequests.delete(sessionId);
    if (intent === 'enable') {
      this.sessionState.enable(sessionId, {
        detectedModel: pending.modelInfo.normalizedModel,
        detectionSource: pending.modelInfo.source,
      });
      return {
        handled: true,
        decision: 'ENABLED',
        pendingRequest: pending,
      };
    }

    this.sessionState.decline(sessionId, {
      detectedModel: pending.modelInfo.normalizedModel,
      detectionSource: pending.modelInfo.source,
    });
    return {
      handled: true,
      decision: 'DECLINED',
      pendingRequest: pending,
    };
  }
}

export const userConfirmationGate = new UserConfirmationGate();
