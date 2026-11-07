import React from 'react';
import ReactDOM from 'react-dom/client';
import './index.css';
import { isScreenshotWindowHash } from './core/screenshot/window';
import { isComputerPreviewWindowHash } from './core/computer/preview';

async function mount() {
  const root = ReactDOM.createRoot(document.getElementById('root')!);
  if (isComputerPreviewWindowHash(window.location.hash)) {
    document.documentElement.classList.add('computer-preview-document');
    // This window has a deliberately restricted preload. Do not import the
    // app stores, browser bridge, provider startup, or main-window effects.
    const { default: ComputerPreviewWindow } = await import('./components/computer/ComputerPreviewWindow');
    root.render(<React.StrictMode><ComputerPreviewWindow /></React.StrictMode>);
    return;
  }
  // Browser-only previews need their shim before importing the app's stores.
  await import('./core/browser/bridge');
  const { default: Component } = isScreenshotWindowHash(window.location.hash)
    ? await import('./components/screenshot/ScreenshotWindowRoot')
    : await import('./App');
  root.render(<React.StrictMode><Component /></React.StrictMode>);
}

void mount();
