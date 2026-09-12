import { defineConfig } from 'vitest/config';

// Standalone Vitest config (kept separate from vite.config.ts, which loads the
// electron plugin). Runs in the node environment with a tiny localStorage shim
// (vitest.setup.ts) so the Zustand stores the tested modules import don't crash.
export default defineConfig({
  test: {
    environment: 'node',
    globals: true,
    setupFiles: ['./vitest.setup.ts'],
    // electron/ too: the main-process modules are plain Node (no `electron`
    // import at load time), so things like the preview dev server are testable.
    include: ['src/**/*.test.ts', 'electron/**/*.test.ts'],
  },
});
