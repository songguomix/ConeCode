// Record construction, validation, integrity hashes and safety guards.
// Pure by design: the caller supplies ids, time and device identity.

import type {
  MemoryLayer, MemoryRecord, MemoryStatus, MemoryType, MemoryVersion,
  MemoryOrigin, RelationKind,
} from './types';

/** Deterministic 64-bit-ish FNV-1a hash. Works in renderer, main and node tests. */
export function hashString(input: string): string {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < input.length; i++) {
    const c = input.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 0x01000193) >>> 0;
    h2 = Math.imul(h2 ^ (c + i), 0x85ebca6b) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

/** Only semantic fields — sync metadata must not change the hash. */
export function contentHashOf(r: Pick<MemoryRecord, 'title' | 'content' | 'type' | 'layer' | 'projectId' | 'tags' | 'status' | 'why'>): string {
  return hashString(JSON.stringify([
    r.title.trim(), r.content.trim(), r.type, r.layer, r.projectId ?? null,
    [...r.tags].sort(), r.status, r.why ?? '',
  ]));
}

export const SECRET_PATTERNS = [
  /\bsk-[a-z0-9-]{16,}/i,
  /\b(?:api[-_ ]?key|secret|token|password|passwd|bearer)\b\s*[:=]/i,
  /\bgh[pousr]_[a-z0-9]{20,}/i,
  /\bAKIA[0-9A-Z]{16}\b/,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
];

export function looksLikeSecret(text: string): boolean {
  return SECRET_PATTERNS.some((re) => re.test(text));
}

/** Never log raw credentials — used by the sync engine and cloud client. */
export function maskSecret(value: string): string {
  if (!value) return '';
  if (value.length <= 6) return '••••••';
  return `${value.slice(0, 2)}••••${value.slice(-2)}`;
}

function clamp01(n: unknown, fallback: number): number {
  return typeof n === 'number' && Number.isFinite(n) ? Math.max(0, Math.min(1, n)) : fallback;
}

function unique(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return Array.from(new Set(list.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim())));
}

export interface NewMemoryInput {
  title?: string;
  content: string;
  type?: MemoryType;
  layer?: MemoryLayer;
  projectId?: string | null;
  tags?: string[];
  importance?: number;
  confidence?: number;
  status?: MemoryStatus;
  origin?: MemoryOrigin;
  sourceSessionId?: string;
  sourceEventId?: string;
  why?: string;
  relatedMemoryIds?: string[];
  needsTriage?: boolean;
}

export interface CreateContext {
  id: string;
  deviceId: string;
  now: number;
  sessionId?: string;
  eventId?: string;
}

/** Confidence defaults follow the trust rule: user-stated beats agent-inferred. */
export function defaultConfidence(origin: MemoryOrigin, status: MemoryStatus): number {
  if (status === 'confirmed' || origin === 'user') return 0.95;
  if (status === 'inferred' || origin === 'extracted') return 0.65;
  if (status === 'pending') return 0.4;
  return 0.7;
}

export function snapshot(record: MemoryRecord, reason: string): MemoryVersion {
  return {
    version: record.version,
    title: record.title,
    content: record.content,
    type: record.type,
    layer: record.layer,
    status: record.status,
    importance: record.importance,
    confidence: record.confidence,
    tags: [...record.tags],
    relatedMemoryIds: [...record.relatedMemoryIds],
    why: record.why,
    at: record.updatedAt,
    deviceId: record.deviceId,
    reason,
  };
}

export function createRecord(input: NewMemoryInput, ctx: CreateContext): MemoryRecord {
  if (!input || typeof input.content !== 'string' || !input.content.trim()) {
    throw new Error('memory content is required');
  }
  if (looksLikeSecret(input.content) || looksLikeSecret(input.why ?? '')) {
    throw new Error('refusing to store a secret-like memory');
  }
  const layer = input.layer ?? 'project';
  const projectId = layer === 'global' ? null : (input.projectId ?? null);
  if (layer !== 'global' && !projectId) {
    throw new Error(`layer "${layer}" requires a projectId — project isolation is mandatory`);
  }
  const status = input.status ?? (input.origin === 'user' || input.origin === 'migration' ? 'confirmed' : 'inferred');
  const origin = input.origin ?? 'manual';
  const content = input.content.trim();
  const title = (input.title ?? '').trim() || deriveTitle(content);
  const base: MemoryRecord = {
    id: ctx.id,
    title: title.slice(0, 160),
    content,
    type: input.type ?? 'project_fact',
    layer,
    projectId,
    tags: unique(input.tags),
    importance: clamp01(input.importance, 0.5),
    confidence: clamp01(input.confidence, defaultConfidence(origin, status)),
    status,
    origin,
    sourceSessionId: input.sourceSessionId ?? ctx.sessionId,
    sourceEventId: input.sourceEventId ?? ctx.eventId,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    version: 1,
    relatedMemoryIds: unique(input.relatedMemoryIds),
    relations: [],
    why: input.why?.trim() || undefined,
    needsTriage: input.needsTriage,
    history: [],
    deviceId: ctx.deviceId,
    syncStatus: 'local',
    contentHash: '',
    deletedAt: null,
  };
  base.contentHash = contentHashOf(base);
  return base;
}

