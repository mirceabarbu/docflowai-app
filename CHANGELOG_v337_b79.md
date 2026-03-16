# DocFlowAI v3.3.7 — Changelog (b79)

## Modificări față de b78

### 🔴 Hotfix — SyntaxError la startup în outreach.mjs:208

#### b79 — 16.03.2026

**Fișier:** `server/routes/admin/outreach.mjs` — o singură linie.

**Cauza:** La generarea codului în b78, `'\n'` din Python a fost
interpretat ca newline real → în fișierul JS a apărut un string literal
neînchis → `SyntaxError: Invalid or unexpected token` la linia 208.

**Fix:**
```js
// ÎNAINTE (string neînchis în fișier):
rows = data.split('
').slice(1)...

// DUPĂ:
rows = data.split(/\r?\n/).slice(1)...
```
Regex `/\r?\n/` este mai robust (suportă și CRLF din Windows).

**`package.json`** — version bump `3.3.38` → `3.3.39`
