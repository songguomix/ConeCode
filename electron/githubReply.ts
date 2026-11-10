import { sanitizeReply } from '../src/core/githubReply/replyText';
import type {
  ReplyComment,
  ReplyContextResult,
  ReplyListResult,
  ReplyPostResult,
  ReplyThreadContext,
  ReplyThreadSummary,
} from '../src/types/githubReply.types';

/**
 * GitHub issue / pull request reply assistant used by the GitHub plugin.
 *
 * The main process owns these requests so the renderer never needs CORS:
 * listing open threads, loading one thread's context, and posting a confirmed
 * reply. A token is optional for public repositories; posting always needs one.
 */

const API_BASE = 'https://api.github.com';
const REPO_PATTERN = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
const MAX_THREADS = 50;
const MAX_COMMENTS = 10;
const MAX_ISSUE_BODY = 20000;

export interface ReplyFetchResponse {
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}

export type ReplyFetch = (
  url: string,
  init?: { method?: string; headers?: Record<string, string>; body?: string }
) => Promise<ReplyFetchResponse>;

export interface ReplyRawOptions {
  repo?: unknown;
  token?: unknown;
  number?: unknown;
  body?: unknown;
}

function text(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function repoOf(value: unknown): string | null {
  const repo = text(value);
  return REPO_PATTERN.test(repo) ? repo : null;
}

function numberIn(value: unknown): number | null {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : null;
}

function headers(token: string): Record<string, string> {
  const result: Record<string, string> = {
    accept: 'application/vnd.github+json',
    'user-agent': 'ConeCode-GitHub-Plugin',
  };
  if (token) result.authorization = `Bearer ${token}`;
  return result;
}

export function statusMessage(status: number): string {
  if (status === 401) return 'GitHub rejected the token (401). Check that it is valid and not expired.';
  if (status === 403) {
    return 'GitHub denied the request (403). The token needs Issues and Pull requests read/write access, and the repository must be accessible to it.';
  }
  if (status === 404) {
    return 'GitHub could not find the repository or thread (404). Check owner/repo and that the token can access it.';
  }
  if (status === 410) return 'This thread is locked (410), so new comments cannot be posted.';
  if (status === 422) {
    return 'GitHub rejected the request (422). The thread may be locked or the repository may have issues disabled.';
  }
  if (status === 429) return 'GitHub rate limit reached (429). Try again in a few minutes.';
  return `GitHub request failed (HTTP ${status}).`;
}

function networkMessage(error: unknown, token: string): string {
  let message = error instanceof Error ? error.message : String(error);
  // Never echo credentials, even if a lower layer included them in an error.
  if (token) message = message.split(token).join('***');
  return `Could not reach GitHub: ${message}`;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .map((entry) => {
      if (typeof entry === 'string') return entry;
      if (entry && typeof entry === 'object' && typeof (entry as { name?: unknown }).name === 'string') {
        return (entry as { name: string }).name;
      }
      return '';
    })
    .filter(Boolean);
}

function mapSummary(raw: unknown): ReplyThreadSummary | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  const number = typeof item.number === 'number' ? item.number : NaN;
  if (!Number.isFinite(number) || number <= 0) return null;
  const user = item.user && typeof item.user === 'object' ? (item.user as Record<string, unknown>) : {};
  return {
    number,
    title: typeof item.title === 'string' && item.title.trim() ? item.title : `#${number}`,
    isPullRequest: Boolean(item.pull_request),
    author: typeof user.login === 'string' ? user.login : 'unknown',
    labels: stringArray(item.labels),
    comments: typeof item.comments === 'number' ? item.comments : 0,
    updatedAt: typeof item.updated_at === 'string' ? item.updated_at : '',
    url: typeof item.html_url === 'string' ? item.html_url : '',
  };
}

function mapComment(raw: unknown): ReplyComment | null {
  if (!raw || typeof raw !== 'object') return null;
  const item = raw as Record<string, unknown>;
  if (typeof item.id !== 'number') return null;
  const user = item.user && typeof item.user === 'object' ? (item.user as Record<string, unknown>) : {};
  return {
    id: item.id,
    author: typeof user.login === 'string' ? user.login : 'unknown',
    body: typeof item.body === 'string' ? item.body : '',
    createdAt: typeof item.created_at === 'string' ? item.created_at : '',
  };
}

async function readJson(response: ReplyFetchResponse): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return null;
  }
}

