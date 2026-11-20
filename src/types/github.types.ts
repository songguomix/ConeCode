export interface GithubAccountStatus {
  state: 'unavailable' | 'signed-out' | 'pending' | 'signed-in' | 'error';
  login?: string;
  deviceCode?: string;
  error?: 'login-failed' | 'logout-failed' | 'status-failed' | 'timed-out';
}

export interface GithubPushBranches {
  sourceBranch?: string;
  targetBranch?: string;
  createTarget?: boolean;
  commitChanges?: boolean;
  /** Fingerprint of the origin push URL shown during review. */
  originKey?: string;
}

export interface GithubRemoteOptions {
  cwd: string;
  repo?: string;
  token?: string;
}

export interface GithubPushOptions extends GithubRemoteOptions, GithubPushBranches {
  message?: string;
}

export interface GithubCreateBranchOptions {
  cwd: string;
  name: string;
  base?: string;
  checkout?: boolean;
}

export interface GithubBranches {
  ok: boolean;
  branches: string[];
  message?: string;
}

export interface GithubLocalBranches extends GithubBranches {
  current: string | null;
  pushUrl?: string;
  originKey?: string;
}
