/**
 * DocFlowAI — Vitest configuration v3.3.5
 *
 * Setup:
 *   npm run test         — rulează toate testele
 *   npm run test:watch   — watch mode (development)
 *   npm run test:coverage — raport coverage
 */

import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',

    // Setează JWT_SECRET și alte env vars ÎNAINTE de orice import de modul
    setupFiles: ['./server/tests/setup.mjs'],

    // Pattern fișiere de test
    include: ['server/tests/**/*.test.mjs', 'server/services/**/__tests__/*.test.mjs'],

    // Timeout per test (PBKDF2 100k iterații durează ~200ms)
    testTimeout: 15_000,

    // Raport human-readable în terminal
    reporter: 'verbose',

    // Coverage (opțional, via npm run test:coverage)
    coverage: {
      provider: 'v8',
      reporter: ['text', 'json-summary'],
      include: ['server/**/*.mjs'],
      exclude: [
        'server/tests/**',
        'server/db/index.mjs',      // migrations — testate separat / manual
        'server/drive.mjs',         // Google Drive API — necesită credentials reale
        'server/gws.mjs',           // Google Workspace API — necesită credentials
        'server/whatsapp.mjs',      // API extern
        'server/push.mjs',          // Web Push
      ],
    },
  },
});
