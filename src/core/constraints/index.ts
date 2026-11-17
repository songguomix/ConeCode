export {
  GptConstraintSessionState,
  gptConstraintSessionState,
  IllegalConstraintStateTransitionError,
  ConstraintStateCorruptedError,
  type ConstraintSessionStatus,
  type DetectionSource,
  type GptConstraintSessionRecord,
  type ConstraintStatePersistenceAdapter,
  type GptConstraintSessionStateOptions,
} from './gptSessionState';

export {
  GptDetector,
  gptDetector,
  type GptDetectionResult,
  type AliasCacheEntry,
  type ResponseProbeInput,
} from './gptDetector';

export {
  HardConstraintInjector,
  hardConstraintInjector,
  GPT_HARD_CONSTRAINTS_BLOCK,
  SYSTEM_OVERRIDE_OPEN_TAG,
  SYSTEM_OVERRIDE_CLOSE_TAG,
  type InjectConstraintsParams,
} from './hardConstraintInjector';

export {
  UserConfirmationGate,
  userConfirmationGate,
  ConfirmationTimeoutError,
  formatCliConfirmationPrompt,
  formatInteractiveConfirmationPrompt,
  parseUserConfirmationReply,
  type ConfirmGptConstraintsEvent,
  type PendingConfirmationRequest,
  type ConfirmationGateOutcome,
  type OnConfirmRequiredHook,
  type UserConfirmationGateOptions,
} from './userConfirmationGate';

export {
  PostGenerationGuard,
  postGenerationGuard,
  ConstraintViolationError,
  type ConstraintViolation,
} from './postGenerationGuard';
