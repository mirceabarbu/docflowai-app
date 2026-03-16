# DocFlowAI v3.3.7 — Changelog (b71)

## Modificări față de b69

### 🟢 Calitate — fix 5 teste eșuate (32/32 passed)

#### b71 — 15.03.2026

Fișiere modificate: doar teste. Zero cod de producție atins.

**`server/tests/integration/login.test.mjs`**

Fix 1 — testele 1,2,3,4 (cookie + 3× 401 în loc de 200):
`vi.clearAllMocks()` nu resetează queue-ul `mockResolvedValueOnce`.
Testul anterior consumă un slot → testele următoare găsesc queue-ul gol
→ `pool.query` returnează `undefined` → crash → 401.
Fix: `vi.clearAllMocks()` + `dbModule.pool.query.mockReset()` explicit.
(vi.resetAllMocks() era prea agresiv — reseta și requireDb mock)

Fix 2 — cookie HttpOnly lipsă:
`sameSite: 'strict'` blochează cookie-ul în supertest fără Host header.
Fix: `.set('host', 'localhost')` + parsing robust set-cookie.

**`server/tests/unit/auth-crypto.test.mjs`**

Fix 3 — timeout round-trip (5 parole × 3 PBKDF2 600k = lent pe mașini slabe):
Timeout ridicat la `60_000` ms pe acel test specific.

**`package.json`** — version bump `3.3.29` → `3.3.31`
