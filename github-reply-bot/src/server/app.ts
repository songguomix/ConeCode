import fs from 'node:fs';
import path from 'node:path';
import Fastify, { type FastifyInstance } from 'fastify';
import fastifyStatic from '@fastify/static';
import { loadConfig, githubConfigured, webhookConfigured, type AppConfig } from './config';
import { openDatabase, type DatabaseHandle } from './db';
import { Store } from './db/store';
import { MissingCredentialsGitHubApi, OctokitGitHubApi } from './github/client';
import type { GitHubApi } from './github/types';
import { registerApi } from './api/routes';
import { registerWebhookRoute } from './webhook/route';
import { startWorker, type WorkerDeps } from './worker/worker';

const APP_VERSION = '0.1.0';

export interface BuildAppOptions {
  config?: AppConfig;
  database?: DatabaseHandle;
  github?: GitHubApi;
  createGenerator?: WorkerDeps['createGenerator'];
  startWorker?: boolean;
  logger?: boolean;
}

export interface BuiltApp {
  app: FastifyInstance;
  config: AppConfig;
  store: Store;
  database: DatabaseHandle;
  close: () => Promise<void>;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<BuiltApp> {
  const config = options.config ?? loadConfig();
  const database = options.database ?? openDatabase(config.databasePath, config.migrationsDir);
  const store = new Store(database);
  store.seedBuiltinTemplates();
  store.getGlobalSettings();

  const github =
    options.github ??
    (githubConfigured(config) ? new OctokitGitHubApi(config.github) : new MissingCredentialsGitHubApi());

  const app = Fastify({
    logger:
      options.logger === false
        ? false
        : {
            level: config.logLevel,
            redact: [
              'req.headers.authorization',
              'req.headers.cookie',
              'req.headers["x-hub-signature-256"]',
              'res.headers["set-cookie"]',
            ],
          },
    bodyLimit: 2 * 1024 * 1024,
  });

  // Keep the raw payload for HMAC verification while still parsing JSON.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'buffer' },
    (request, body, done) => {
      const buffer = body as Buffer;
      request.rawBody = buffer;
      if (!buffer || buffer.length === 0) {
        done(null, undefined);
        return;
      }
      try {
        done(null, JSON.parse(buffer.toString('utf8')));
      } catch (error) {
        const parseError = error as Error & { statusCode?: number };
        parseError.statusCode = 400;
        done(parseError, undefined);
      }
    }
  );

  app.get('/health', async () => ({
    status: 'ok',
    version: APP_VERSION,
    githubConfigured: githubConfigured(config),
    webhookConfigured: webhookConfigured(config),
    adminConfigured: Boolean(config.adminToken),
    missingConfig: config.missingConfig,
  }));

  registerWebhookRoute(app, { store, config, logger: app.log });
  registerApi(app, { store, config });

  const indexHtml = path.join(config.publicDir, 'index.html');
  if (fs.existsSync(indexHtml)) {
    await app.register(fastifyStatic, { root: config.publicDir, prefix: '/' });
    app.setNotFoundHandler((request, reply) => {
      const url = request.raw.url ?? '';
      if (url.startsWith('/api') || url.startsWith('/webhook') || url.startsWith('/health')) {
        return reply.code(404).send({ error: 'not_found', message: '未知路径' });
      }
      return reply.sendFile('index.html');
    });
  }

  const worker =
    options.startWorker === false
      ? null
      : startWorker(
          {
            store,
            github,
            config,
            logger: app.log,
            createGenerator: options.createGenerator,
          },
          config.workerIntervalMs
        );

  return {
    app,
    config,
    store,
    database,
    close: async () => {
      worker?.stop();
      await app.close();
      if (!options.database) database.close();
    },
  };
}
