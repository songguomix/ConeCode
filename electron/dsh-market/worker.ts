import { parentPort } from 'node:worker_threads';
import { RuntimeHost } from './runtime-host';

interface Request {
  id: number;
  type: string;
  payload?: any;
}

if (!parentPort) throw new Error('DSH runtime worker requires a parent port');
const port = parentPort;
const host = new RuntimeHost();
host.setLogSink((message, level = 'info') => {
  port.postMessage({ event: 'log', message, level, at: new Date().toISOString() });
});

function serializableError(error: unknown): { message: string; stack?: string; code?: string; missing?: string[] } {
  if (error instanceof Error) {
    return {
      message: error.message,
      stack: error.stack,
      code: (error as Error & { code?: string }).code,
      ...((error as Error & { missing?: string[] }).missing ? { missing: (error as Error & { missing?: string[] }).missing } : {}),
    };
  }
  return { message: String(error) };
}

async function handle(request: Request): Promise<unknown> {
  const payload = request.payload || {};
  switch (request.type) {
    case 'init': {
      if (payload.dshHome) process.env.DSH_HOME = String(payload.dshHome);
      await host.start({ dshHome: payload.dshHome ? String(payload.dshHome) : undefined, profileId: payload.profileId ? String(payload.profileId) : undefined });
      return { ok: true, pid: process.pid, node: process.versions.node, storage: host.storageInfo() };
    }
    case 'load':
      return host.load(payload.spec);
    case 'unload':
      await host.unload(String(payload.pluginId));
      return { ok: true };
    case 'reload':
      return host.reload(payload.spec);
    case 'probe':
      return host.probe(payload.spec);
    case 'contributions':
      return host.contributions(payload.pluginId);
    case 'listSkills':
      return host.listSkills();
    case 'getSkill':
      return host.getSkill(String(payload.pluginId), String(payload.name));
    case 'invokeTool':
      return host.invokeTool(String(payload.pluginId), payload.rowId ?? null, String(payload.name), payload.args ?? {});
    case 'invokeCommand':
      return host.invokeCommand(String(payload.pluginId), payload.rowId ?? null, String(payload.name), String(payload.rawInput ?? ''));
    case 'info':
      return { plugins: host.runtimeInfo(), storage: host.storageInfo() };
    case 'shutdown':
      await host.dispose();
      return { ok: true };
    default:
      throw new Error(`Unknown worker request: ${request.type}`);
  }
}

port.on('message', async (request: Request) => {
  if (!request || typeof request.id !== 'number' || typeof request.type !== 'string') return;
  try {
    const result = await handle(request);
    port.postMessage({ id: request.id, ok: true, result });
  } catch (error) {
    port.postMessage({ id: request.id, ok: false, error: serializableError(error) });
  }
});

process.on('uncaughtException', (error) => {
  port.postMessage({ event: 'fatal', error: serializableError(error) });
  process.exitCode = 1;
});
process.on('unhandledRejection', (error) => {
  port.postMessage({ event: 'fatal', error: serializableError(error) });
  process.exitCode = 1;
});
