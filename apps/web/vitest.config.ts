import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';
export default defineConfig({
  resolve: {
    alias: {
      'server-only': fileURLToPath(
        new URL(
          './node_modules/next/dist/compiled/server-only/empty.js',
          import.meta.url,
        ),
      ),
    },
  },
  test: {
    exclude: ['e2e/**', 'node_modules/**', '.next/**'],
    environment: 'jsdom',
  },
});
