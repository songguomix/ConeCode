/** @vitest-environment jsdom */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { AuthProvider } from '../src/web/auth';
import { setToken } from '../src/web/api';
import { LoginPage } from '../src/web/pages/LoginPage';
import { RepoSettingsPage } from '../src/web/pages/RepoSettingsPage';
import { RunDetailPage } from '../src/web/pages/RunDetailPage';
import type { GlobalSettingsDto, RepoSettingsDto, RepositoryDto, RunDto } from '../src/shared/types';

const STAMP = '2025-01-01T00:00:00.000Z';

const repoSettings: RepoSettingsDto = {
  onIssueOpened: true,
  onIssueLabeled: false,
  onPrOpened: false,
  onPrLabeled: false,
  onMention: false,
  autoPostEnabled: false,
  requireApproval: true,
  triggerLabels: [],
  mentionTriggerEnabled: false,
  allowedTriggerRoles: 'maintainer',
  rateLimitPerHour: 10,
  quietHoursEnabled: false,
  quietHoursStart: '22:00',
  quietHoursEnd: '08:00',
  quietHoursTimezone: 'UTC',
  maxReplyChars: 2000,
  maxContextComments: 10,
  maxChangedFiles: 20,
  templateId: null,
  storeEventPayload: false,
  updatedAt: STAMP,
};

const repository: RepositoryDto = {
  id: 1,
  installationId: 1,
  githubRepoId: 500,
  owner: 'acme',
  name: 'widgets',
  repoEnabled: true,
  createdAt: STAMP,
  updatedAt: STAMP,
  settings: repoSettings,
};

const globalSettings: GlobalSettingsDto = {
  automationEnabled: true,
  dryRun: false,
  generatorProvider: 'template',
  retentionDays: 30,
  defaultReplyLanguage: 'auto',
  updatedAt: STAMP,
};

const run: RunDto = {
  id: 1,
  deliveryId: 'delivery-1',
  dedupeKey: 'dedupe-1',
  eventType: 'issues',
  action: 'opened',
  triggerKind: 'issue_opened',
  labels: ['bug'],
  repoId: 1,
  repository: 'acme/widgets',
  issueNumber: 7,
  prNumber: null,
  actorLogin: 'alice',
  actorIsBot: false,
  status: 'drafted',
  reason: 'approval_required',
  contextSummary: { title: 'Crash on start', author: 'alice', labels: ['bug'], bodyExcerpt: 'Steps to reproduce…' },
  eventPayload: null,
  generatedReply: 'Thanks for the report, alice.',
  editedReply: null,
  postedCommentId: null,
  errorCode: null,
  errorMessage: null,
  attempts: 1,
  fallbackUsed: false,
  createdAt: STAMP,
  updatedAt: STAMP,
};

type MockResult = { status?: number; body?: unknown };

function mockFetch(handler: (url: string, init?: RequestInit) => MockResult | Promise<MockResult>) {
  const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input.toString();
    const result = await handler(url, init);
    return new Response(result.body === undefined ? null : JSON.stringify(result.body), {
      status: result.status ?? 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
  sessionStorage.clear();
});

describe('login page', () => {
  it('shows the API error when the token is rejected', async () => {
    const fetchMock = mockFetch((url) =>
      url === '/api/auth/login' ? { status: 401, body: { message: '令牌无效' } } : { body: {} }
    );
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>概览页面</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText('管理员令牌'), 'bad-token');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('令牌无效');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(screen.queryByText('概览页面')).not.toBeInTheDocument();
  });

  it('stores the token and navigates to the overview on success', async () => {
    mockFetch((url) => (url === '/api/auth/login' ? { body: { ok: true } } : { body: {} }));
    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/login']}>
        <AuthProvider>
          <Routes>
            <Route path="/login" element={<LoginPage />} />
            <Route path="/" element={<div>概览页面</div>} />
          </Routes>
        </AuthProvider>
      </MemoryRouter>
    );

    await user.type(screen.getByLabelText('管理员令牌'), 'good-token');
    await user.click(screen.getByRole('button', { name: '登录' }));

    expect(await screen.findByText('概览页面')).toBeInTheDocument();
    expect(sessionStorage.getItem('replybot.adminToken')).toBe('good-token');
  });
});

