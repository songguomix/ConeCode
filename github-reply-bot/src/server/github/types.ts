import type { PermissionLevel } from '../../shared/types';

export interface RepoRef {
  owner: string;
  name: string;
}

export interface ChangedFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
}

export interface IssueContext {
  number: number;
  title: string;
  body: string;
  author: string;
  authorType: string;
  labels: string[];
  state: string;
  htmlUrl: string;
  isPullRequest: boolean;
  changedFiles?: number;
}

export interface CommentInfo {
  id: number;
  body: string;
  author: string;
  authorType: string;
  createdAt: string;
}

export interface CreatedComment {
  id: number;
  htmlUrl: string;
}

export interface GitHubApi {
  getIssue(installationId: number, ref: RepoRef, number: number): Promise<IssueContext>;
  getPullRequest(installationId: number, ref: RepoRef, number: number): Promise<IssueContext>;
  listComments(installationId: number, ref: RepoRef, number: number, limit: number): Promise<CommentInfo[]>;
  listPullFiles(installationId: number, ref: RepoRef, number: number, limit: number): Promise<ChangedFile[]>;
  createComment(installationId: number, ref: RepoRef, number: number, body: string): Promise<CreatedComment>;
  getPermission(installationId: number, ref: RepoRef, login: string): Promise<PermissionLevel>;
}

export class GitHubApiError extends Error {
  readonly code: string;
  readonly status?: number;

  constructor(message: string, code: string, status?: number) {
    super(message);
    this.name = 'GitHubApiError';
    this.code = code;
    this.status = status;
  }

  /** Network errors and 403/429/5xx are treated as transient. */
  get retryable(): boolean {
    if (this.status === undefined) return true;
    return this.status === 403 || this.status === 429 || this.status >= 500;
  }
}

export function isGitHubApiError(error: unknown): error is GitHubApiError {
  return error instanceof GitHubApiError;
}

export function toGitHubApiError(error: unknown, fallbackCode = 'github_request_failed'): GitHubApiError {
  if (isGitHubApiError(error)) return error;
  const status = typeof (error as { status?: unknown })?.status === 'number' ? (error as { status: number }).status : undefined;
  const message = error instanceof Error ? error.message : String(error);
  return new GitHubApiError(message, fallbackCode, status);
}

export function isMaintainerPermission(permission: PermissionLevel): boolean {
  return permission === 'admin' || permission === 'maintain';
}