/** Lists open issues and pull requests, newest activity first. */
export async function listReplyThreads(
  options: ReplyRawOptions = {},
  request: ReplyFetch = fetch
): Promise<ReplyListResult> {
  const repo = repoOf(options.repo);
  if (!repo) {
    return { ok: false, items: [], message: 'Set the repository as owner/repo in the GitHub plugin first.' };
  }
  const token = text(options.token);
  try {
    const response = await request(
      `${API_BASE}/repos/${repo}/issues?state=open&sort=updated&direction=desc&per_page=30`,
      { headers: headers(token) }
    );
    if (!response.ok) return { ok: false, items: [], message: statusMessage(response.status) };
    const data = await readJson(response);
    if (!Array.isArray(data)) {
      return { ok: false, items: [], message: 'GitHub returned an unexpected response.' };
    }
    const items = data
      .map(mapSummary)
      .filter((item): item is ReplyThreadSummary => item !== null)
      .slice(0, MAX_THREADS);
    return { ok: true, items };
  } catch (error) {
    return { ok: false, items: [], message: networkMessage(error, token) };
  }
}

/** Loads one thread plus its most recent comments (oldest first). */
export async function getReplyThread(
  options: ReplyRawOptions = {},
  request: ReplyFetch = fetch
): Promise<ReplyContextResult> {
  const repo = repoOf(options.repo);
  if (!repo) {
    return { ok: false, message: 'Set the repository as owner/repo in the GitHub plugin first.' };
  }
  const number = numberIn(options.number);
  if (number === null) {
    return { ok: false, message: 'Select an issue or pull request first.' };
  }
  const token = text(options.token);
  try {
    const response = await request(`${API_BASE}/repos/${repo}/issues/${number}`, {
      headers: headers(token),
    });
    if (!response.ok) return { ok: false, message: statusMessage(response.status) };
    const raw = await readJson(response);
    const summary = mapSummary(raw);
    if (!summary || !raw || typeof raw !== 'object') {
      return { ok: false, message: 'GitHub returned an unexpected response.' };
    }
    const issue = raw as Record<string, unknown>;

    let recentComments: ReplyComment[] = [];
    const commentsResponse = await request(
      `${API_BASE}/repos/${repo}/issues/${number}/comments?per_page=${MAX_COMMENTS}&sort=created&direction=desc`,
      { headers: headers(token) }
    );
    if (commentsResponse.ok) {
      const data = await readJson(commentsResponse);
      if (Array.isArray(data)) {
        recentComments = data
          .map(mapComment)
          .filter((comment): comment is ReplyComment => comment !== null)
          .reverse();
      }
    }

    const context: ReplyThreadContext = {
      ...summary,
      repo,
      state: typeof issue.state === 'string' ? issue.state : 'open',
      body: typeof issue.body === 'string' ? issue.body.slice(0, MAX_ISSUE_BODY) : '',
      recentComments,
    };
    return { ok: true, context };
  } catch (error) {
    return { ok: false, message: networkMessage(error, token) };
  }
}

/** Posts a confirmed reply. Secrets and empty content are blocked before the request. */
export async function postReply(
  options: ReplyRawOptions = {},
  request: ReplyFetch = fetch
): Promise<ReplyPostResult> {
  const repo = repoOf(options.repo);
  if (!repo) {
    return { ok: false, message: 'Set the repository as owner/repo in the GitHub plugin first.' };
  }
  const number = numberIn(options.number);
  if (number === null) return { ok: false, message: 'Select an issue or pull request first.' };
  const token = text(options.token);
  if (!token) {
    return { ok: false, message: 'Save a GitHub token (with Issues write access) before posting a reply.' };
  }
  const sanitized = sanitizeReply(options.body);
  if (!sanitized.ok) return { ok: false, message: sanitized.message };

  try {
    const response = await request(
      `${API_BASE}/repos/${repo}/issues/${number}/comments`,
      {
        method: 'POST',
        headers: { ...headers(token), 'content-type': 'application/json' },
        body: JSON.stringify({ body: sanitized.body }),
      }
    );
    if (!response.ok) return { ok: false, message: statusMessage(response.status) };
    const data = await readJson(response);
    if (!data || typeof data !== 'object') {
      return { ok: false, message: 'GitHub returned an unexpected response.' };
    }
    const record = data as Record<string, unknown>;
    return {
      ok: true,
      id: typeof record.id === 'number' ? record.id : undefined,
      url: typeof record.html_url === 'string' ? record.html_url : undefined,
      message: `Reply posted to #${number}.`,
    };
  } catch (error) {
    return { ok: false, message: networkMessage(error, token) };
  }
}
