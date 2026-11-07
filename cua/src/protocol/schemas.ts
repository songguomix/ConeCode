import { z } from 'zod';

export const PROTOCOL_VERSION = 1 as const;

const IsoDate = z.string().datetime();
const HttpUrl = z
  .string()
  .url()
  .refine((value) => {
    try {
      return /^https?:$/.test(new URL(value).protocol);
    } catch {
      return false;
    }
  }, 'Only http(s) URLs are supported');
const Id = (prefix: string) =>
  z.string().regex(new RegExp(`^${prefix}_[0-9a-f-]{36}$`), `Expected a ${prefix}_ id`);

export const IdSchema = {
  task: Id('task'),
  run: Id('run'),
  session: Id('ses'),
  observation: Id('obs'),
  action: Id('act'),
  verification: Id('ver'),
  event: Id('evt'),
  artifact: Id('art'),
  checkpoint: Id('ckpt'),
  workflow: Id('wf'),
  message: Id('msg'),
  call: Id('call'),
} as const;

// ---------------------------------------------------------------------------
// Conditions and acceptance
// ---------------------------------------------------------------------------

export const ConditionSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('text_visible'),
    text: z.string().min(1),
    scope: z.enum(['page', 'frame', 'dialog']).default('page'),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('text_absent'),
    text: z.string().min(1),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('value_equals'),
    targetId: z.string().min(1),
    value: z.string(),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('url_matches'),
    pattern: z.string().min(1),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('record_field'),
    url: HttpUrl,
    method: z.enum(['GET', 'POST']).default('GET'),
    path: z.array(z.union([z.string(), z.number().int()])).min(1),
    equals: z.unknown(),
    headers: z.record(z.string(), z.string()).optional(),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('download'),
    filename: z.string().min(1),
    sha256: z.string().regex(/^[a-f0-9]{64}$/i).optional(),
    contains: z.string().optional(),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('file_content'),
    path: z.string().min(1),
    contains: z.string().optional(),
    equals: z.string().optional(),
    withinMs: z.number().int().min(0).max(120_000).optional(),
  }),
  z.object({
    kind: z.literal('file_exists'),
    path: z.string().min(1),
  }),
  z.object({
    kind: z.literal('window_title'),
    contains: z.string().min(1),
  }),
  z.object({
    kind: z.literal('http_status'),
    url: HttpUrl,
    method: z.enum(['GET', 'HEAD', 'POST']).default('GET'),
    status: z.number().int().min(100).max(599),
    headers: z.record(z.string(), z.string()).optional(),
    body: z.unknown().optional(),
  }),
  z.object({
    kind: z.literal('custom'),
    description: z.string().min(1),
  }),
]);

export type Condition = z.infer<typeof ConditionSchema>;

export const AcceptanceSource = z.enum(['user', 'template', 'operator']);
export type AcceptanceSource = z.infer<typeof AcceptanceSource>;

// ---------------------------------------------------------------------------
// Budgets and authorization
// ---------------------------------------------------------------------------

export const BudgetSchema = z
  .object({
    maxSteps: z.number().int().positive().default(30),
    maxModelCalls: z.number().int().positive().default(20),
    maxCodeRuns: z.number().int().min(0).default(5),
    maxRetriesPerAction: z.number().int().min(0).default(2),
    maxWallClockMs: z.number().int().positive().default(10 * 60_000),
    maxCostUsd: z.number().nonnegative().default(2),
    maxInputTokens: z.number().int().positive().default(200_000),
    maxOutputTokens: z.number().int().positive().default(20_000),
  })
  .strict();

export type Budget = z.infer<typeof BudgetSchema>;

export const DEFAULT_BUDGET: Budget = BudgetSchema.parse({});

export const AuthorizationScopeSchema = z
  .object({
    allowedOrigins: z.array(z.string()).default([]),
    allowedTools: z.array(z.string()).default([]),
    allowDesktop: z.boolean().default(false),
    allowCode: z.boolean().default(false),
    allowedFileRoots: z.array(z.string()).default([]),
    allowedRecipients: z.array(z.string()).default([]),
    expiresAt: IsoDate.optional(),
  })
  .strict();

