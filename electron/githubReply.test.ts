import { describe, expect, it, vi } from 'vitest';
import { getReplyThread, listReplyThreads, postReply, statusMessage } from './githubReply';

type ReplyInit = { method?: string; headers?: Record<string, string>; body?: string };

function response(status: number, body: unknown) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

const issue = {
  number: 7,
  title: 'Crash when starting the app',
  body: 'Steps to reproduce: run it.',
  user: { login: 'alice' },
  labels: [{ name: 'bug' }],
  comments: 2,
  updated_at: '2025-01-01T00:00:00Z',
  html_url: 'https://github.com/acme/widgets/issues/7',
  state: 'open',
};

const pullRequest = {
  ...issue,
  number: 9,
  title: 'Add caching',
  pull_request: { url: 'https://api.github.com/repos/acme/widgets/pulls/9' },
};

describe('GitHub reply list', () => {
  it('returns open issues and pull requests from the API', async () => {
    const request = vi.fn(async (_url: string, _init?: ReplyInit) =>
      response(200, [issue, pullRequest, { garbage: true }])
    );
    const result = await listReplyThreads({ repo: 'acme/widgets', token: 't' }, request);
    expect(result.ok).toBe(true);
    expect(result.items).toHaveLength(2);
    expect(result.items[0]).toMatchObject({ number: 7, isPullRequest: false, author: 'alice', labels: ['bug'] });
    expect(result.items[1]).toMatchObject({ number: 9, isPullRequest: true });
    expect(request.mock.calls[0][0]).toContain('/repos/acme/widgets/issues?state=open');
  });

  it('rejects invalid repositories without calling GitHub', async () => {
    const request = vi.fn();
    const result = await listReplyThreads({ repo: 'not a repo', token: '' }, request);
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });

  it('maps HTTP failures to actionable messages', async () => {
    const request = vi.fn(async () => response(401, {}));
    const result = await listReplyThreads({ repo: 'acme/widgets', token: 'bad' }, request);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('401');
    expect(statusMessage(403)).toContain('read/write');
    expect(statusMessage(404)).toContain('owner/repo');
  });

  it('never echoes the token in transport errors', async () => {
    const token = 'ghp_supersecrettokenvalue0123456789';
    const request = vi.fn(async () => {
      throw new Error(`connect failed for ${token}`);
    });
    const result = await listReplyThreads({ repo: 'acme/widgets', token }, request);
    expect(result.ok).toBe(false);
    expect(result.message).not.toContain(token);
    expect(result.message).toContain('***');
  });
});

describe('GitHub reply context', () => {
  it('loads the thread body and most recent comments in chronological order', async () => {
    const request = vi.fn(async (url: string) => {
      if (url.includes('/comments')) {
        return response(200, [
          { id: 2, body: 'second', user: { login: 'bob' }, created_at: '2025-01-02T00:00:00Z' },
          { id: 1, body: 'first', user: { login: 'carol' }, created_at: '2025-01-01T00:00:00Z' },
        ]);
      }
      return response(200, issue);
    });
    const result = await getReplyThread({ repo: 'acme/widgets', number: 7 }, request);
    expect(result.ok).toBe(true);
    expect(result.context?.repo).toBe('acme/widgets');
    expect(result.context?.recentComments.map((comment) => comment.id)).toEqual([1, 2]);
    expect(request.mock.calls[0][0]).toContain('/issues/7');
    expect(request.mock.calls[1][0]).toContain('per_page=10');
  });

  it('still returns the thread when comments cannot be loaded', async () => {
    const request = vi.fn(async (url: string) =>
      url.includes('/comments') ? response(500, {}) : response(200, pullRequest)
    );
    const result = await getReplyThread({ repo: 'acme/widgets', number: 9 }, request);
    expect(result.ok).toBe(true);
    expect(result.context?.isPullRequest).toBe(true);
    expect(result.context?.recentComments).toEqual([]);
  });

  it('requires a valid thread number', async () => {
    const request = vi.fn();
    const result = await getReplyThread({ repo: 'acme/widgets', number: 0 }, request);
    expect(result.ok).toBe(false);
    expect(request).not.toHaveBeenCalled();
  });
});

describe('GitHub reply posting', () => {
  it('posts a sanitized reply and returns the comment link', async () => {
    const request = vi.fn(async (_url: string, _init?: ReplyInit) =>
      response(201, { id: 99, html_url: 'https://github.com/acme/widgets/issues/7#issuecomment-99' })
    );
    const result = await postReply(
      { repo: 'acme/widgets', token: 't', number: 7, body: 'Thanks @everyone for the report!' },
      request
    );
    expect(result.ok).toBe(true);
    expect(result.id).toBe(99);
    expect(result.url).toContain('issuecomment-99');
    const init = request.mock.calls[0][1];
    expect(init?.method).toBe('POST');
    expect(JSON.parse(String(init?.body)).body).not.toContain('@everyone');
  });

  it('refuses to post without a token', async () => {
    const request = vi.fn();
    const result = await postReply({ repo: 'acme/widgets', token: '', number: 7, body: 'hi' }, request);
    expect(result.ok).toBe(false);
    expect(result.message).toContain('token');
    expect(request).not.toHaveBeenCalled();
  });

  it('blocks replies that contain secrets', async () => {
    const request = vi.fn();
    const result = await postReply(
      { repo: 'acme/widgets', token: 't', number: 7, body: 'here: ghp_abcdefghijklmnopqrstuvwxyz0123456789' },
      request
    );
    expect(result.ok).toBe(false);
    expect(result.message).toContain('secret');
    expect(request).not.toHaveBeenCalled();
  });

  it('reports locked threads and empty replies', async () => {
    const locked = await postReply(
      { repo: 'acme/widgets', token: 't', number: 7, body: 'hello' },
      vi.fn(async () => response(422, {}))
    );
    expect(locked.ok).toBe(false);
    expect(locked.message).toContain('422');

    const empty = await postReply(
      { repo: 'acme/widgets', token: 't', number: 7, body: '   ' },
      vi.fn()
    );
    expect(empty.ok).toBe(false);
  });
});
