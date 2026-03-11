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

// ── Cleanup după toate testele ────────────────────────────────────────────────
// (nimic de cleanup global deocamdată — fiecare test suite face cleanup propriu)