export type AuthorizationScope = z.infer<typeof AuthorizationScopeSchema>;

// ---------------------------------------------------------------------------
// Environment and capabilities
// ---------------------------------------------------------------------------

export const EnvironmentSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('browser'),
    startUrl: HttpUrl.optional(),
    profile: z.string().default('default'),
    headless: z.boolean().default(true),
    viewport: z.object({ width: z.number().int().positive(), height: z.number().int().positive() }).optional(),
  }),
  z.object({
    kind: z.literal('desktop'),
    appName: z.string().optional(),
    workdir: z.string().optional(),
  }),
]);

export type Environment = z.infer<typeof EnvironmentSchema>;

export const CapabilitiesSchema = z.object({
  observe: z.boolean(),
  screenshot: z.boolean(),
  click: z.boolean(),
  type: z.boolean(),
  unicodeType: z.boolean(),
  scroll: z.boolean(),
  drag: z.boolean(),
  key: z.boolean(),
  tabs: z.boolean(),
  code: z.boolean(),
  actions: z.array(z.string()),
  notes: z.array(z.string()).default([]),
});

export type Capabilities = z.infer<typeof CapabilitiesSchema>;

// ---------------------------------------------------------------------------
// Targets and observations
// ---------------------------------------------------------------------------

export const BBoxSchema = z.object({
  x: z.number(),
  y: z.number(),
  width: z.number().nonnegative(),
  height: z.number().nonnegative(),
});

export const TargetSchema = z.object({
  targetId: z.string().min(1),
  frameId: z.string().default('main'),
  role: z.string(),
  name: z.string().max(500),
  tag: z.string(),
  type: z.string().optional(),
  value: z.string().max(1000).optional(),
  placeholder: z.string().max(500).optional(),
  checked: z.boolean().optional(),
  disabled: z.boolean().optional(),
  visible: z.boolean(),
  actionable: z.boolean(),
  bbox: BBoxSchema.optional(),
  attributes: z.record(z.string(), z.string()).default({}),
  ordinal: z.number().int().nonnegative().optional(),
  duplicateKey: z.string().optional(),
});

export type Target = z.infer<typeof TargetSchema>;

export const ScreenshotMetaSchema = z.object({
  artifactId: IdSchema.artifact.optional(),
  path: z.string(),
  width: z.number().int().positive(),
  height: z.number().int().positive(),
  viewportWidth: z.number().positive(),
  viewportHeight: z.number().positive(),
  scaleX: z.number().positive(),
  scaleY: z.number().positive(),
  scrollX: z.number(),
  scrollY: z.number(),
  offsetX: z.number().default(0),
  offsetY: z.number().default(0),
  devicePixelRatio: z.number().positive(),
  fullPage: z.boolean().default(false),
});

export type ScreenshotMeta = z.infer<typeof ScreenshotMetaSchema>;

export const ObservationSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: IdSchema.observation,
  taskId: IdSchema.task,
  runId: IdSchema.run,
  sessionId: IdSchema.session,
  surfaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  at: IsoDate,
  interface: z.object({
    kind: z.enum(['browser', 'desktop']),
    url: z.string().optional(),
    title: z.string().optional(),
    appName: z.string().optional(),
    windowTitle: z.string().optional(),
    displayId: z.string().optional(),
    tabs: z
      .array(z.object({ tabId: z.string(), url: z.string(), title: z.string(), active: z.boolean() }))
      .optional(),
  }),
  viewport: z
    .object({
      width: z.number().positive(),
      height: z.number().positive(),
      scrollX: z.number(),
      scrollY: z.number(),
      devicePixelRatio: z.number().positive(),
    })
    .optional(),
  screenshot: ScreenshotMetaSchema.optional(),
  visibleText: z.string(),
  targets: z.array(TargetSchema),
  frames: z.array(z.object({ frameId: z.string(), url: z.string() })).default([]),
  coverage: z.object({
    textTruncated: z.boolean(),
    targetsTruncated: z.boolean(),
    hiddenTargets: z.number().int().nonnegative().default(0),
    offscreenTargets: z.number().int().nonnegative().default(0),
    crossOriginFrames: z.number().int().nonnegative().default(0),
    shadowRoots: z.number().int().nonnegative().default(0),
    openDialogs: z.number().int().nonnegative().default(0),
    coverageNotes: z.array(z.string()).default([]),
    unreadableRegions: z.array(z.string()).default([]),
  }),
  redactions: z.array(z.string()).default([]),
});