describe('repository settings page', () => {
  it('turns off approval when auto-post is enabled and saves the payload', async () => {
    setToken('test-token');
    const sent: Record<string, unknown>[] = [];
    mockFetch((url, init) => {
      if (url === '/api/repos/1' && (!init || init.method === undefined)) {
        return { body: { repo: repository } };
      }
      if (url === '/api/templates') return { body: { items: [] } };
      if (url === '/api/repos/1/settings' && init?.method === 'PUT') {
        const payload = JSON.parse(String(init.body)) as Record<string, unknown>;
        sent.push(payload);
        return { body: { settings: { ...repoSettings, ...payload, updatedAt: STAMP } } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/repos/1']}>
        <Routes>
          <Route path="/repos/:id" element={<RepoSettingsPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('acme/widgets')).toBeInTheDocument();
    await user.click(screen.getByRole('switch', { name: '自动发布' }));
    await user.click(screen.getByRole('button', { name: '保存设置' }));

    expect(await screen.findByText('仓库设置已保存')).toBeInTheDocument();
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ autoPostEnabled: true, requireApproval: false });
  });

  it('shows a server validation error without pretending success', async () => {
    setToken('test-token');
    mockFetch((url, init) => {
      if (url === '/api/repos/1' && (!init || init.method === undefined)) {
        return { body: { repo: repository } };
      }
      if (url === '/api/templates') return { body: { items: [] } };
      if (url === '/api/repos/1/settings' && init?.method === 'PUT') {
        return { status: 400, body: { error: 'invalid_settings', message: '自动发布与人工审核互斥' } };
      }
      return { status: 404, body: {} };
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/repos/1']}>
        <Routes>
          <Route path="/repos/:id" element={<RepoSettingsPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('acme/widgets');
    await user.click(screen.getByRole('button', { name: '保存设置' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('自动发布与人工审核互斥');
    expect(screen.queryByText('仓库设置已保存')).not.toBeInTheDocument();
  });
});

describe('run detail page', () => {
  it('approves an edited draft after confirmation', async () => {
    setToken('test-token');
    const approveCalls: string[] = [];
    mockFetch((url, init) => {
      if (url === '/api/runs/1' && (!init || init.method === undefined)) {
        return { body: { run, jobs: [], audit: [] } };
      }
      if (url === '/api/settings') return { body: { settings: globalSettings } };
      if (url === '/api/runs/1/approve' && init?.method === 'POST') {
        approveCalls.push(String(init.body));
        return { body: { run: { ...run, status: 'approved' } } };
      }
      return { status: 404, body: { message: 'not found' } };
    });

    const user = userEvent.setup();
    render(
      <MemoryRouter initialEntries={['/runs/1']}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    expect(await screen.findByText('运行 #1')).toBeInTheDocument();
    const editor = screen.getByLabelText('可编辑内容（批准时以此为准）');
    expect(editor).toHaveValue('Thanks for the report, alice.');

    await user.click(screen.getByRole('button', { name: '批准并发布' }));
    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: '确认发布' }));

    await waitFor(() => expect(approveCalls).toHaveLength(1));
    expect(JSON.parse(approveCalls[0])).toMatchObject({ reply: 'Thanks for the report, alice.' });
  });

  it('disables approval while dry-run is enabled', async () => {
    setToken('test-token');
    mockFetch((url, init) => {
      if (url === '/api/runs/1' && (!init || init.method === undefined)) {
        return { body: { run, jobs: [], audit: [] } };
      }
      if (url === '/api/settings') {
        return { body: { settings: { ...globalSettings, dryRun: true } } };
      }
      return { status: 404, body: {} };
    });

    render(
      <MemoryRouter initialEntries={['/runs/1']}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    );

    await screen.findByText('运行 #1');
    await waitFor(() =>
      expect(screen.getByRole('button', { name: '批准并发布' })).toBeDisabled()
    );
    expect(screen.getAllByText(/dry-run/).length).toBeGreaterThan(0);
  });
});
