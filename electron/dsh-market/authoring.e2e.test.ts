import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { expect, it } from 'vitest';
import { DshMarketService } from './market-service';

it.skipIf(process.env.DSH_MARKET_INSTALL_E2E !== '1')('runs the authoring example and routes each configured command instance through chat', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'conecode-authoring-'));
  const service = new DshMarketService({ rootDir: root, appPath: process.cwd(), versions: { app: 'test', electron: 'test' } });
  try {
    const source = path.resolve('examples/dsh-plugins/hello-dsh');
    const installed = await service.installLocal('default', source);
    const command = 'hello_dsh';
    expect((await service.invokeCommand('default', installed.id, command, '松果')).value).toEqual({ kind: 'success', text: '你好，松果！' });
    const [first] = await service.listChatTools();
    expect(await service.callChatTool(first.server, command, {})).toContain('你好，世界！');
    await service.saveConfig('default', installed.id, { 'hello-dsh': { greeting: '早上好' } });
    expect((await service.invokeCommand('default', installed.id, command, '松果')).rendered).toContain('早上好，松果！');

    const updated = path.join(root, 'next');
    await fs.cp(source, updated, { recursive: true });
    const manifest = JSON.parse(await fs.readFile(path.join(updated, 'package.json'), 'utf8'));
    await fs.writeFile(path.join(updated, 'package.json'), JSON.stringify({ ...manifest, version: '1.1.0' }));
    await fs.appendFile(path.join(updated, 'cordis.patch.yml'), '    - id: evening\n      name: conecode-hello-dsh\n      config:\n        greeting: 晚上好\n');
    await service.installLocal('default', updated);
    const tools = (await service.listChatTools()).filter((tool) => tool.name === command);
    expect(tools).toHaveLength(2);
    expect(new Set(tools.map((tool) => tool.server)).size).toBe(2);
    for (const tool of tools) {
      const result = await service.callChatTool(tool.server, tool.name, { input: '松果' });
      expect(result).toContain(tool.description.includes('evening') ? '晚上好，松果！' : '早上好，松果！');
    }
    await service.uninstall('default', installed.id);
    expect((await service.listChatTools()).filter((tool) => tool.name === command)).toHaveLength(0);
  } finally {
    await service.runtime.shutdown();
    await service.state.flush();
    await fs.rm(root, { recursive: true, force: true });
  }
}, 120_000);
