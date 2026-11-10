import path from 'node:path';
import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  HOST: z.string().min(1).default('0.0.0.0'),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  DATABASE_URL: z.string().min(1).default('file:./data/reply-bot.db'),
  ADMIN_TOKEN: z.string().min(1).optional(),
  GITHUB_APP_ID: z.string().regex(/^\d+$/, 'GITHUB_APP_ID must be numeric').optional(),
  GITHUB_PRIVATE_KEY: z.string().min(1).optional(),
  GITHUB_WEBHOOK_SECRET: z.string().min(1).optional(),
  GITHUB_APP_SLUG: z.string().min(1).optional(),
  LLM_ENDPOINT: z.string().url().optional(),
  LLM_API_KEY: z.string().min(1).optional(),
  LLM_MODEL: z.string().min(1).default('gpt-4o-mini'),
  LLM_TIMEOUT_MS: z.coerce.number().int().min(1000).max(60000).default(15000),
  WORKER_INTERVAL_MS: z.coerce.number().int().min(50).max(60000).default(1000),
  RETENTION_SWEEP_INTERVAL_MS: z.coerce.number().int().min(60000).default(3_600_000),
  PUBLIC_DIR: z.string().optional(),
  MIGRATIONS_DIR: z.string().optional(),
});

export interface GitHubConfig {
  appId: number | null;
  privateKey: string | null;
  webhookSecret: string | null;
  appSlug: string | null;
}

export interface LlmConfig {
  endpoint: string | null;
  apiKey: string | null;
  model: string;
  timeoutMs: number;
}

export interface AppConfig {
  nodeEnv: 'development' | 'test' | 'production';
  port: number;
  host: string;
  logLevel: 'fatal' | 'error' | 'warn' | 'info' | 'debug' | 'trace' | 'silent';
  databasePath: string;
  adminToken: string | null;
  github: GitHubConfig;
  llm: LlmConfig;
  migrationsDir: string;
  publicDir: string;
  workerIntervalMs: number;
  retentionSweepIntervalMs: number;
  missingConfig: string[];
}

export function resolveDatabasePath(raw: string): string {
  const trimmed = raw.startsWith('file:') ? raw.slice('file:'.length) : raw;
  if (!trimmed) throw new Error('DATABASE_URL is empty');
  if (trimmed === ':memory:' || trimmed.startsWith(':memory:')) return ':memory:';
  return path.isAbsolute(trimmed) ? trimmed : path.resolve(process.cwd(), trimmed);
}

/**
 * Loads configuration without throwing on missing GitHub credentials: the
 * service must start and surface a clear configuration error instead of
 * crashing. Malformed values (e.g. a non-numeric app id) still fail fast.
 */
function stripEmptyValues(env: NodeJS.ProcessEnv): Record<string, string | undefined> {
  const cleaned: Record<string, string | undefined> = {};
  for (const [key, value] of Object.entries(env)) {
    cleaned[key] = typeof value === 'string' && value.trim() === '' ? undefined : value;
  }
  return cleaned;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): AppConfig {
  // `cp .env.example .env` leaves optional values empty; treat them as absent
  // instead of failing validation.
  const parsed = envSchema.safeParse(stripEmptyValues(env));
  if (!parsed.success) {
    const issues = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid environment configuration: ${issues}`);
  }
  const e = parsed.data;
  const privateKey = e.GITHUB_PRIVATE_KEY ? e.GITHUB_PRIVATE_KEY.replace(/\\n/g, '\n') : null;
  const github: GitHubConfig = {
    appId: e.GITHUB_APP_ID ? Number(e.GITHUB_APP_ID) : null,
    privateKey,
    webhookSecret: e.GITHUB_WEBHOOK_SECRET ?? null,
    appSlug: e.GITHUB_APP_SLUG ?? null,
  };
  const missingConfig: string[] = [];
  if (!e.ADMIN_TOKEN) missingConfig.push('ADMIN_TOKEN');
  if (github.appId === null) missingConfig.push('GITHUB_APP_ID');
  if (!github.privateKey) missingConfig.push('GITHUB_PRIVATE_KEY');
  if (!github.webhookSecret) missingConfig.push('GITHUB_WEBHOOK_SECRET');

  return {
    nodeEnv: e.NODE_ENV,
    port: e.PORT,
    host: e.HOST,
    logLevel: e.LOG_LEVEL,
    databasePath: resolveDatabasePath(e.DATABASE_URL),
    adminToken: e.ADMIN_TOKEN ?? null,
    github,
    llm: {
      endpoint: e.LLM_ENDPOINT ?? null,
      apiKey: e.LLM_API_KEY ?? null,
      model: e.LLM_MODEL,
      timeoutMs: e.LLM_TIMEOUT_MS,
    },
    migrationsDir: path.resolve(process.cwd(), e.MIGRATIONS_DIR ?? 'drizzle'),
    publicDir: path.resolve(process.cwd(), e.PUBLIC_DIR ?? 'dist/web'),
    workerIntervalMs: e.WORKER_INTERVAL_MS,
    retentionSweepIntervalMs: e.RETENTION_SWEEP_INTERVAL_MS,
    missingConfig,
  };
}

export function githubConfigured(config: AppConfig): boolean {
  return config.github.appId !== null && Boolean(config.github.privateKey);
}

export function webhookConfigured(config: AppConfig): boolean {
  return Boolean(config.github.webhookSecret);
}
