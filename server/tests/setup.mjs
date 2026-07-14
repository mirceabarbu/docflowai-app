/**
 * DocFlowAI — Vitest global setup
 *
 * Rulat înaintea oricărui fișier de test (setupFiles în vitest.config.mjs).
 * Setează variabilele de mediu necesare ÎNAINTE ca modulele să fie importate,
 * altfel middleware/auth.mjs apelează process.exit(1) la lipsă JWT_SECRET.
 */

// ── Env vars necesare pentru boot ────────────────────────────────────────────
process.env.JWT_SECRET         = 'test-jwt-secret-vitest-docflowai-2025';
process.env.PORT               = '0';       // OS assign (nu pornim serverul real)
process.env.NODE_ENV           = 'test';
process.env.LOG_LEVEL          = 'error';   // Silențiem logurile în output teste
process.env.LOG_PRETTY         = '0';

// ── Postgres real (doar pentru server/tests/db/**) ───────────────────────────
// Dacă există TEST_DATABASE_URL, îl punem pe DATABASE_URL ÎNAINTE ca db/index.mjs
// să fie importat (pool-ul se creează la import). Testele mock-uite ignoră complet
// asta (înlocuiesc modulul prin vi.mock).
if (process.env.TEST_DATABASE_URL && !process.env.DATABASE_URL) {
  process.env.DATABASE_URL = process.env.TEST_DATABASE_URL;
}
if (process.env.TEST_DATABASE_URL) {
  process.env.DB_DISABLE_SSL = '1';
}

// config.mjs cere DATABASE_URL la import (via `required`). Pentru testele mock
// (fără TEST_DATABASE_URL) punem un placeholder — pool-ul pg e lazy (nu se
// conectează la import) și db/index.mjs e oricum mock-uit în testele mock.
if (!process.env.DATABASE_URL) {
  process.env.DATABASE_URL = 'postgres://test:test@127.0.0.1:5432/docflowai_test';
}

// ── Cleanup după toate testele ────────────────────────────────────────────────
// (nimic de cleanup global deocamdată — fiecare test suite face cleanup propriu)
