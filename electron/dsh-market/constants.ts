import { DSH_BASELINE, DSH_COMPAT_LAYER_VERSION } from '../../src/core/dsh-market/types';

/** The exact host packages every profile resolves for DSH plugins. */
export const SHARED_DSH_RUNTIME: ReadonlyArray<{ name: string; version: string }> = [
  { name: '@deepseek-ai/cordis', version: '4.1.0' },
  { name: '@deepseek-ai/schemastery', version: '3.19.0' },
  { name: '@deepseek-ai/dsh-tools', version: '0.2.2-rc.1' },
  // @deepseek-ai/dsh-tools imports these peers at module scope.
  { name: '@deepseek-ai/dsh-agent', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-llm', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-scope', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-session', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-system-prompt', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-user-approval', version: '0.2.2-rc.1' },
  // Official DSH storage substrate: hub, JSON backend, typed KV domains.
  { name: '@deepseek-ai/dsh-storage', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-storage-json', version: '0.2.2-rc.1' },
  { name: '@deepseek-ai/dsh-storage-domain', version: '0.2.2-rc.1' },
];

export const RUNTIME_DIR_NAME = '.conecode-runtime';
export const STATE_FILE_NAME = 'market-state.json';

/** Services this adapter actually provides. Anything else is a hard error. */
export const SUPPORTED_HOST_SERVICES = [
  'tools',
  'commands',
  'skills',
  'credentials',
  // Available only after the profile runtime provides the official storage stack.
  'storage',
  'storageDomain',
  'storage.backend.json',
] as const;

/** Cordis built-ins a plugin may reference without a host provider. */
export const CORDIS_BUILTIN_SERVICES = [
  'logger',
  'events',
  'reflect',
  'registry',
  'fiber',
] as const;

export const SUPPORTED_FORMATS = ['dsh-bundle', 'conecode-native'] as const;

export const BASELINE = {
  ...DSH_BASELINE,
  layerVersion: DSH_COMPAT_LAYER_VERSION,
  nodeRequirement: '>=24.9.0',
} as const;

export const MAX_README_BYTES = 512 * 1024;
export const MAX_CATALOG_BYTES = 12 * 1024 * 1024;
export const MAX_LOG_BYTES = 512 * 1024;
export const NPM_INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
export const PROBE_TIMEOUT_MS = 45 * 1000;
