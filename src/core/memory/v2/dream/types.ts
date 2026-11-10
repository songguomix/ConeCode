/** Types for the Memory 2.0 "dream" pass: an offline hindsight consolidation of finished sessions. */

export interface DreamStorage {
  putObject: (key: string, content: string) => Promise<boolean> | boolean;
  getObject: (key: string) => Promise<string | null> | string | null;
  /** Optional: enables history retention. */
  listObjects?: (prefix: string) => Promise<string[]> | string[];
  deleteObject?: (key: string) => Promise<boolean> | boolean;
}

/** Same shape as the memory extractor's adapter: system + user, returns raw text. */
export type DreamLlm = (req: { system: string; user: string; maxTokens?: number }) => Promise<string>;

export interface DreamMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  toolName?: string;
  toolCalls?: string[];
  createdAt?: number;
}

export interface DreamSession {
  id: string;
  title: string;
  updatedAt: number;
  messages: DreamMessage[];
}

export interface WikiFile {
  slug: string;
  name: string;
  description: string;
  domain: string;
  updated: number;
  sources: string[];
  body: string;
}

/** Index metadata, kept in one small JSON object so context loading is one read. */
export interface WikiIndexEntry {
  slug: string;
  name: string;
  description: string;
  domain: string;
  updated: number;
  sources: string[];
}

export interface DreamOptions {
  /** Project scope id; sanitised into the object key. */
  scope: string;
  sessions: DreamSession[];
  now?: number;
  /** Upper bound of transcripts analysed in one run (cost guard). */
  maxSessions?: number;
  /** Only sessions at least this idle are eligible. */
  minIdleMs?: number;
  maxFiles?: number;
  llmTimeoutMs?: number;
}

export interface DreamSessionResult {
  id: string;
  title: string;
  status: 'analyzed' | 'skipped' | 'failed';
  files: string[];
  error?: string;
}

export interface DreamReport {
  schema: 1;
  startedAt: number;
  finishedAt: number;
  scope: string;
  sessions: DreamSessionResult[];
  changedFiles: string[];
  merged: Array<{ from: string; to: string }>;
  indexEntries: number;
  prunedHistory: number;
  warnings: string[];
}

export interface DreamState {
  schema: 1;
  processed: Record<string, { updatedAt: number; hash: string; dreamedAt: number }>;
  lastRunAt: number | null;
}

export interface WikiIndexFile {
  schema: 1;
  updated: number;
  entries: WikiIndexEntry[];
}
