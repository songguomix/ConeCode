import type {
  ChangedFile,
  CommentInfo,
  CreatedComment,
  GitHubApi,
  IssueContext,
  RepoRef,
} from '../src/server/github/types';
import type { PermissionLevel } from '../src/shared/types';

const sampleFiles: ChangedFile[] = [
  { filename: 'src/app.ts', status: 'modified', additions: 10, deletions: 2 },
  { filename: 'src/index.ts', status: 'added', additions: 3, deletions: 0 },
];

export function sampleIssue(overrides: Partial<IssueContext> = {}): IssueContext {
  return {
    number: 7,
    title: 'Crash when starting the app',
    body: 'Steps to reproduce: run the app. Expected: it starts. Actual: it crashes. Version 1.2.3, macOS.',
    author: 'alice',
    authorType: 'User',
    labels: ['bug'],
    state: 'open',
    htmlUrl: 'https://github.com/acme/widgets/issues/7',
    isPullRequest: false,
    ...overrides,
  };
}

type Method = 'getIssue' | 'getPullRequest' | 'listComments' | 'listPullFiles' | 'createComment' | 'getPermission';

export class FakeGitHub implements GitHubApi {
  issue: IssueContext = sampleIssue();
  pullRequest: IssueContext = sampleIssue({ number: 9, title: 'Add caching', isPullRequest: true, changedFiles: 2 });
  comments: CommentInfo[] = [];
  files: ChangedFile[] = sampleFiles;
  permissions: Record<string, PermissionLevel> = {};
  created: Array<CreatedComment & { body: string }> = [];
  calls: string[] = [];
  lastPullFilesLimit: number | null = null;
  failure: { method: Method; error: Error } | null = null;
  createCommentFailures: Error[] = [];
  private nextId = 5000;

  private maybeFail(method: Method): void {
    if (this.failure && this.failure.method === method) throw this.failure.error;
  }

  async getIssue(_installationId: number, _ref: RepoRef, number: number): Promise<IssueContext> {
    this.calls.push('getIssue');
    this.maybeFail('getIssue');
    return { ...this.issue, number };
  }

  async getPullRequest(_installationId: number, _ref: RepoRef, number: number): Promise<IssueContext> {
    this.calls.push('getPullRequest');
    this.maybeFail('getPullRequest');
    return { ...this.pullRequest, number };
  }

  async listComments(_installationId: number, _ref: RepoRef, _number: number, limit: number): Promise<CommentInfo[]> {
    this.calls.push('listComments');
    this.maybeFail('listComments');
    return this.comments.slice(0, limit);
  }

  async listPullFiles(_installationId: number, _ref: RepoRef, _number: number, limit: number): Promise<ChangedFile[]> {
    this.calls.push('listPullFiles');
    this.maybeFail('listPullFiles');
    this.lastPullFilesLimit = limit;
    return this.files.slice(0, limit);
  }

  async createComment(
    _installationId: number,
    _ref: RepoRef,
    _number: number,
    body: string
  ): Promise<CreatedComment> {
    this.calls.push('createComment');
    this.maybeFail('createComment');
    const queued = this.createCommentFailures.shift();
    if (queued) throw queued;
    const comment = { id: this.nextId++, htmlUrl: `https://github.com/acme/widgets/issues/7#issuecomment-${this.nextId}` };
    this.created.push({ ...comment, body });
    return comment;
  }

  async getPermission(_installationId: number, _ref: RepoRef, login: string): Promise<PermissionLevel> {
    this.calls.push('getPermission');
    this.maybeFail('getPermission');
    return this.permissions[login] ?? 'read';
  }
}

export { sampleFiles };
