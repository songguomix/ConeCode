import 'dotenv/config';
import { buildApp } from './app';
import { loadConfig } from './config';

const RETENTION_SWEEP_MS = 60 * 60 * 1000;

async function main(): Promise<void> {
  const config = loadConfig();
  const built = await buildApp({ config });

  if (config.missingConfig.length > 0) {
    built.app.log.error(
      { missing: config.missingConfig },
      '缺少必需配置，服务已启动但相关功能不可用：请参考 README 配置环境变量'
    );
  }
  if (config.github.appSlug === null) {
    built.app.log.warn('GITHUB_APP_SLUG 未配置：@提及触发无法识别');
  }

  configuredRetentionSweep(built);
  await built.app.listen({ port: config.port, host: config.host });
  built.app.log.info({ port: config.port, host: config.host }, 'reply-bot listening');

  let shuttingDown = false;
  const shutdown = async (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    built.app.log.info({ signal }, 'shutting down');
    try {
      await built.close();
      process.exit(0);
    } catch (error) {
      built.app.log.error({ err: (error as Error).message }, 'shutdown_failed');
      process.exit(1);
    }
  };
  process.on('SIGINT', () => void shutdown('SIGINT'));
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
}

function configuredRetentionSweep(built: Awaited<ReturnType<typeof buildApp>>): void {
  const timer = setInterval(
    () => {
      try {
        const days = built.store.getGlobalSettings().retentionDays;
        const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString();
        const result = built.store.purgeOlderThan(cutoff);
        if (result.runs > 0 || result.audits > 0) {
          built.app.log.info(result, 'retention_sweep_completed');
        }
      } catch (error) {
        built.app.log.error({ err: (error as Error).message }, 'retention_sweep_failed');
      }
    },
    Math.max(RETENTION_SWEEP_MS, built.config.retentionSweepIntervalMs)
  );
  timer.unref();
}

main().catch((error) => {
  console.error('Failed to start reply bot:', error);
  process.exit(1);
});