/** First clause/sentence of the content, so a memory is readable in a list. */
export function deriveTitle(content: string): string {
  const flat = content.replace(/\s+/g, ' ').trim();
  const cut = flat.search(/[。.;；!?！？\n]/);
  const head = cut > 12 ? flat.slice(0, cut) : flat;
  return (head || flat).slice(0, 100);
}

/** Bring a record read from disk up to shape. Never trusts persisted JSON. */
export function normalizeRecord(raw: any): MemoryRecord | null {
  if (!raw || typeof raw !== 'object' || typeof raw.id !== 'string' || typeof raw.content !== 'string') return null;
  const layer: MemoryLayer = ['global', 'project', 'episodic', 'semantic', 'working'].includes(raw.layer) ? raw.layer : 'project';
  const status: MemoryStatus = ['confirmed', 'inferred', 'pending', 'superseded', 'archived'].includes(raw.status) ? raw.status : 'inferred';
  const origin: MemoryOrigin = ['user', 'extracted', 'manual', 'migration', 'tool', 'sync'].includes(raw.origin) ? raw.origin : 'manual';
  const projectId = layer === 'global' ? null : (typeof raw.projectId === 'string' ? raw.projectId : null);
  const record: MemoryRecord = {
    id: raw.id,
    title: typeof raw.title === 'string' ? raw.title : deriveTitle(raw.content),
    content: raw.content,
    type: raw.type ?? 'project_fact',
    layer,
    projectId,
    tags: unique(raw.tags),
    importance: clamp01(raw.importance, 0.5),
    confidence: clamp01(raw.confidence, 0.7),
    status,
    origin,
    sourceSessionId: typeof raw.sourceSessionId === 'string' ? raw.sourceSessionId : undefined,
    sourceEventId: typeof raw.sourceEventId === 'string' ? raw.sourceEventId : undefined,
    createdAt: Number.isFinite(raw.createdAt) ? raw.createdAt : 0,
    updatedAt: Number.isFinite(raw.updatedAt) ? raw.updatedAt : 0,
    version: Number.isFinite(raw.version) && raw.version > 0 ? raw.version : 1,
    relatedMemoryIds: unique(raw.relatedMemoryIds),
    relations: Array.isArray(raw.relations)
      ? raw.relations.filter((r: any) => r && typeof r.targetId === 'string').map((r: any) => ({
          targetId: r.targetId,
          kind: (r.kind ?? 'related') as RelationKind,
          note: typeof r.note === 'string' ? r.note : undefined,
        }))
      : [],
    why: typeof raw.why === 'string' ? raw.why : undefined,
    needsTriage: raw.needsTriage === true,
    history: Array.isArray(raw.history) ? raw.history : [],
    conflictWith: typeof raw.conflictWith === 'string' ? raw.conflictWith : undefined,
    deviceId: typeof raw.deviceId === 'string' ? raw.deviceId : 'unknown',
    syncStatus: ['local', 'pending', 'synced', 'conflict'].includes(raw.syncStatus) ? raw.syncStatus : 'local',
    contentHash: typeof raw.contentHash === 'string' ? raw.contentHash : '',
    deletedAt: Number.isFinite(raw.deletedAt) ? raw.deletedAt : null,
  };
  if (!record.contentHash) record.contentHash = contentHashOf(record);
  return record;
}

export function isDeleted(r: MemoryRecord): boolean {
  return r.deletedAt !== null || r.status === 'archived';
}

/** High-importance memories cannot be deleted/overwritten without an explicit force. */
export const PROTECTED_IMPORTANCE = 0.85;

export function assertMutable(record: MemoryRecord, operation: 'delete' | 'overwrite', force = false): void {
  if (force) return;
  if (record.importance >= PROTECTED_IMPORTANCE) {
    throw new Error(
      `"${record.title}" is a protected memory (importance ${record.importance.toFixed(2)}). ` +
      `${operation} requires an explicit force flag.`,
    );
  }
}

/** A stable, path-independent-enough project key. The store resolves a real UUID when possible. */
export function deriveProjectId(rootPath: string): string {
  const cleaned = rootPath.replace(/\\/g, '/').replace(/\/+$/, '').toLowerCase();
  return `proj-${hashString(cleaned)}`;
}

/** Project isolation, applied at the lowest layer so no caller can bypass it. */
export function visibleToProject(record: MemoryRecord, projectId: string | null): boolean {
  if (record.deletedAt !== null) return false;
  if (record.layer === 'global') return true;
  return !!projectId && record.projectId === projectId;
}
