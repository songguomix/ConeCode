import { beforeEach, describe, expect, it, vi } from 'vitest';
import { normalizeRepo, useMarketStore } from './market.store';

const SKILL_A = `---\nname: Alpha\ndescription: First remote skill for testing sync.\n---\nDo alpha things.`;
const SKILL_B = `---\nname: Beta\ndescription: Second remote skill for testing sync.\n---\nDo beta things.`;

function json(obj: unknown, status = 200) {
  return new Response(JSON.stringify(obj), { status });
}

beforeEach(() => {
  localStorage.clear();
  vi.clearAllMocks();
  useMarketStore.setState({
    repo: 'o/r',
    tokenSet: false,
    remote: [],
    fetchedAt: null,
    syncing: false,
    error: null,
  });
  (globalThis as any).window = {
    electronAPI: {
      skill: {
        install: vi.fn(async () => ({ ok: true })),
        list: vi.fn(async () => ({ global: [], project: [] })),
        remove: vi.fn(async () => ({ ok: true })),
      },
      conversation: { create: vi.fn(), list: vi.fn(async () => []), update: vi.fn() },
      message: { create: vi.fn(), list: vi.fn(async () => []) },
      chat: { onChunk: vi.fn(() => () => {}), stream: vi.fn(), stop: vi.fn() },
    },
  };
});

describe('normalizeRepo', () => {
  it('accepts owner/repo and github URLs, rejects the rest', () => {
    expect(normalizeRepo('o/r')).toBe('o/r');
    expect(normalizeRepo('https://github.com/o/r')).toBe('o/r');
    expect(normalizeRepo('https://github.com/o/r.git')).toBe('o/r');
    expect(normalizeRepo('not a repo')).toBeNull();
    expect(normalizeRepo('')).toBeNull();
  });
});

describe('market sync', () => {
  it('lists SKILL.md files and parses them', async () => {
    (globalThis as any).fetch = vi.fn(async (url: string, opts: any) => {
      if (String(url).includes('/git/trees/')) {
        return json({ tree: [
          { type: 'blob', path: 'alpha/SKILL.md' },
          { type: 'blob', path: 'beta/SKILL.md' },
          { type: 'blob', path: 'README.md' },
        ] });
      }
      if (String(url).includes('alpha%2FSKILL.md') || String(url).includes('alpha/SKILL.md')) {
        return new Response(SKILL_A, { status: 200 });
      }
      return new Response(SKILL_B, { status: 200 });
    });
    const ok = await useMarketStore.getState().sync();
    expect(ok).toBe(true);
    const remote = useMarketStore.getState().remote;
    expect(remote.map((r) => r.id).sort()).toEqual(['alpha', 'beta']);
    expect(remote[0].body.length).toBeGreaterThan(0);
    expect(useMarketStore.getState().error).toBeNull();
  });

  it('maps failures to friendly errors', async () => {
    (globalThis as any).fetch = vi.fn(async () => new Response('x', { status: 404 }));
    expect(await useMarketStore.getState().sync()).toBe(false);
    expect(useMarketStore.getState().error).toBe('repo-not-found');

    (globalThis as any).fetch = vi.fn(async (url: string) =>
      String(url).includes('/git/trees/') ? json({ tree: [] }) : new Response('x', { status: 200 }),
    );
    expect(await useMarketStore.getState().sync()).toBe(false);
    expect(useMarketStore.getState().error).toBe('empty-repo');
  });

  it('installs through the custom (unreviewed) path', async () => {
    const { useSkillsStore } = await import('./skills.store');
    const alpha = {
      id: 'alpha', name: 'Alpha', scope: 'global', source: 'custom',
      description: 'First remote skill for testing sync installs.',
      tags: ['market'], body: 'Do alpha things thoroughly and well.',
    };
    (window as any).electronAPI.skill.list = vi.fn(async () => ({ global: [alpha], project: [] }));
    useSkillsStore.setState({ installed: [], effective: [], loaded: true } as any);
    const ok = await useMarketStore.getState().installRemote(
      { id: 'alpha', name: 'Alpha', description: 'First remote skill for testing sync installs.', path: 'alpha/SKILL.md', body: 'Do alpha things thoroughly and well.' },
      'global',
    );
    expect(ok).toBe(true);
    const install = (window as any).electronAPI.skill.install;
    expect(install).toHaveBeenCalledTimes(1);
    expect(String(install.mock.calls[0][0].content)).toContain('source: custom');
    // Origin baseline recorded for push-back.
    const origins = useMarketStore.getState().origins;
    expect(origins.alpha.repo).toBe('o/r');
    expect(origins.alpha.path).toBe('alpha/SKILL.md');
    expect(useMarketStore.getState().hasLocalChanges('alpha')).toBe(false);
  });

  it('pushes local edits back and reports conflicts', async () => {
    const { useSkillsStore } = await import('./skills.store');
    const alpha = {
      id: 'alpha', name: 'Alpha', scope: 'global', source: 'custom',
      description: 'First remote skill for testing sync installs.',
      tags: ['market'], body: 'Do alpha things thoroughly and well.',
    };
    useSkillsStore.setState({ installed: [alpha], effective: [alpha], loaded: true } as any);
    useMarketStore.setState({
      origins: { alpha: { repo: 'o/r', path: 'alpha/SKILL.md', content: 'baseline' } },
    });

    // Local edit detected.
    expect(useMarketStore.getState().hasLocalChanges('alpha')).toBe(true);

    // No token → refuse without touching the network.
    localStorage.removeItem('conecode.pluginToken');
    const calls: any[] = [];
    (globalThis as any).fetch = vi.fn(async (url: string, opts: any) => {
      calls.push({ url, method: opts?.method || 'GET', body: opts?.body });
      if ((opts?.method || 'GET') === 'PUT') return new Response('{}', { status: 200 });
      return new Response(JSON.stringify({ sha: 'abc' }), { status: 200 });
    });
    expect(await useMarketStore.getState().pushSkill('alpha')).toBe(false);
    expect(useMarketStore.getState().error).toBe('auth-failed');
    expect(calls).toHaveLength(0);

    // With token: GET sha then PUT new content, baseline advances.
    localStorage.setItem('conecode.pluginToken', 'tok');
    expect(await useMarketStore.getState().pushSkill('alpha')).toBe(true);
    const put = calls.find((c) => c.method === 'PUT');
    expect(put.url).toContain('/repos/o/r/contents/alpha/SKILL.md');
    const payload = JSON.parse(put.body);
    expect(payload.sha).toBe('abc');
    expect(payload.message).toContain('alpha');
    expect(Buffer.from(payload.content, 'base64').toString('utf-8')).toContain('Do alpha things');
    expect(useMarketStore.getState().hasLocalChanges('alpha')).toBe(false);

    // Remote moved on → conflict, baseline untouched.
    (globalThis as any).fetch = vi.fn(async (url: string, opts: any) => {
      if ((opts?.method || 'GET') === 'PUT') return new Response('{}', { status: 409 });
      return new Response(JSON.stringify({ sha: 'other' }), { status: 200 });
    });
    useSkillsStore.setState({
      installed: [{ ...alpha, body: 'CHANGED again' }],
      effective: [],
      loaded: true,
    } as any);
    expect(await useMarketStore.getState().pushSkill('alpha')).toBe(false);
    expect(useMarketStore.getState().error).toBe('conflict');
    expect(useMarketStore.getState().hasLocalChanges('alpha')).toBe(true);
  });
});
