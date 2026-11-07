import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { startFixtureServer } from '../src/fixtures/web-app.js';
import { RuntimeService } from '../src/service/runtime-service.js';

it.each([false, true])('recovers after a real SIGKILL (write committed=%s) without replaying the click', async (committed) => {
  const fixture = await startFixtureServer();
  await fixture.reset();
  const dir = await mkdtemp(join(tmpdir(), 'cua-process-crash-'));
  const worker = fork(fileURLToPath(new URL('./helpers/crash-worker.mjs', import.meta.url)), [], {
    execArgv: ['--import', 'tsx'], stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
    env: { ...process.env, CUA_CRASH_FIXTURE_URL: fixture.url, CUA_CRASH_DATA_DIR: dir, CUA_CRASH_AFTER_COMMIT: committed ? '1' : '0' },
  });
  let output = '';
  worker.stdout?.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  worker.stderr?.on('data', (chunk) => { output = (output + chunk).slice(-4000); });
  let service: RuntimeService | undefined;
  try {
    const point = await new Promise<{ taskId: string; actionId: string; sessionId: string }>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`Worker did not reach crash point: ${output}`)), 15_000);
      worker.on('message', (message: any) => {
        if (message?.type === 'kill-point') { clearTimeout(timer); resolve(message); }
      });
      worker.once('error', (error) => { clearTimeout(timer); reject(error); });
      worker.once('exit', () => { clearTimeout(timer); reject(new Error(`Worker exited before crash: ${output}`)); });
    });
    const exit = once(worker, 'exit');
    expect(worker.kill('SIGKILL')).toBe(true);
    const [, signal] = await exit;
    expect(signal).toBe('SIGKILL');
    const before = await fixture.readData();
    expect(before.projects[0]!.name).toBe(committed ? 'Demo' : 'Alpha');
    service = new RuntimeService({ dataDir: dir, recoverOnStart: true, monitorIntervalMs: 0 });
    await service.start();
    const detail = service.getTask(point.taskId);
    expect(detail.task.status).toBe(committed ? 'succeeded' : 'needs_attention');
    expect(detail.actions.find((a) => a.proposal.id === point.actionId)?.result).toMatchObject({ status: 'unknown', sideEffectUnknown: true });
    expect(detail.actions.filter((a) => a.proposal.action.tool === 'browser.click')).toHaveLength(1);
    expect(detail.task.sessionId).not.toBe(point.sessionId);
    expect(await fixture.readData()).toEqual(before);
  } finally {
    if (worker.exitCode === null && worker.signalCode === null) worker.kill('SIGKILL');
    await service?.close();
    await fixture.close();
    await rm(dir, { recursive: true, force: true });
  }
}, 45_000);