export type Observation = z.infer<typeof ObservationSchema>;
export type ObservationInput = Omit<Observation, 'schemaVersion'> & { schemaVersion?: 1 };

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

const TargetId = z.string().min(1);
const Coordinate = z.tuple([z.number(), z.number()]);

export const BrowserActionSchema = z.discriminatedUnion('tool', [
  z.object({ tool: z.literal('browser.navigate'), url: HttpUrl }),
  z.object({
    tool: z.literal('browser.open_tab'),
    url: HttpUrl.optional(),
    focus: z.boolean().default(true),
  }),
  z.object({ tool: z.literal('browser.switch_tab'), tabId: z.string().min(1) }),
  z.object({ tool: z.literal('browser.close_tab'), tabId: z.string().min(1) }),
  z.object({
    tool: z.literal('browser.click'),
    targetId: TargetId.optional(),
    coordinate: Coordinate.optional(),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    clickCount: z.number().int().min(1).max(3).default(1),
  }),
  z.object({ tool: z.literal('browser.fill'), targetId: TargetId, value: z.string().max(20_000) }),
  z.object({
    tool: z.literal('browser.type'),
    text: z.string().min(1).max(20_000),
    targetId: TargetId.optional(),
    clearFirst: z.boolean().default(false),
  }),
  z.object({
    tool: z.literal('browser.press'),
    key: z.string().min(1),
    targetId: TargetId.optional(),
  }),
  z.object({
    tool: z.literal('browser.scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().positive().max(20).default(3),
    targetId: TargetId.optional(),
  }),
  z.object({
    tool: z.literal('browser.hover'),
    targetId: TargetId.optional(),
    coordinate: Coordinate.optional(),
  }),
  z.object({
    tool: z.literal('browser.drag'),
    fromTargetId: TargetId.optional(),
    from: Coordinate.optional(),
    toTargetId: TargetId.optional(),
    to: Coordinate.optional(),
  }),
  z.object({
    tool: z.literal('browser.wait_for'),
    condition: ConditionSchema,
    timeoutMs: z.number().int().positive().max(120_000).default(10_000),
  }),
  z.object({ tool: z.literal('browser.screenshot') }),
  z.object({ tool: z.literal('browser.observe') }),
]);

export const DesktopActionSchema = z.discriminatedUnion('tool', [
  z.object({
    tool: z.literal('desktop.click'),
    x: z.number().nonnegative(),
    y: z.number().nonnegative(),
    button: z.enum(['left', 'right', 'middle']).default('left'),
    clickCount: z.number().int().min(1).max(3).default(1),
  }),
  z.object({ tool: z.literal('desktop.move'), x: z.number().nonnegative(), y: z.number().nonnegative() }),
  z.object({
    tool: z.literal('desktop.drag'),
    from: Coordinate,
    to: Coordinate,
    durationMs: z.number().int().positive().max(10_000).default(500),
  }),
  z.object({ tool: z.literal('desktop.type'), text: z.string().min(1).max(10_000) }),
  z.object({ tool: z.literal('desktop.key'), key: z.string().min(1) }),
  z.object({
    tool: z.literal('desktop.scroll'),
    direction: z.enum(['up', 'down', 'left', 'right']),
    amount: z.number().int().positive().max(50).default(3),
    x: z.number().nonnegative().optional(),
    y: z.number().nonnegative().optional(),
  }),
  z.object({ tool: z.literal('desktop.screenshot') }),
  z.object({ tool: z.literal('desktop.focus_app'), appName: z.string().min(1) }),
  z.object({ tool: z.literal('desktop.open_app'), appName: z.string().min(1) }),
  z.object({
    tool: z.literal('desktop.edit_document'),
    appName: z.literal('TextEdit').default('TextEdit'),
    content: z.string().max(20_000),
    savePath: z.string().min(1),
  }),
]);

export const CodeActionSchema = z.object({
  tool: z.literal('code.run'),
  code: z.string().min(1).max(100_000),
  timeoutMs: z.number().int().positive().max(60_000).default(5_000),
});

export const TaskFinishActionSchema = z.object({
  tool: z.literal('task.finish'),
  summary: z.string().min(1).max(4_000),
  /** Model suggestions. They are recorded but never replace user acceptance. */
  suggestedChecks: z.array(ConditionSchema).default([]),
});

export const ActionSchema = z.union([
  BrowserActionSchema,
  DesktopActionSchema,
  CodeActionSchema,
  TaskFinishActionSchema,
]);

export type BrowserAction = z.infer<typeof BrowserActionSchema>;
export type DesktopAction = z.infer<typeof DesktopActionSchema>;
export type CodeAction = z.infer<typeof CodeActionSchema>;
export type TaskFinishAction = z.infer<typeof TaskFinishActionSchema>;
export type Action = z.infer<typeof ActionSchema>;

export const RiskSchema = z.enum(['read', 'reversible', 'consequential']);
export type Risk = z.infer<typeof RiskSchema>;

export const TargetRefSchema = z.object({
  observationId: IdSchema.observation,
  generation: z.number().int().nonnegative(),
  targetId: z.string().optional(),
  frameId: z.string().default('main'),
  surfaceId: z.string().min(1),
});

export type TargetRef = z.infer<typeof TargetRefSchema>;

// ---------------------------------------------------------------------------
// Tasks, sessions, proposals, results, events
// ---------------------------------------------------------------------------

export const TaskStatusSchema = z.enum([
  'created',
  'observing',
  'planning',
  'executing',
  'verifying_action',
  'verifying',
  'verifying_unknown',
  'recovering',
  'awaiting_user',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'needs_attention',
]);

export type TaskStatus = z.infer<typeof TaskStatusSchema>;

export const TERMINAL_STATUSES: ReadonlySet<TaskStatus> = new Set([
  'succeeded',
  'failed',
  'cancelled',
]);

export const TaskSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: IdSchema.task,
  runId: IdSchema.run,
  goal: z.string().min(1).max(20_000),
  constraints: z.array(z.string()).default([]),
  acceptance: z.array(ConditionSchema).min(1),
  acceptanceSource: AcceptanceSource.default('user'),
  authorization: AuthorizationScopeSchema,
  budgets: BudgetSchema,
  environment: EnvironmentSchema,
  status: TaskStatusSchema,
  statusReason: z.string().optional(),
  createdAt: IsoDate,
  updatedAt: IsoDate,
  version: z.number().int().nonnegative(),
  sessionId: IdSchema.session.optional(),
  lastObservationId: IdSchema.observation.optional(),
  terminalReason: z.string().optional(),
  metadata: z.record(z.string(), z.unknown()).default({}),
});

