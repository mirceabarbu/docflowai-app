# DocFlowAI v3.3.7 — Changelog (b70)

## Modificări față de b69

### 🟢 Calitate — fix teste integration (32/32 passed)

#### b70 — 15.03.2026

**Fișier:** `server/tests/integration/login.test.mjs` — singurul fișier modificat.
Zero cod de producție atins.

**Problema 1 — testele 2,3,4 returnau 401 în loc de 200:**
`vi.clearAllMocks()` resetează `calls` și `results` dar NU resetează queue-ul
`mockResolvedValueOnce`. Testul anterior consumă un slot din queue; testele
următoare găsesc queue-ul parțial consumat → `pool.query` returnează `undefined`
→ destructurare `{ rows }` eșuează.
Fix: `vi.resetAllMocks()` — resetează și queue-ul (comportament corect pentru izolare completă între teste).

**Problema 2 — cookie lipsă în testul HttpOnly:**
`sameSite: 'strict'` blochează cookie-ul în supertest fără `Host` header valid.
Fix: `.set('host', 'localhost')` + parsing robust al `set-cookie`
(poate fi string sau array în funcție de numărul de cookie-uri).

**Rezultat:** 32/32 teste trec (față de 28/32 înainte).

**`package.json`** — version bump `3.3.29` → `3.3.30`
