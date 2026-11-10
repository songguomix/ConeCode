import { describe, expect, it } from 'vitest';
import { mapPermissionLevel, MissingCredentialsGitHubApi } from '../src/server/github/client';
import { GitHubApiError } from '../src/server/github/types';

describe('GitHub permission mapping', () => {
  it('treats the modern maintain role as maintainer', () => {
    expect(mapPermissionLevel('write', 'maintain')).toBe('maintain');
    expect(mapPermissionLevel('admin', 'admin')).toBe('admin');
  });

  it('falls back to the legacy permission when role_name is absent or custom', () => {
    expect(mapPermissionLevel('write', null)).toBe('write');
    expect(mapPermissionLevel('read', 'custom-auditor')).toBe('read');
    expect(mapPermissionLevel('triage', undefined)).toBe('triage');
  });

  it('rejects unknown values instead of assuming elevated access', () => {
    expect(mapPermissionLevel('bogus', 'bogus-role')).toBe('unknown');
    expect(mapPermissionLevel(undefined, undefined)).toBe('unknown');
  });
});

describe('missing credentials client', () => {
  it('fails every call with an explicit configuration error', async () => {
    const github = new MissingCredentialsGitHubApi();
    const failure = await github.getIssue().catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(GitHubApiError);
    expect((failure as GitHubApiError).code).toBe('github_app_not_configured');
    await expect(github.createComment()).rejects.toThrow(/未配置/);
  });
});
