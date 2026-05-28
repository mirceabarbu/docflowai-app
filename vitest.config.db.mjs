/**
 * DocFlowAI — Vitest config pentru testele pe Postgres REAL.
 *   npm run test:db    — rulează server/tests/db/** pe TEST_DATABASE_URL
 *
 * Diferențe față de vitest.config.mjs:
 *  - include DOAR server/tests/db/**
 *  - fileParallelism: false (un singur DB partajat → fără curse pe TRUNCATE)
 */
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    setupFiles: ['./server/tests/setup.mjs'],
    include: ['server/tests/db/**/*.test.mjs'],
    fileParallelism: false,
    testTimeout: 30_000,
    hookTimeout: 60_000,
    reporter: 'verbose',
  },
});
