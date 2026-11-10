import type { DreamLlm, DreamSession, WikiFile, WikiIndexEntry } from './types';
import { buildAnalyzerMessages } from './prompts';
import { extractJsonObject, redactSecrets, sanitizeSlug } from './wiki';

const MAX_FILES = 6;
const MAX_BODY = 8000;
const MAX_DESCRIPTION = 240;
const VALID_DOMAINS = new Set([
  'projects',
  'workflows',
  'tools',
  'decisions',
  'incidents',
  'preferences',
  'general',
]);

export interface AnalyzerResult {
  files: WikiFile[];
  warning?: string;
  /** False means the model failed, so the session must stay retryable. */
  valid: boolean;
}

function oneLine(value: unknown, max: number): string {
  return String(value ?? '')
    .replace(/[\r\n]+/g, ' ')
    .trim()
    .slice(0, max);
}

function normalizeDomain(value: unknown): string {
  const domain = oneLine(value, 40).toLowerCase().replace(/[^a-z0-9-]/g, '');
  return VALID_DOMAINS.has(domain) ? domain : 'general';
}

function normalizeFile(raw: unknown, session: DreamSession, now: number): WikiFile | null {
  if (!raw || typeof raw !== 'object') return null;
  const record = raw as Record<string, unknown>;
  const slug = sanitizeSlug(record.slug ?? record.name);
  if (!slug) return null;
  const body = redactSecrets(String(record.body ?? '')).trim();
  if (body.length < 20 || body.length > MAX_BODY) return null;
  if (/^MOVED TO \[\[/i.test(body)) return null;
  const name = oneLine(record.name, 120) || slug;
  const description = oneLine(record.description, MAX_DESCRIPTION);
  const sources = [
    session.id,
    ...(Array.isArray(record.sources) ? record.sources : [])
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.slice(0, 120)),
  ];
  return {
    slug,
    name,
    description,
    domain: normalizeDomain(record.domain),
    updated: now,
    sources: [...new Set(sources)].slice(0, 20),
    body,
  };
}

/**
 * One analyzer pass for one transcript. Returns validated files; invalid JSON
 * or unusable entries produce no writes at all.
 */
export async function analyzeSession(
  llm: DreamLlm,
  input: {
    session: DreamSession;
    transcript: string;
    entries: WikiIndexEntry[];
    related: WikiFile[];
    now: number;
    maxFiles?: number;
  }
): Promise<AnalyzerResult> {
  const { system, user } = buildAnalyzerMessages(input);
  const raw = await llm({ system, user, maxTokens: 4000 });
  if (!raw || !raw.trim()) {
    return { files: [], warning: 'analyzer returned an empty response', valid: false };
  }
  const parsed = extractJsonObject(raw);
  if (!parsed || typeof parsed !== 'object') {
    return { files: [], warning: 'analyzer response was not valid JSON', valid: false };
  }
  const list = (parsed as { files?: unknown }).files;
  if (!Array.isArray(list)) {
    return { files: [], warning: 'analyzer response had no files array', valid: false };
  }

  const limit = Math.min(Math.max(input.maxFiles ?? MAX_FILES, 1), MAX_FILES);
  const bySlug = new Map<string, WikiFile>();
  for (const item of list.slice(0, limit)) {
    const file = normalizeFile(item, input.session, input.now);
    if (file) bySlug.set(file.slug, file);
  }
  const files = [...bySlug.values()];
  return {
    files,
    warning: files.length === 0 ? 'analyzer produced no valid files' : undefined,
    valid: true,
  };
}