export type Task = z.infer<typeof TaskSchema>;

export const SessionSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: IdSchema.session,
  taskId: IdSchema.task,
  runId: IdSchema.run,
  kind: z.enum(['browser', 'desktop', 'code']),
  environment: z.record(z.string(), z.unknown()),
  lifecycle: z.enum(['starting', 'active', 'lost', 'taken_over', 'closed']),
  ownerId: z.string().min(1),
  fencingToken: z.number().int(),
  capabilities: CapabilitiesSchema,
  createdAt: IsoDate,
  updatedAt: IsoDate,
});

export type Session = z.infer<typeof SessionSchema>;

export const ActionProposalSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: IdSchema.action,
  taskId: IdSchema.task,
  runId: IdSchema.run,
  sessionId: IdSchema.session,
  observationId: IdSchema.observation,
  surfaceId: z.string().min(1),
  generation: z.number().int().nonnegative(),
  targetRef: TargetRefSchema.optional(),
  action: ActionSchema,
  expected: z.array(ConditionSchema).default([]),
  risk: RiskSchema.default('reversible'),
  requiresApproval: z.boolean().default(false),
  rationale: z.string().max(4_000).default(''),
  createdAt: IsoDate,
  attempts: z.number().int().nonnegative().default(0),
});

export type ActionProposal = z.infer<typeof ActionProposalSchema>;

