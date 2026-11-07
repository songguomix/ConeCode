import { contextBridge, ipcRenderer } from 'electron';
import type { ComputerPreviewAPI, ComputerPreviewSnapshot } from '../src/core/computer/preview';

// Keep runtime imports out of this sandboxed preload. Electron's restricted
// require supports Electron itself; this deliberately exposes no generic IPC.
const api: ComputerPreviewAPI = {
  getState: () => ipcRenderer.invoke('computer-preview:get-state'),
  onState: (callback) => {
    const listener = (_event: unknown, state: ComputerPreviewSnapshot) => callback(state);
    ipcRenderer.on('computer-preview:state', listener);
    return () => ipcRenderer.removeListener('computer-preview:state', listener);
  },
};
contextBridge.exposeInMainWorld('computerPreviewAPI', api);
