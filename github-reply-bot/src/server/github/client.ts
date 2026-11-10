import { App } from '@octokit/app';
import type { PermissionLevel } from '../../shared/types';
import type { GitHubConfig } from '../config';
import {
  GitHubApiError,
  toGitHubApiError,
  type ChangedFile,
  type CommentInfo,
  type CreatedComment,
  type GitHubApi,
  type IssueContext,
  type RepoRef,
} from './types';

interface OctokitLike {
  request(route: string, params?: Record<string, unknown>): Promise<{ data: any }>;
}

const PERMISSION_TTL_MS = 5 * 60 * 1000;
const KNOWN_PERMISSIONS: PermissionLevel[] = ['admin', 'maintain', 'write', 'triage', 'read', 'none'];

/**
 * The collaborator-permission endpoint maps the modern `maintain` role to the
 * legacy `write` permission, exposing the real role only in `role_name`.
 * Without this mapping a maintainer would never qualify for auto-posting.
 */
export function mapPermissionLevel(permission: unknown, roleName: unknown): PermissionLevel {
  const role = typeof roleName === 'string' ? roleName.trim().toLowerCase() : '';
  if (role === 'admin' || role === 'maintain') return role;
  const legacy = typeof permission === 'string' ? permission.trim().toLowerCase() : '';
  if ((KNOWN_PERMISSIONS as string[]).includes(legacy)) return legacy as PermissionLevel;
  return 'unknown';
}

function labelNames(labels: unknown): string[] {
  if (!Array.isArray(labels)) return [];
  const names: string[] = [];
  for (const label of labels) {
    if (typeof label === 'string') names.push(label);
    else if (label && typeof label === 'object' && typeof (label as { name?: unknown }).name === 'string') {
      names.push((label as { name: string }).name);
    }
  }
  return names;
}

export class OctokitGitHubApi implements GitHubApi {
  private app: App | null = null;
  private readonly clients = new Map<number, OctokitLike>();
  private readonly permissionCache = new Map<string, { value: PermissionLevel; expiresAt: number }>();

  constructor(private readonly config: GitHubConfig) {}

  private getApp(): App {
    if (this.app) return this.app;
    if (!this.config.appId || !this.config.privateKey) {
      throw new GitHubApiError(
        'GitHub App 凭据未配置：请设置 GITHUB_APP_ID 与 GITHUB_PRIVATE_KEY',
        'github_app_not_configured'
      );
    }
    this.app = new App({ appId: this.config.appId, privateKey: this.config.privateKey });
    return this.app;
  }

  private async client(installationId: number): Promise<OctokitLike> {
    const cached = this.clients.get(installationId);
    if (cached) return cached;
    const octokit = (await this.getApp().getInstallationOctokit(installationId)) as unknown as OctokitLike;
    this.clients.set(installationId, octokit);
    return octokit;
  }

  private async request(
    installationId: number,
    route: string,
    params: Record<string, unknown>
  ): Promise<any> {
    try {
      const octokit = await this.client(installationId);
      const response = await octokit.request(route, params);
      return response.data;
    } catch (error) {
      throw toGitHubApiError(error);
    }
  }

  async getIssue(installationId: number, ref: RepoRef, number: number): Promise<IssueContext> {
    const data = await this.request(installationId, 'GET /repos/{owner}/{repo}/issues/{issue_number}', {
      owner: ref.owner,
      repo: ref.name,
      issue_number: number,
    });
    return {
      number: data.number,
      title: data.title ?? '',
      body: data.body ?? '',
      author: data.user?.login ?? 'unknown',
      authorType: data.user?.type ?? 'User',
      labels: labelNames(data.labels),
      state: data.state ?? 'open',
      htmlUrl: data.html_url ?? '',
      isPullRequest: Boolean(data.pull_request),
    };
  }

  async getPullRequest(installationId: number, ref: RepoRef, number: number): Promise<IssueContext> {
    const data = await this.request(installationId, 'GET /repos/{owner}/{repo}/pulls/{pull_number}', {
      owner: ref.owner,
      repo: ref.name,
      pull_number: number,
    });
    return {
      number: data.number,
      title: data.title ?? '',
      body: data.body ?? '',
      author: data.user?.login ?? 'unknown',
      authorType: data.user?.type ?? 'User',
      labels: labelNames(data.labels),
      state: data.state ?? 'open',
      htmlUrl: data.html_url ?? '',
      isPullRequest: true,
      changedFiles: typeof data.changed_files === 'number' ? data.changed_files : undefined,
    };
  }

