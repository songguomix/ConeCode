import React from 'react';
import ReactDOM from 'react-dom/client';
import App from './App';
import './index.css';
import { isScreenshotWindowHash } from './core/screenshot/window';
import ScreenshotWindowRoot from './components/screenshot/ScreenshotWindowRoot';

if (isScreenshotWindowHash(window.location.hash)) {
  // Fullscreen screenshot overlay window (WeChat-style): only the capture UI,
  // none of the app chrome — the window itself is transparent over the desktop.
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <ScreenshotWindowRoot />
    </React.StrictMode>
  );
} else {
  ReactDOM.createRoot(document.getElementById('root')!).render(
    <React.StrictMode>
      <App />
    </React.StrictMode>
  );
}
