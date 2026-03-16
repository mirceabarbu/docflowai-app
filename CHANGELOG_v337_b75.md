# DocFlowAI v3.3.7 — Changelog (b75)

## Modificări față de b74

### 🔴 Bug fix — org_admin nu putea șterge utilizatori

#### b75 — 16.03.2026

**Fișier:** `server/routes/admin.mjs` — o singură linie modificată.

**Problema:**
`DELETE /admin/users/:id` verifica `actor.role !== 'admin'` — bloca
orice `org_admin`, returnând 403 → „Eroare la ștergere" în UI.

Inconsistență față de celelalte endpoint-uri de pe același resurs:
- `PUT /admin/users/:id` → `isAdminOrOrgAdmin()` ✅
- `POST /admin/users/:id/reset-password` → `isAdminOrOrgAdmin()` ✅
- `DELETE /admin/users/:id` → `actor.role !== 'admin'` ❌ ← bug

**Fix:**
```js
// ÎNAINTE:
if (actor.role !== 'admin') return res.status(403)...
// DUPĂ:
if (!isAdminOrOrgAdmin(actor)) return res.status(403)...
```

**Protecția cross-tenant rămâne intactă** (linia SEC-07):
`DELETE FROM users WHERE id=$1 AND org_id=$2`
— `org_admin` poate șterge doar useri din propria organizație.

**`package.json`** — version bump `3.3.34` → `3.3.35`
