// RSI discovery-tree persistence — the "map" DREAM replays offline.
//
// A discovery tree is the append-only record of one online episode run:
// root = the exploration-policy state before the episode, each child = one
// candidate attempt with its RECORDED outcome (reward, cost, accept/reject).
// Rejected nodes are kept: they are the map, not garbage.
//
// Pure + injectable FS: the caller supplies reads/writes so this is testable
// without touching disk. Real wiring passes node:fs; tests pass a Map.

export type RsiModule = 'loop' | 'tools' | 'observation' | 'context' | 'completion' | 'product';

export const RSI_MODULES: RsiModule[] = ['loop', 'tools', 'observation', 'context', 'completion', 'product'];

export function isRsiModule(v: unknown): v is RsiModule {
  return typeof v === 'string' && (RSI_MODULES as string[]).includes(v);
}

/** Terminal fate of one candidate attempt. */
export type ExperimentStatus = 'accepted' | 'rejected' | 'rolled-back' | 'failed';

/**
 * One recorded experiment. Every field the task requires is present so a
 * restart can reconstruct lineage, cost, and why a candidate was refused —
 * without re-running anything.
 */
export interface ExperimentRecord {
  /** Stable unique id, e.g. "rsi-20261016-1200-slug" or "exp-007". */
  id: string;
  /** Parent experiment id, or null for a root attempt. */
  parentId: string | null;
  /** Baseline version identifier this candidate was measured against. */
  baselineId: string;
  /** Candidate version identifier (workspace snapshot id / commit / label). */
  candidateId: string;
  /** Which harness/product module was touched. */
  module: RsiModule;
  /** Which exploration strategy produced this attempt. */
  strategyId: string;
  /** Declared external success criteria all passed. */
  externalPass: boolean;
  /** Per-metric SIGNED scaled deltas (higher = better on every axis). */
  metrics: Record<string, number>;
  /** Composite reward from computeReward (REWARD_FAIL on hard gate breach). */
  reward: number;
  /** Measured cost in USD for this attempt. */
  costUsd: number;
  /** Cost in verify steps actually run (cascade early-exit visible). */
  costSteps: number;
  /** Budget declared for the episode this attempt belonged to. */
  budgetUsd: number;
  /** How many candidate tries this episode had used when this ran. */
  attempts: number;
  /** Terminal fate. Rejected-but-passing nodes stay branchable. */
  status: ExperimentStatus;
  /** Machine-checkable failure class, e.g. "external-fail". */
  failureReason?: string;
  /** Free-form diagnostics (command output excerpt, file:line, etc.). */
  diagnostics?: string;
  /** ms since epoch. */
  timestamp: number;
}

export interface DiscoveryTree {
  episodeId: string;
  /** Exploration-policy id in force when this episode started. */
  rootPolicyId: string;
  nodes: ExperimentRecord[];
  createdAt: number;
  updatedAt: number;
}

export function createDiscoveryTree(episodeId: string, rootPolicyId: string, now = Date.now()): DiscoveryTree {
  if (!episodeId.trim()) throw new Error('episodeId must be non-empty');
  if (!rootPolicyId.trim()) throw new Error('rootPolicyId must be non-empty');
  return { episodeId, rootPolicyId, nodes: [], createdAt: now, updatedAt: now };
}

export interface AppendOutcome {
  tree: DiscoveryTree;
  added: boolean;
  /** True when the id was already present: repeat delivery, not a new fact. */
  duplicate: boolean;
}

function validateRecord(rec: ExperimentRecord): string | null {
  if (!rec.id || !rec.id.trim()) return 'id must be non-empty';
  if (!rec.baselineId || !rec.baselineId.trim()) return 'baselineId must be non-empty';
  if (!rec.candidateId || !rec.candidateId.trim()) return 'candidateId must be non-empty';
  if (!isRsiModule(rec.module)) return `unknown module: ${String(rec.module)}`;
  if (!rec.strategyId || !rec.strategyId.trim()) return 'strategyId must be non-empty';
  if (typeof rec.externalPass !== 'boolean') return 'externalPass must be boolean';
  if (!rec.metrics || typeof rec.metrics !== 'object' || Array.isArray(rec.metrics)) return 'metrics must be an object';
  for (const [k, v] of Object.entries(rec.metrics)) {
    if (!k.trim()) return 'metric id must be non-empty';
    if (typeof v !== 'number' || !Number.isFinite(v)) return `metric ${k} must be a finite number`;
  }
  if (typeof rec.reward !== 'number' || !Number.isFinite(rec.reward)) return 'reward must be finite';
  if (typeof rec.costUsd !== 'number' || !(rec.costUsd >= 0)) return 'costUsd must be >= 0';
  if (!Number.isInteger(rec.costSteps) || rec.costSteps < 0) return 'costSteps must be a non-negative integer';
  if (typeof rec.budgetUsd !== 'number' || !(rec.budgetUsd >= 0)) return 'budgetUsd must be >= 0';
  if (!Number.isInteger(rec.attempts) || rec.attempts < 1) return 'attempts must be a positive integer';
  if (rec.status !== 'accepted' && rec.status !== 'rejected' && rec.status !== 'rolled-back' && rec.status !== 'failed') {
    return `unknown status: ${String(rec.status)}`;
  }
  if (typeof rec.timestamp !== 'number' || !(rec.timestamp >= 0)) return 'timestamp must be >= 0';
  return null;
}

/**
 * Append one experiment. Idempotent: repeating the same id returns
 * {added:false, duplicate:true} and leaves the tree untouched, so retries
 * and process restarts never double-register.
 */
