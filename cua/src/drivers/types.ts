import type {
  ActionProposal,
  Capabilities,
  Condition,
  EvidenceRef,
  Observation,
  Verdict,
} from '../protocol/schemas.js';

export interface DriverOutcome {
  actual: Record<string, unknown>;
  evidence: EvidenceRef[];
  /** True when the driver cannot tell whether the business action took effect. */
  sideEffectUnknown?: boolean;
}

export interface ProbeResult {
  verdict: Verdict;
  detail: string;
  evidence?: EvidenceRef[];
}

export interface DriverContext {
  taskId: string;
  runId: string;
  sessionId: string;
  surfaceId?: string;
}

/**
 * A driver has one live environment and exposes observation, action execution
 * and evidence probes. It never decides that a task is complete.
 */
export interface Driver {
  readonly kind: 'browser' | 'desktop' | 'composite';
  start(): Promise<void>;
  close(): Promise<void>;
  surfaceId(): string;
  generation(): number;
  capabilities(): Capabilities;
  observe(): Promise<Observation>;
  execute(proposal: ActionProposal): Promise<DriverOutcome>;
  probe(condition: Condition, timeoutMs?: number): Promise<ProbeResult>;
  /** Live identity used to validate that an observation is still current. */
  freshness(): Promise<{ surfaceId: string; generation: number; url?: string; scrollX?: number; scrollY?: number }>;
}

export function unsupportedProbe(kind: string): ProbeResult {
  return {
    verdict: 'insufficient_evidence',
    detail: `Condition kind "${kind}" cannot be probed by this driver.`,
  };
}
