import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const projectRoot = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  root: projectRoot,
  test: {
    environment: 'node',
    setupFiles: [path.join(projectRoot, 'vitest.setup.ts')],
    include: ['tests/**/*.test.{ts,tsx}'],
    testTimeout: 20000,
    hookTimeout: 20000,
    restoreMocks: true,
  },
});
