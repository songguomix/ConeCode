// Standalone dev server for eyeballing components in isolation (no Electron).
// Kept out of vite.config.ts so the electron plugin doesn't launch the app.
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

export default defineConfig({
  root: path.resolve(__dirname),
  plugins: [react()],
  server: { port: 5199 },
});