export const ExecutionStatusSchema = z.enum([
  'succeeded',
  'failed',
  'unknown',
  'partial',
  'cancelled',
]);

export type ExecutionStatus = z.infer<typeof ExecutionStatusSchema>;

export const EvidenceRefSchema = z.object({
  kind: z.enum(['observation', 'screenshot', 'event', 'verification', 'file', 'http']),
  ref: z.string().min(1),
  note: z.string().optional(),
});

export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

export const ExecutionResultSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  actionId: IdSchema.action,
  taskId: IdSchema.task,
  sessionId: IdSchema.session,
  status: ExecutionStatusSchema,
  startedAt: IsoDate,
  endedAt: IsoDate,
  returned: z.boolean(),
  sideEffectUnknown: z.boolean(),
  actual: z.record(z.string(), z.unknown()).default({}),
  error: z
    .object({
      code: z.string(),
      message: z.string(),
      retryable: z.boolean(),
    })
    .optional(),
  evidence: z.array(EvidenceRefSchema).default([]),
});

export type ExecutionResult = z.infer<typeof ExecutionResultSchema>;

export const VerdictSchema = z.enum(['pass', 'fail', 'insufficient_evidence', 'unknown']);
export type Verdict = z.infer<typeof VerdictSchema>;

export const VerificationResultSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  id: IdSchema.verification,
  taskId: IdSchema.task,
  actionId: IdSchema.action.optional(),
  scope: z.enum(['action', 'task', 'recovery']),
  criteria: z.array(ConditionSchema),
  verdict: VerdictSchema,
  evidence: z.array(EvidenceRefSchema).default([]),
  missing: z.array(z.string()).default([]),
  details: z
    .array(z.object({ criterion: ConditionSchema, verdict: VerdictSchema, detail: z.string() }))
    .default([]),
  verifier: z.string(),
  at: IsoDate,
});

export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const EventTypeSchema = z.enum([
  'task.created',
  'task.started',
  'task.status',
  'task.paused',
  'task.resumed',
  'task.cancel_requested',
  'task.cancelled',
  'task.finished',
  'task.recovered',
  'task.recovery_required',
  'session.created',
  'session.lost',
  'session.closed',
  'session.takeover',
  'session.released',
  'observation.captured',
  'action.intent',
  'action.result',
  'action.unknown',
  'action.reconciled',
  'action.denied',
  'verification.result',
  'model.request',
  'model.response',
  'model.error',
  'code.started',
  'code.finished',
  'code.timeout',
  'monitor.alert',
  'monitor.note',
  'user.input',
  'user.takeover',
  'user.release',
  'lease.acquired',
  'lease.lost',
  'artifact.created',
  'workflow.learned',
  'workflow.used',
  'workflow.invalidated',
  'workflow.deleted',
]);

export type EventType = z.infer<typeof EventTypeSchema>;