  async listComments(installationId: number, ref: RepoRef, number: number, limit: number): Promise<CommentInfo[]> {
    if (limit <= 0) return [];
    const perPage = Math.min(Math.max(limit, 1), 100);
    const data = await this.request(
      installationId,
      'GET /repos/{owner}/{repo}/issues/{issue_number}/comments',
      {
        owner: ref.owner,
        repo: ref.name,
        issue_number: number,
        per_page: perPage,
        sort: 'created',
        direction: 'desc',
      }
    );
    const rows = Array.isArray(data) ? data : [];
    return rows
      .slice(0, limit)
      .reverse()
      .map((row: any) => ({
        id: row.id,
        body: row.body ?? '',
        author: row.user?.login ?? 'unknown',
        authorType: row.user?.type ?? 'User',
        createdAt: row.created_at ?? '',
      }));
  }

  async listPullFiles(installationId: number, ref: RepoRef, number: number, limit: number): Promise<ChangedFile[]> {
    if (limit <= 0) return [];
    const perPage = Math.min(Math.max(limit, 1), 100);
    const data = await this.request(
      installationId,
      'GET /repos/{owner}/{repo}/pulls/{pull_number}/files',
      { owner: ref.owner, repo: ref.name, pull_number: number, per_page: perPage }
    );
    const rows = Array.isArray(data) ? data : [];
    return rows.slice(0, limit).map((row: any) => ({
      filename: String(row.filename ?? ''),
      status: String(row.status ?? 'modified'),
      additions: Number(row.additions ?? 0),
      deletions: Number(row.deletions ?? 0),
    }));
  }

  async createComment(installationId: number, ref: RepoRef, number: number, body: string): Promise<CreatedComment> {
    const data = await this.request(
      installationId,
      'POST /repos/{owner}/{repo}/issues/{issue_number}/comments',
      { owner: ref.owner, repo: ref.name, issue_number: number, body }
    );
    return { id: Number(data.id), htmlUrl: String(data.html_url ?? '') };
  }

  async getPermission(installationId: number, ref: RepoRef, login: string): Promise<PermissionLevel> {
    const key = `${ref.owner}/${ref.name}/${login}`.toLowerCase();
    const cached = this.permissionCache.get(key);
    const now = Date.now();
    if (cached && cached.expiresAt > now) return cached.value;
    let value: PermissionLevel = 'none';
    try {
      const data = await this.request(
        installationId,
        'GET /repos/{owner}/{repo}/collaborators/{username}/permission',
        { owner: ref.owner, repo: ref.name, username: login }
      );
      value = mapPermissionLevel(data?.permission, data?.role_name);
    } catch (error) {
      const apiError = toGitHubApiError(error);
      if (apiError.status === 404) value = 'none';
      else throw apiError;
    }
    this.permissionCache.set(key, { value, expiresAt: now + PERMISSION_TTL_MS });
    if (this.permissionCache.size > 1000) {
      for (const [cacheKey, entry] of this.permissionCache) {
        if (entry.expiresAt <= now) this.permissionCache.delete(cacheKey);
      }
    }
    return value;
  }
}

/** Test helper: an API that always throws the "not configured" error. */
export class MissingCredentialsGitHubApi implements GitHubApi {
  private fail(): never {
    throw new GitHubApiError(
      'GitHub App 凭据未配置：无法读取或发布内容',
      'github_app_not_configured'
    );
  }
  async getIssue(): Promise<IssueContext> {
    return this.fail();
  }
  async getPullRequest(): Promise<IssueContext> {
    return this.fail();
  }
  async listComments(): Promise<CommentInfo[]> {
    return this.fail();
  }
  async listPullFiles(): Promise<ChangedFile[]> {
    return this.fail();
  }
  async createComment(): Promise<CreatedComment> {
    return this.fail();
  }
  async getPermission(): Promise<PermissionLevel> {
    return this.fail();
  }
}