export function appendExperiment(tree: DiscoveryTree, rec: ExperimentRecord, now = Date.now()): AppendOutcome {
  const invalid = validateRecord(rec);
  if (invalid) throw new Error(`invalid experiment: ${invalid}`);
  const existing = tree.nodes.find((n) => n.id === rec.id);
  if (existing) return { tree, added: false, duplicate: true };
  if (rec.parentId != null && !tree.nodes.some((n) => n.id === rec.parentId)) {
    throw new Error(`unknown parentId: ${rec.parentId}`);
  }
  const next: DiscoveryTree = {
    ...tree,
    nodes: [...tree.nodes, { ...rec, metrics: { ...rec.metrics } }],
    updatedAt: now,
  };
  return { tree: next, added: true, duplicate: false };
}

export function findNode(tree: DiscoveryTree, id: string): ExperimentRecord | null {
  return tree.nodes.find((n) => n.id === id) ?? null;
}

export function childrenOf(tree: DiscoveryTree, parentId: string | null): ExperimentRecord[] {
  return tree.nodes.filter((n) => n.parentId === parentId);
}

/** Root-to-node lineage (oldest first). Empty when the id is unknown. */
export function lineageOf(tree: DiscoveryTree, id: string): ExperimentRecord[] {
  const out: ExperimentRecord[] = [];
  const seen = new Set<string>();
  let cur = findNode(tree, id);
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    out.unshift(cur);
    cur = cur.parentId == null ? null : findNode(tree, cur.parentId);
  }
  return out;
}

/** Distinct modules attempted — used to detect narrow, repetitive search. */
export function modulesAttempted(tree: DiscoveryTree): Record<string, number> {
  const out: Record<string, number> = {};
  for (const n of tree.nodes) out[n.module] = (out[n.module] ?? 0) + 1;
  return out;
}

// ---------------------------------------------------------------------------
// Serialization — strict, never fabricating.
// ---------------------------------------------------------------------------

export function serializeTree(tree: DiscoveryTree): string {
  return JSON.stringify(tree, null, 2);
}

export function parseTree(json: string): DiscoveryTree {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    throw new Error('discovery tree is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') throw new Error('discovery tree must be an object');
  const t = raw as Record<string, unknown>;
  if (typeof t.episodeId !== 'string' || !t.episodeId.trim()) throw new Error('discovery tree missing episodeId');
  if (typeof t.rootPolicyId !== 'string' || !t.rootPolicyId.trim()) throw new Error('discovery tree missing rootPolicyId');
  if (!Array.isArray(t.nodes)) throw new Error('discovery tree missing nodes[]');
  const tree: DiscoveryTree = {
    episodeId: t.episodeId,
    rootPolicyId: t.rootPolicyId,
    nodes: [],
    createdAt: typeof t.createdAt === 'number' ? t.createdAt : 0,
    updatedAt: typeof t.updatedAt === 'number' ? t.updatedAt : 0,
  };
  const seen = new Set<string>();
  for (const rawNode of t.nodes) {
    const rec = rawNode as ExperimentRecord;
    const invalid = validateRecord(rec);
    if (invalid) throw new Error(`invalid node ${String((rawNode as { id?: unknown })?.id)}: ${invalid}`);
    if (seen.has(rec.id)) throw new Error(`duplicate node id: ${rec.id}`);
    seen.add(rec.id);
    tree.nodes.push({ ...rec, metrics: { ...rec.metrics } });
  }
  // Parent references must resolve inside the file — a dangling parent means
  // a truncated or hand-edited record, not a fact to replay.
  for (const n of tree.nodes) {
    if (n.parentId != null && !seen.has(n.parentId)) throw new Error(`dangling parentId: ${n.parentId}`);
  }
  return tree;
}

// ---------------------------------------------------------------------------
// Disk layout — injectable FS so tests use memory and prod passes node:fs.
// ---------------------------------------------------------------------------

export interface RsiFs {
  readFile(path: string): string | null;
  writeFile(path: string, content: string): void;
  mkdir?(path: string): void;
  listDir?(path: string): string[];
}

export function treeFilePath(dir: string, episodeId: string): string {
  const safe = episodeId.replace(/[^a-zA-Z0-9-_]/g, '_');
  return `${dir.replace(/\/+$/, '')}/${safe}.json`;
}

export function saveTree(fs: RsiFs, dir: string, tree: DiscoveryTree): string {
  try {
    fs.mkdir?.(dir);
  } catch {
    // Best effort: writeFile below surfaces the real error.
  }
  const path = treeFilePath(dir, tree.episodeId);
  fs.writeFile(path, serializeTree(tree));
  return path;
}

export function loadTree(fs: RsiFs, dir: string, episodeId: string): DiscoveryTree | null {
  const raw = fs.readFile(treeFilePath(dir, episodeId));
  if (raw == null) return null;
  return parseTree(raw);
}

/** All episode ids with a tree file on disk (restart recovery entry point). */
export function listTreeIds(fs: RsiFs, dir: string): string[] {
  const names = fs.listDir?.(dir) ?? [];
  return names
    .filter((n) => n.endsWith('.json'))
    .map((n) => n.slice(0, -'.json'.length))
    .sort();
}

/** Load every persisted tree; corrupt files are reported, never silently fixed. */
export function loadAllTrees(fs: RsiFs, dir: string): { trees: DiscoveryTree[]; corrupt: { id: string; error: string }[] } {
  const trees: DiscoveryTree[] = [];
  const corrupt: { id: string; error: string }[] = [];
  for (const id of listTreeIds(fs, dir)) {
    try {
      const t = loadTree(fs, dir, id);
      if (t) trees.push(t);
    } catch (e) {
      corrupt.push({ id, error: e instanceof Error ? e.message : String(e) });
    }
  }
  return { trees, corrupt };
}
