# DocFlowAI v3.3.7 — Changelog (b80)

## Modificări față de b79

### 🔴 BUG-N01 — Recovery archive_jobs blocate după Railway restart

**Fișier:** `server/index.mjs`

**Problema:** `_runArchiveJobProcessor()` setează `status='processing'` la preluarea unui job, dar nu resetează niciodată job-urile rămase în `processing` după un restart Railway. La repornire, funcția selectează doar `status='pending'` — job-urile blocate nu sunt niciodată reluate, cauzând pierdere silențioasă de date.

**Fix:** La startup, după ce `initDbWithRetry()` finalizează cu succes, se execută un query de recovery:

```sql
UPDATE archive_jobs
SET status = 'pending', started_at = NULL
WHERE status = 'processing'
  AND started_at < NOW() - INTERVAL '30 minutes'
```

Logat cu `logger.warn` dacă există job-uri resetate, silențios dacă nu.

---

### 🟠 BUG-N02 — org_admin limitat la propria instituție în flows.mjs

**Fișier:** `server/routes/flows.mjs`

**Problema:** Rolul `org_admin` era fie complet ignorat (5 endpoint-uri cu `=== 'admin'` strict), fie acceptat fără verificare de tenant (2 endpoint-uri cu `|| actor.role === 'org_admin'` neprotejat).

**Fix:** Toate cele **8 instanțe** `isAdmin` din flows.mjs folosesc acum condiția:

```js
const isAdmin = actor.role === 'admin' ||
  (actor.role === 'org_admin' && Number(data.orgId) === Number(actor.orgId));
```

- `admin` global → acces la orice flux ✅
- `org_admin` → acces **doar** la fluxurile din propria instituție (`data.orgId === actor.orgId`) ✅
- `org_admin` cross-tenant → `403 forbidden` ✅

**Endpoint-uri afectate (linii):**
| Linia | Handler |
|-------|---------|
| 331 | `DELETE /flows/:flowId` |
| 721 | `POST /flows/:flowId/reinitiate` |
| 817 | `POST /flows/:flowId/request-review` |
| 882 | `POST /flows/:flowId/reinitiate-review` |
| 998 | `POST /flows/:flowId/delegate` |
| 1106 | `POST /flows/:flowId/cancel` |
| 1159 | `POST /flows/:flowId/attachments` |
| 1245 | `DELETE /flows/:flowId/attachments/:attId` |

---

### 🟠 BUG-N03 — Swagger /api-docs protejat cu autentificare

**Fișier:** `server/index.mjs`

**Problema:** `/api-docs` și `/api-docs.json` erau accesibile oricui fără autentificare, expunând structura completă a API-ului intern.

**Fix:**
- `GET /api-docs.json` — returnează `401` dacă cookie-ul `auth_token` lipsește
- `GET /api-docs` — redirect la `/login.html?redirect=/api-docs` dacă nu e autentificat

---

### 🟡 PERF-04 — Pool DB max: 10 → 20

**Fișier:** `server/db/index.mjs`

```js
// ÎNAINTE:
max: 10
// DUPĂ:
max: 20, idleTimeoutMillis: 30000
```

Previne bottleneck-ul la peak load (arhivare batch + reminder jobs + request-uri normale concurente).

---

### 🟡 CODE-N02 — APP_VERSION din package.json (single source of truth)

**Fișier:** `server/index.mjs`

Versiunea hardcodată `'3.3.7'` din endpoint-urile `/health` și `/admin/health` înlocuită cu `APP_VERSION` citit dinamic din `package.json`:

```js
const _pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url)));
const APP_VERSION = _pkg.version; // '3.3.40'
```

Log-ul de startup afișează acum versiunea corectă automat la fiecare bump.

---

**`package.json`** — version bump `3.3.39` → `3.3.40`

---

### 🟠 BUG-UI01 — org_admin fără instituție vedea ⚠ Administrare fluxuri și 🧹 VACUUM

**Fișier:** `public/admin.html`

**Problema:** `lockOrgAdminFilters(institutie)` începea cu `if (!institutie) return` —
dacă un `org_admin` nu avea câmpul `institutie` populat în profil, funcția ieșea imediat
fără să ascundă `adminFluxSection`. Aceasta conține: ⚠ Ștergere fluxuri vechi, 💣 Ștergere TOATE și 🧹 VACUUM ANALYZE — operații rezervate exclusiv super-adminului.

**Fix:** Ascunderea `adminFluxSection` mutată **înaintea** guard-ului `if (!institutie) return`,
astfel încât să se execute întotdeauna pentru `org_admin`, indiferent de profilul utilizatorului.
Linia duplicată de ascundere de la finalul funcției eliminată.
