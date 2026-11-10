/** Types shared by the renderer, preload, main process and tests for the GitHub reply assistant. */

export type ReplyLanguage = 'auto' | 'zh' | 'en';

export interface ReplyThreadSummary {
  number: number;
  title: string;
  isPullRequest: boolean;
  author: string;
  labels: string[];
  comments: number;
  updatedAt: string;
  url: string;
}

export interface ReplyComment {
  id: number;
  author: string;
  body: string;
  createdAt: string;
}

export interface ReplyThreadContext extends ReplyThreadSummary {
  repo: string;
  state: string;
  body: string;
  recentComments: ReplyComment[];
}

export interface ReplyListRequest {
  repo: string;
  token?: string;
}

export interface ReplyContextRequest {
  repo: string;
  token?: string;
  number: number;
}

export interface ReplyPostRequest {
  repo: string;
  token?: string;
  number: number;
  body: string;
}

export interface ReplyListResult {
  ok: boolean;
  items: ReplyThreadSummary[];
  message?: string;
}

export interface ReplyContextResult {
  ok: boolean;
  context?: ReplyThreadContext;
  message?: string;
}

export interface ReplyPostResult {
  ok: boolean;
  id?: number;
  url?: string;
  message: string;
}
