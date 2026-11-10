import type { ReplyLanguage, TriggerKind } from '../../shared/types';
import type { ChangedFile, GitHubApi, RepoRef } from '../github/types';
import type { GenerationInput } from '../generator/types';

export interface ContextSummary {
  kind: 'issue' | 'pull_request';
  number: number;
  title: string;
  author: string;
  labels: string[];
  bodyExcerpt: string;
  bodyChars: number;
  comments: Array<{ author: string; excerpt: string }>;
  commentsRead: number;
  files: ChangedFile[];
  totalChangedFiles: number | null;
  htmlUrl: string;
  truncated: boolean;
}

export interface BuildContextArgs {
  github: GitHubApi;
  installationId: number;
  repo: RepoRef;
  kind: 'issue' | 'pull_request';
  number: number;
  trigger: TriggerKind;
  action: string;
  language: ReplyLanguage;
  maxComments: number;
  maxFiles: number;
  mention: boolean;
}

export async function buildContext(args: BuildContextArgs): Promise<{
  summary: ContextSummary;
  generationInput: GenerationInput;
}> {
  const subject =
    args.kind === 'pull_request'
      ? await args.github.getPullRequest(args.installationId, args.repo, args.number)
      : await args.github.getIssue(args.installationId, args.repo, args.number);

  const commentRows = await args.github.listComments(
    args.installationId,
    args.repo,
    args.number,
    args.maxComments
  );

  const files =
    args.kind === 'pull_request'
      ? await args.github.listPullFiles(args.installationId, args.repo, args.number, args.maxFiles)
      : [];

  const summary: ContextSummary = {
    kind: args.kind,
    number: args.number,
    title: subject.title,
    author: subject.author,
    labels: subject.labels,
    // Only a short excerpt is persisted; full bodies never live in SQLite.
    bodyExcerpt: subject.body.slice(0, 500),
    bodyChars: subject.body.length,
    comments: commentRows.map((comment) => ({
      author: comment.author,
      excerpt: comment.body.slice(0, 200),
    })),
    commentsRead: commentRows.length,
    files,
    totalChangedFiles: subject.changedFiles ?? (args.kind === 'pull_request' ? files.length : null),
    htmlUrl: subject.htmlUrl,
    truncated: commentRows.length >= args.maxComments || files.length >= args.maxFiles,
  };

  const generationInput: GenerationInput = {
    kind: args.kind,
    trigger: args.trigger,
    action: args.action,
    repo: { owner: args.repo.owner, name: args.repo.name },
    number: args.number,
    title: subject.title,
    body: subject.body,
    author: subject.author,
    labels: subject.labels,
    comments: commentRows.map((comment) => ({
      author: comment.author,
      body: comment.body.slice(0, 1000),
    })),
    files,
    totalChangedFiles: summary.totalChangedFiles ?? files.length,
    language: args.language,
    maxReplyChars: 2000,
    mention: args.mention,
  };

  return { summary, generationInput };
}
