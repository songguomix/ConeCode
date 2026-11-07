import fs from 'node:fs';
import path from 'node:path';
import { BrowserWindow, dialog, ipcMain, shell } from 'electron';
import type {
  CatalogQuery,
  MarketEvent,
} from '../../src/core/dsh-market/types';
import { DshMarketService } from './market-service';

export interface DshMarketIpcOptions {
  service: DshMarketService;
  getWindow: () => BrowserWindow | null;
}

function broadcast(event: MarketEvent, getWindow: () => BrowserWindow | null): void {
  const bind = () => {
    const window = getWindow();
    if (window && !window.isDestroyed()) window.webContents.send('dsh-market:event', event);
  };
  bind();
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('dsh-market:event', event);
  }
}

export function registerDshMarketIpc(options: DshMarketIpcOptions): void {
  const { service, getWindow } = options;
  service.runtime.onEvent((event) => broadcast(event, getWindow));

  ipcMain.handle('dsh-market:snapshot', (_, query?: CatalogQuery) => service.snapshot(query || {}));
  ipcMain.handle('dsh-market:detail', (_, pluginId: string, version?: string) => service.detail(pluginId, version));
  ipcMain.handle('dsh-market:versions', (_, pluginId: string) => service.versions(pluginId));
  ipcMain.handle('dsh-market:inspect-repository', (_, input: string, ref?: string, subdir?: string) => service.inspectRepository(input, ref, subdir));
  ipcMain.handle('dsh-market:install-repository', (_, profileId: string, input: string, ref?: string, subdir?: string, opts?: { acceptRisk?: boolean; allowScripts?: boolean }) => service.installRepository(profileId, input, ref, subdir, opts || {}));
  ipcMain.handle('dsh-market:refresh-sources', (_, sourceId?: string) => service.refreshSources(sourceId));
  ipcMain.handle('dsh-market:add-remote-source', (_, url: string, title?: string) => service.addRemoteSource(url, title));
  ipcMain.handle('dsh-market:add-local-source', async () => {
    const window = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a directory containing catalog.json',
      properties: ['openDirectory', 'createDirectory'],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return service.addLocalSource(result.filePaths[0]);
  });
  ipcMain.handle('dsh-market:remove-source', (_, sourceId: string) => {
    service.removeSource(sourceId);
    return true;
  });
  ipcMain.handle('dsh-market:inspect-local', async () => {
    const window = getWindow();
    const options: Electron.OpenDialogOptions = {
      title: 'Choose a local DSH bundle or ConeCode-native plugin',
      properties: ['openDirectory'],
    };
    const result = window ? await dialog.showOpenDialog(window, options) : await dialog.showOpenDialog(options);
    if (result.canceled || !result.filePaths[0]) return null;
    return service.inspectLocalPlugin(result.filePaths[0]);
  });
  ipcMain.handle('dsh-market:install-local', (_, profileId: string, directory: string, opts?: { acceptRisk?: boolean; allowScripts?: boolean }) =>
    service.installLocal(profileId, directory, opts || {}));
  ipcMain.handle('dsh-market:install', (_, profileId: string, pluginId: string, version?: string, opts?: { acceptRisk?: boolean; allowScripts?: boolean }) =>
    service.install(profileId, pluginId, version, opts || {}));
  ipcMain.handle('dsh-market:rollback', (_, profileId: string, pluginId: string, version?: string) =>
    service.rollback(profileId, pluginId, version));
  ipcMain.handle('dsh-market:uninstall', (_, profileId: string, pluginId: string, deleteData?: boolean) =>
    service.uninstall(profileId, pluginId, deleteData === true));
  ipcMain.handle('dsh-market:set-enabled', (_, profileId: string, pluginId: string, enabled: boolean) =>
    service.setEnabled(profileId, pluginId, enabled));
  ipcMain.handle('dsh-market:save-config', (_, profileId: string, pluginId: string, configs: Record<string, unknown>) =>
    service.saveConfig(profileId, pluginId, configs || {}));
  ipcMain.handle('dsh-market:cancel', (_, requestId: string) => {
    service.cancel(requestId);
    return true;
  });
  ipcMain.handle('dsh-market:logs', (_, profileId: string, pluginId: string) => service.logs(profileId, pluginId));
  ipcMain.handle('dsh-market:contributions', (_, profileId: string, pluginId?: string) => service.contributions(profileId, pluginId));
  ipcMain.handle('dsh-market:invoke-tool', (_, profileId: string, pluginId: string, tool: string, args: unknown, rowId?: string) =>
    service.invokeTool(profileId, pluginId, tool, args, rowId));
  ipcMain.handle('dsh-market:invoke-command', (_, profileId: string, pluginId: string, command: string, rawInput: string, rowId?: string) =>
    service.invokeCommand(profileId, pluginId, command, rawInput, rowId));
  ipcMain.handle('dsh-market:skills', () => service.listSkills());
  ipcMain.handle('dsh-market:skill-content', (_, pluginId: string, name: string) => service.getSkill(pluginId, name));
  ipcMain.handle('dsh-market:switch-profile', (_, profileId: string) => service.switchProfile(profileId));
  ipcMain.handle('dsh-market:create-profile', (_, profileId: string, name?: string) => service.createProfile(profileId, name));
  ipcMain.handle('dsh-market:restart-runtime', () => service.restartRuntime());
  ipcMain.handle('dsh-market:open-external', async (_, url: string) => {
    let parsed: URL;
    try { parsed = new URL(url); } catch { throw new Error('Invalid URL'); }
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') throw new Error('Only http(s) links can be opened');
    await shell.openExternal(parsed.toString());
    return true;
  });
  ipcMain.handle('dsh-market:reveal-path', (_, target: string) => {
    if (!target || !fs.existsSync(target)) throw new Error('Path does not exist');
    shell.showItemInFolder(statusIsFile(target) ? target : path.join(target, '.'));
    return true;
  });
  ipcMain.handle('dsh-market:reveal-log', async (_, profileId: string, pluginId: string) => {
    const log = await service.logs(profileId, pluginId);
    if (!fs.existsSync(log.path)) throw new Error('No log file has been written yet.');
    shell.showItemInFolder(log.path);
    return log.path;
  });
}

function statusIsFile(target: string): boolean {
  try { return fs.statSync(target).isFile(); } catch { return false; }
}