export const EventSchema = z.object({
  schemaVersion: z.literal(PROTOCOL_VERSION).default(PROTOCOL_VERSION),
  seq: z.number().int().nonnegative(),
  id: IdSchema.event,
  type: EventTypeSchema,
  at: IsoDate,
  taskId: IdSchema.task.optional(),
  runId: IdSchema.run.optional(),
  sessionId: IdSchema.session.optional(),
  observationId: IdSchema.observation.optional(),
  actionId: IdSchema.action.optional(),
  correlationId: z.string().optional(),
  actor: z.enum([
    'controller', 'planner', 'executor', 'verifier', 'monitor', 'user', 'driver', 'system', 'mcp', 'cli',
  ]),
  payload: z.record(z.string(), z.unknown()).default({}),
});

export type Event = z.infer<typeof EventSchema>;

export const CheckpointSchema = z.object({
  id: IdSchema.checkpoint,
  taskId: IdSchema.task,
  runId: IdSchema.run,
  at: IsoDate,
  reason: z.string(),
  data: z.record(z.string(), z.unknown()),
});

export type Checkpoint = z.infer<typeof CheckpointSchema>;

// ---------------------------------------------------------------------------
// API input shapes
// ---------------------------------------------------------------------------

export const CreateTaskInputSchema = z
  .object({
    goal: z.string().min(1).max(20_000),
    constraints: z.array(z.string()).default([]),
    acceptance: z.array(ConditionSchema).min(1),
    acceptanceSource: AcceptanceSource.default('user'),
    authorization: AuthorizationScopeSchema.partial().default({}),
    budgets: BudgetSchema.partial().default({}),
    environment: EnvironmentSchema,
    metadata: z.record(z.string(), z.unknown()).default({}),
    model: z
      .object({
        provider: z.string().default('scripted'),
        model: z.string().default('scripted-deterministic'),
        baseUrl: z.string().url().optional(),
        apiKeyEnv: z.string().optional(),
        temperature: z.number().min(0).max(2).optional(),
        timeoutMs: z.number().int().positive().max(300_000).optional(),
        tokenParameter: z.enum(['max_tokens', 'max_completion_tokens']).optional(),
        capabilities: z
          .object({
            tools: z.boolean().optional(),
            images: z.boolean().optional(),
            structuredOutput: z.boolean().optional(),
            nativeComputerActions: z.boolean().optional(),
          })
          .optional(),
        pricing: z
          .object({ inputPerMillionUsd: z.number().nonnegative(), outputPerMillionUsd: z.number().nonnegative() })
          .optional(),
      })
      .default({ provider: 'scripted', model: 'scripted-deterministic' }),
    /** Optional deterministic script used by the built-in scripted adapter. */
    script: z.array(z.record(z.string(), z.unknown())).optional(),
  })
  .strict();

export type CreateTaskInput = z.infer<typeof CreateTaskInputSchema>;

export const UserInputSchema = z.object({
  kind: z.enum(['approval', 'answer', 'freeform']),
  text: z.string().min(1).max(20_000),
  requestId: z.string().optional(),
});

export type UserInput = z.infer<typeof UserInputSchema>;

export const ControlActionSchema = z.enum(['pause', 'resume', 'cancel', 'takeover', 'release', 'recover']);
export type ControlAction = z.infer<typeof ControlActionSchema>;

export const TaskSummarySchema = TaskSchema.omit({ schemaVersion: true }).extend({
  latestObservation: ObservationSchema.optional(),
  lastEventSeq: z.number().int().nonnegative().optional(),
});

export type TaskSummary = z.infer<typeof TaskSummarySchema>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function parseOrThrow<T extends z.ZodTypeAny>(schema: T, value: unknown, label: string): z.infer<T> {
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(
      `${label} failed validation: ${result.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    );
  }
  return result.data;
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function isTerminal(status: TaskStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

export function isReadOnlyAction(action: Action): boolean {
  return (
    action.tool === 'browser.screenshot' ||
    action.tool === 'browser.observe' ||
    action.tool === 'browser.wait_for' ||
    action.tool === 'browser.switch_tab' ||
    action.tool === 'desktop.screenshot' ||
    action.tool === 'browser.navigate'
  );
}
