# DocFlowAI v3.3.7 — Changelog (b69)

## Modificări față de b68

### 🔴 Hotfix — SyntaxError import incorect injectAdminRateLimiter

#### b69 — 15.03.2026

**Cauza:** În b67, `injectAdminRateLimiter` a fost adăugat ca export în
`server/middleware/auth.mjs`. Dar `server/index.mjs` îl importa din
`./routes/auth.mjs` (unde nu există) împreună cu `injectRateLimiter`.

**Fix:** Import separat pe surse corecte:
- `injectRateLimiter` → `./routes/auth.mjs` (neschimbat)
- `injectAdminRateLimiter` → `./middleware/auth.mjs` (corectat)

**`package.json`** — version bump `3.3.28` → `3.3.29`
