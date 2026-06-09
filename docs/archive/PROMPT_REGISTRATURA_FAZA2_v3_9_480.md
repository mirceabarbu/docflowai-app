# DocFlowAI — 📥 v3.9.480: Registratură Faza 2 — documente INTRATE (manual, petiții/544, lifecycle, atașament, legătură răspuns)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.479 → v3.9.480 (SW v195 → v196)
Branch: develop
Subiect: feat(registratura): Faza 2 — înregistrare manuală documente intrate,
         registre petiții/544 cu termene legale, lifecycle status, atașament
         scanat, legătură intrare↔ieșire (derivată, fără hook pe lifecycle)
```

---

## 🎯 Context — ce adaugă Faza 2

Faza 1 (v3.9.479, deja în producție-staging) dă **automat** număr documentelor
**emise** (`directie='iesire'`, `sursa_tip='flow'`). Faza 2 adaugă cealaltă
jumătate a unei registraturi reale: **documente intrate**, înregistrate **manual**
de operator (nu au flux DocFlowAI în spate).

Ce construim:

1. **Înregistrare manuală** a unui document intrat: expeditor, obiect, mod primire,
   nr/dată documentul expeditorului, compartiment repartizat. Primește număr din
   aceeași serie atomică (`allocateNumber`), cu `directie='intrare'`.
2. **Registre multiple**: `intrare` (general intrări), `petitii` (OG 27/2002,
   termen 30 zile), `544` (Legea 544/2001, termen 10 zile). Schema 074 permite
   deja registre multiple (coloana `registru` e TEXT fără CHECK) — fără migrare grea.
3. **Termen legal** auto-calculat din tipul registrului (`termen_at = data_inreg
   + termen_zile`), afișat și evidențiat când e depășit.
4. **Lifecycle status** pentru intrate: `inregistrat → repartizat → in_lucru →
   solutionat | clasat`. Tranziții validate server-side.
5. **Atașament scanat** (PDF) per poziție de intrare — `BYTEA`, patternul
   `formular_attachments`/`flow_attachments` existent.
6. **Legătură intrare↔ieșire**: o poziție de intrare poate fi legată de un flux
   de ieșire (răspunsul). Când fluxul-răspuns e finalizat, intrarea apare
   automat `solutionat` — **derivat la citire** prin `LEFT JOIN flows`, ZERO hook
   pe `lifecycle.mjs`/semnare (la fel ca derivarea statusului în Faza 1).
7. **UI**: `registratura.html` capătă `df-subtabs` — **Ieșiri** (lista Faza 1,
   neschimbată) | **Intrări** (listă nouă + formular înregistrare + acțiuni status).

Modulul e deja în „Module & permisiuni" din Faza 1 (`module_catalog`) — Faza 2
NU mai atinge catalogul/entitlements.

---

## ⛔ ABSOLUTE — NU se ating

1. `server/routes/flows/cloud-signing.mjs`
2. `server/routes/flows/bulk-signing.mjs`
3. `server/services/pades.mjs`
4. `server/services/java-pades-client.mjs`
5. `server/signing/providers/STSCloudProvider.mjs`
6. `server/routes/flows/lifecycle.mjs` — legătura intrare↔ieșire e derivată la
   citire, **fără** hook pe finalizare/anulare.
7. `server/routes/flows/crud.mjs` — Faza 2 NU îl atinge deloc. Numerotarea
   documentelor emise (Faza 1) rămâne exact cum e.
8. `stampFooterOnPdf` din `server/index.mjs` — neatins.
9. Calea **emise** din `allocateNumber`: apelul existent din `crud.mjs` (fără
   parametri noi) trebuie să producă comportament **byte-identic** cu Faza 1
   (`directie='iesire'`, coloane noi NULL). Toate adăugirile în serviciu sunt
   strict aditive, cu default-uri care păstrează semantica Faza 1.
10. Niciun test existent nu e șters / dezactivat.

---

## 📋 Modificări detaliate

### 1. `server/db/index.mjs` — migrarea `075_registratura_faza2`

**Verificare context curent (post-Faza-1):**
```bash
grep -n "id: '074_registratura'" server/db/index.mjs
# Așteptat: 1 (ultima migrare din array)
grep -n "^];" server/db/index.mjs | head -1
# Așteptat: linia care închide MIGRATIONS, imediat după 074
```

**Patch:** adaugă obiectul migrării ca **ultim element**, înainte de `];`.

old_str:
```javascript
      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('registratura', 'Registratură', 'documente', TRUE, 80)
      ON CONFLICT (module_key) DO NOTHING;
    `
  }
];
```

new_str:
```javascript
      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('registratura', 'Registratură', 'documente', TRUE, 80)
      ON CONFLICT (module_key) DO NOTHING;
    `
  },
  {
    id: '075_registratura_faza2',
    sql: `
      -- Faza 2: coloane lifecycle/intrate pe registru_intrari + atașamente.
      -- Documentele emise (Faza 1) au aceste coloane NULL — comportament neschimbat.

      ALTER TABLE registru_intrari
        ADD COLUMN IF NOT EXISTS status            TEXT,
        ADD COLUMN IF NOT EXISTS mod_primire       TEXT,
        ADD COLUMN IF NOT EXISTS nr_doc_expeditor  TEXT,
        ADD COLUMN IF NOT EXISTS data_doc_expeditor DATE,
        ADD COLUMN IF NOT EXISTS termen_zile       INTEGER,
        ADD COLUMN IF NOT EXISTS termen_at         DATE,
        ADD COLUMN IF NOT EXISTS repartizat_la     TEXT,
        ADD COLUMN IF NOT EXISTS repartizat_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS solutionat_at     TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS clasat_at         TIMESTAMPTZ,
        ADD COLUMN IF NOT EXISTS raspuns_flow_id   TEXT;

      DO $g$ BEGIN
        ALTER TABLE registru_intrari
          ADD CONSTRAINT registru_status_chk
          CHECK (status IS NULL OR status IN
            ('inregistrat','repartizat','in_lucru','solutionat','clasat'));
      EXCEPTION WHEN duplicate_object THEN NULL;
      END $g$;

      CREATE INDEX IF NOT EXISTS idx_registru_intrari_dir
        ON registru_intrari (org_id, directie, an, numar DESC);
      CREATE INDEX IF NOT EXISTS idx_registru_raspuns
        ON registru_intrari (raspuns_flow_id) WHERE raspuns_flow_id IS NOT NULL;

      CREATE TABLE IF NOT EXISTS registru_atasamente (
        id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
        intrare_id  BIGINT      NOT NULL REFERENCES registru_intrari(id) ON DELETE CASCADE,
        org_id      INTEGER     NOT NULL REFERENCES organizations(id),
        filename    TEXT        NOT NULL,
        mime_type   TEXT        NOT NULL DEFAULT 'application/pdf',
        size_bytes  INTEGER     NOT NULL DEFAULT 0,
        data        BYTEA       NOT NULL,
        uploaded_by INTEGER     REFERENCES users(id),
        uploaded_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        deleted_at  TIMESTAMPTZ
      );
      CREATE INDEX IF NOT EXISTS idx_registru_atas_intrare
        ON registru_atasamente (intrare_id, deleted_at);
    `
  }
];
```

---

### 2. `server/services/registratura.mjs` — extinde `allocateNumber` (strict aditiv)

Calea emise (apelul din `crud.mjs`, fără câmpuri noi) rămâne identică:
`directie` default `'iesire'`, coloanele Faza 2 → NULL. Adăugăm parametri
opționali pentru intrate.

**2a. Semnătura JSDoc + parametri noi.**

**Verificare context:**
```bash
grep -n "export async function allocateNumber" server/services/registratura.mjs
grep -n "const registru = String" server/services/registratura.mjs
```

old_str:
```javascript
  const orgId   = Number(p.orgId);
  const sursaId = String(p.sursaId || '').trim();
  const registru = String(p.registru || 'general').trim() || 'general';
  const sursaTip = String(p.sursaTip || 'flow').trim() || 'flow';
  if (!pool || !orgId || !sursaId) return null;
```

new_str:
```javascript
  const orgId   = Number(p.orgId);
  const sursaId = String(p.sursaId || '').trim();
  const registru = String(p.registru || 'general').trim() || 'general';
  const sursaTip = String(p.sursaTip || 'flow').trim() || 'flow';
  const directie = String(p.directie || 'iesire').trim() || 'iesire';
  const status   = p.status || null;                 // doar pentru intrate
  const termenZile = Number.isFinite(+p.termenZile) ? +p.termenZile : null;
  if (!pool || !orgId || !sursaId) return null;
```

**2b. INSERT-ul — parametrizează `directie` (azi e literal `'iesire'`) și scrie
coloanele Faza 2.**

old_str:
```javascript
    const ins = await client.query(
      `INSERT INTO registru_intrari
         (org_id, registru, an, numar, numar_format, data_inreg, directie,
          sursa_tip, sursa_id, flow_id, obiect, expeditor, destinatar,
          compartiment, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,'iesire',$7,$8,$9,$10,$11,$12,$13,$14)
       ON CONFLICT (org_id, registru, sursa_tip, sursa_id) DO NOTHING
       RETURNING numar, numar_format, data_inreg, an`,
      [orgId, registru, an, numar, numarFormat, now, sursaTip, sursaId,
       p.flowId || null, String(p.obiect || ''), String(p.expeditor || ''),
       String(p.destinatar || ''), p.compartiment || null,
       p.createdBy || null]
    );
```

new_str:
```javascript
    const termenAt = (termenZile != null)
      ? new Date(now.getTime() + termenZile * 86400000)
      : null;
    const ins = await client.query(
      `INSERT INTO registru_intrari
         (org_id, registru, an, numar, numar_format, data_inreg, directie,
          sursa_tip, sursa_id, flow_id, obiect, expeditor, destinatar,
          compartiment, created_by, status, mod_primire, nr_doc_expeditor,
          data_doc_expeditor, termen_zile, termen_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,
               $16,$17,$18,$19,$20,$21)
       ON CONFLICT (org_id, registru, sursa_tip, sursa_id) DO NOTHING
       RETURNING numar, numar_format, data_inreg, an`,
      [orgId, registru, an, numar, numarFormat, now, directie, sursaTip, sursaId,
       p.flowId || null, String(p.obiect || ''), String(p.expeditor || ''),
       String(p.destinatar || ''), p.compartiment || null,
       p.createdBy || null, status, p.modPrimire || null,
       p.nrDocExpeditor || null, p.dataDocExpeditor || null,
       termenZile, termenAt]
    );
```

> Restul funcției (idempotență, revert pe cursă, COMMIT) rămâne **neatins**.

---

### 3. `server/routes/registratura.mjs` — endpoints Faza 2

**3a. Importuri noi.**

**Verificare context:**
```bash
grep -n "^import\|const router = Router" server/routes/registratura.mjs | head
```

old_str:
```javascript
import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { isModuleEnabled } from '../services/entitlements.mjs';

const router = Router();
```

new_str:
```javascript
import { Router } from 'express';
import { randomUUID } from 'node:crypto';
import { requireAuth } from '../middleware/auth.mjs';
import { csrfMiddleware } from '../middleware/csrf.mjs';
import { pool, writeAuditEvent } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { isModuleEnabled } from '../services/entitlements.mjs';
import { allocateNumber } from '../services/registratura.mjs';

const router = Router();
const _csrf = csrfMiddleware;

// Termene legale implicite per registru (zile calendaristice).
const TERMEN_REGISTRU = { petitii: 30, '544': 10, intrare: null, general: null };

// Tranziții lifecycle valide pentru documente intrate.
const TRANZITII = {
  inregistrat: ['repartizat', 'clasat'],
  repartizat:  ['in_lucru', 'clasat'],
  in_lucru:    ['solutionat', 'clasat'],
  solutionat:  [],
  clasat:      [],
};
```

**3b. Derivare status — extinde `_STATUS_SQL` să acopere și intrările.**

Pentru `directie='iesire'` rămâne logica Faza 1 (din flux). Pentru `directie='intrare'`
folosim `status`-ul stocat, dar dacă există `raspuns_flow_id` și acel flux e
finalizat → `solutionat` (derivat, fără hook).

**Verificare context:**
```bash
grep -n "const _STATUS_SQL = " server/routes/registratura.mjs
```

old_str:
```javascript
const _STATUS_SQL = `
  CASE
    WHEN f.id IS NULL THEN 'inregistrat'
    WHEN (f.data->>'cancelledAt') IS NOT NULL THEN 'anulat'
    WHEN (f.data->>'refusedAt')   IS NOT NULL THEN 'refuzat'
    WHEN (f.data->>'completed')::boolean IS TRUE THEN 'finalizat'
    ELSE 'in_lucru'
  END
`;
```

new_str:
```javascript
// Documente emise (directie='iesire'): status derivat din flux (ca Faza 1).
// Documente intrate (directie='intrare'): status stocat, override 'solutionat'
// dacă fluxul-răspuns legat e finalizat (derivat, fără hook pe lifecycle).
const _STATUS_SQL = `
  CASE
    WHEN r.directie = 'iesire' THEN
      CASE
        WHEN f.id IS NULL THEN 'inregistrat'
        WHEN (f.data->>'cancelledAt') IS NOT NULL THEN 'anulat'
        WHEN (f.data->>'refusedAt')   IS NOT NULL THEN 'refuzat'
        WHEN (f.data->>'completed')::boolean IS TRUE THEN 'finalizat'
        ELSE 'in_lucru'
      END
    ELSE
      CASE
        WHEN fr.id IS NOT NULL
             AND (fr.data->>'completed')::boolean IS TRUE THEN 'solutionat'
        ELSE COALESCE(r.status, 'inregistrat')
      END
  END
`;
```

> ⚠️ Toate query-urile care folosesc `_STATUS_SQL` și fac `LEFT JOIN flows f
> ON f.id = r.flow_id` trebuie să primească și `LEFT JOIN flows fr ON fr.id =
> r.raspuns_flow_id`. Adaugă acest al doilea JOIN în `GET /api/registratura/intrari`
> și în `GET /api/registratura/export.csv` (după JOIN-ul existent pe `f`).

**3c. Extinde `GET /api/registratura/intrari`** — filtru nou `directie`
(`iesire`|`intrare`), elimină filtrul hard-codat `r.registru = 'general'`
(înlocuit cu filtru opțional `registru`), adaugă în SELECT și `r.termen_at`,
`r.mod_primire`, `r.repartizat_la`, `r.status AS status_raw`, `r.raspuns_flow_id`.

old_str:
```javascript
    const where = ['r.org_id = $1', "r.registru = 'general'"];
    const params = [orgId];
    if (an)  { params.push(an);          where.push(`r.an = $${params.length}`); }
```

new_str:
```javascript
    const where = ['r.org_id = $1'];
    const params = [orgId];
    const directie = String(req.query.directie || '').trim();
    const registru = String(req.query.registru || '').trim();
    if (directie) { params.push(directie); where.push(`r.directie = $${params.length}`); }
    if (registru) { params.push(registru); where.push(`r.registru = $${params.length}`); }
    if (an)  { params.push(an);          where.push(`r.an = $${params.length}`); }
```

> În același handler: adaugă `LEFT JOIN flows fr ON fr.id = r.raspuns_flow_id`
> lângă JOIN-ul pe `f`, și include în SELECT + în obiectul de răspuns:
> `termenAt: r.termen_at`, `modPrimire: r.mod_primire`,
> `repartizatLa: r.repartizat_la`, `raspunsFlowId: r.raspuns_flow_id`,
> `registru: r.registru`. Aplică aceeași extindere de JOIN și în `export.csv`.

**3d. POST `/api/registratura/intrari` — înregistrare manuală document intrat.**

Adaugă, **înainte** de `export default router;`:

```javascript
router.post('/api/registratura/intrari', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const can = await isModuleEnabled(pool, {
      moduleKey: 'registratura', userId: actor.id || actor.userId, orgId: actor.orgId,
    });
    if (!can) return res.status(403).json({ error: 'module_disabled' });

    const b = req.body || {};
    const registru = ['intrare', 'petitii', '544'].includes(String(b.registru))
      ? String(b.registru) : 'intrare';
    const obiect = String(b.obiect || '').trim();
    if (!obiect) return res.status(400).json({ error: 'obiect_required' });

    const reg = await allocateNumber({
      orgId: actor.orgId,
      sursaId: randomUUID(),
      sursaTip: 'manual',
      registru,
      directie: 'intrare',
      status: 'inregistrat',
      obiect,
      expeditor: String(b.expeditor || '').trim(),
      compartiment: b.compartiment || null,
      modPrimire: b.modPrimire || null,
      nrDocExpeditor: b.nrDocExpeditor || null,
      dataDocExpeditor: b.dataDocExpeditor || null,
      termenZile: TERMEN_REGISTRU[registru] ?? null,
      createdBy: actor.id || actor.userId || null,
    });
    if (!reg) return res.status(500).json({ error: 'alocare_esuata' });

    await writeAuditEvent({
      orgId: actor.orgId, eventType: 'registratura_intrare_creata',
      actorEmail: actor.email, payload: { registru, numar: reg.numarFormat, obiect },
    }).catch(() => {});
    res.json({ ok: true, numar: reg.numar, numarFormat: reg.numarFormat,
               data: reg.data, an: reg.an, registru });
  } catch (e) {
    logger.error({ err: e }, 'registratura: creare intrare eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari/:id/status', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const next = String((req.body || {}).status || '').trim();
    const cur = await pool.query(
      `SELECT status, directie FROM registru_intrari
        WHERE id=$1 AND org_id=$2 LIMIT 1`, [id, actor.orgId]);
    if (!cur.rows.length) return res.status(404).json({ error: 'not_found' });
    if (cur.rows[0].directie !== 'intrare')
      return res.status(400).json({ error: 'doar_intrari' });
    const from = cur.rows[0].status || 'inregistrat';
    if (!(TRANZITII[from] || []).includes(next))
      return res.status(400).json({ error: 'tranzitie_invalida', from, next });

    const sets = ['status = $1'];
    const vals = [next];
    if (next === 'repartizat') {
      vals.push(String((req.body || {}).repartizatLa || '').trim() || null);
      sets.push(`repartizat_la = $${vals.length}`, `repartizat_at = NOW()`);
    }
    if (next === 'solutionat') sets.push(`solutionat_at = NOW()`);
    if (next === 'clasat')     sets.push(`clasat_at = NOW()`);
    vals.push(id, actor.orgId);
    await pool.query(
      `UPDATE registru_intrari SET ${sets.join(', ')}
        WHERE id=$${vals.length - 1} AND org_id=$${vals.length}`, vals);

    await writeAuditEvent({
      orgId: actor.orgId, eventType: 'registratura_intrare_status',
      actorEmail: actor.email, payload: { id, from, to: next },
    }).catch(() => {});
    res.json({ ok: true, status: next });
  } catch (e) {
    logger.error({ err: e }, 'registratura: schimbare status eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari/:id/leaga-raspuns', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const flowId = String((req.body || {}).flowId || '').trim();
    if (!flowId) return res.status(400).json({ error: 'flowId_required' });
    const fl = await pool.query(
      `SELECT id FROM flows WHERE id=$1 AND org_id=$2 LIMIT 1`,
      [flowId, actor.orgId]);
    if (!fl.rows.length) return res.status(404).json({ error: 'flux_inexistent' });
    const upd = await pool.query(
      `UPDATE registru_intrari SET raspuns_flow_id=$1
        WHERE id=$2 AND org_id=$3 AND directie='intrare'
        RETURNING id`, [flowId, id, actor.orgId]);
    if (!upd.rows.length) return res.status(404).json({ error: 'not_found' });
    await writeAuditEvent({
      orgId: actor.orgId, flowId, eventType: 'registratura_legatura_raspuns',
      actorEmail: actor.email, payload: { intrareId: id, flowId },
    }).catch(() => {});
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'registratura: legare răspuns eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.post('/api/registratura/intrari/:id/atasament', _csrf, async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const b = req.body || {};
    const raw = String(b.fileB64 || '');
    const clean = raw.includes(',') ? raw.split(',')[1] : raw;
    if (!clean) return res.status(400).json({ error: 'file_required' });
    const buf = Buffer.from(clean, 'base64');
    if (buf.length > 15 * 1024 * 1024)
      return res.status(413).json({ error: 'too_large' });
    const own = await pool.query(
      `SELECT id FROM registru_intrari WHERE id=$1 AND org_id=$2 LIMIT 1`,
      [id, actor.orgId]);
    if (!own.rows.length) return res.status(404).json({ error: 'not_found' });
    await pool.query(
      `INSERT INTO registru_atasamente
         (intrare_id, org_id, filename, mime_type, size_bytes, data, uploaded_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7)`,
      [id, actor.orgId, String(b.filename || 'scan.pdf'),
       String(b.mimeType || 'application/pdf'), buf.length, buf,
       actor.id || actor.userId || null]);
    res.json({ ok: true });
  } catch (e) {
    logger.error({ err: e }, 'registratura: upload atașament eșuat');
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/api/registratura/intrari/:id/atasamente', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const id = parseInt(req.params.id, 10);
    const { rows } = await pool.query(
      `SELECT id, filename, mime_type, size_bytes, uploaded_at
         FROM registru_atasamente
        WHERE intrare_id=$1 AND org_id=$2 AND deleted_at IS NULL
        ORDER BY uploaded_at DESC`, [id, actor.orgId]);
    res.json({ items: rows });
  } catch (e) {
    logger.error({ err: e }, 'registratura: listă atașamente eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/api/registratura/atasament/:attId', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const { rows } = await pool.query(
      `SELECT filename, mime_type, data FROM registru_atasamente
        WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL LIMIT 1`,
      [req.params.attId, actor.orgId]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    res.setHeader('Content-Type', rows[0].mime_type || 'application/pdf');
    res.setHeader('Content-Disposition',
      `inline; filename="${encodeURIComponent(rows[0].filename)}"`);
    res.send(rows[0].data);
  } catch (e) {
    logger.error({ err: e }, 'registratura: download atașament eșuat');
    res.status(500).json({ error: 'internal' });
  }
});
```

> Notă: dacă `express.json()` din `index.mjs` are limită de body sub 20MB,
> verifică (`grep -n "express.json(" server/index.mjs`). Atașamentul intră ca
> base64 în JSON; dacă limita e mică, **nu** o schimba global — raportează și
> punem un limit per-rută în Faza 2.1. Pentru acum păstrăm capul de 15MB pe buf.

---

### 4. `public/registratura.html` + `public/js/registratura/main.js` — subtabs Intrări

Inspectează structura `df-subtabs` din `public/admin.html`
(`<div class="df-subtabs" data-subtabs-group="...">` + `<button class="df-subtab"
data-subtab="...">`) și aplică **același** pattern în `registratura.html`:

- Asigură-te că `<script src="/js/df-subtabs.js?v=3.9.480" defer></script>` e inclus.
- Două subtaburi: **Ieșiri** (conține exact tabelul/filtrele Faza 1, mutat sub
  subtabul `iesiri`, neschimbat funcțional) și **Intrări** (`intrari`).
- Subtabul **Intrări**:
  - Buton „➕ Înregistrare intrare" → modal cu: registru (`<select>`: Intrări
    generale / Petiții / Cereri 544), obiect (obligatoriu), expeditor, mod primire
    (`<select>`: ghișeu/poștă/email/fax/altul), nr. document expeditor, dată
    document expeditor, compartiment. Submit → `POST /api/registratura/intrari`.
  - Tabel intrări: Nr. înreg. · Data · Registru · Obiect · Expeditor · Termen
    (roșu dacă `termenAt` în trecut și status ∉ {solutionat,clasat}) · Status (badge).
  - Pe rând: acțiuni status conform `TRANZITII` (Repartizează / În lucru /
    Soluționează / Clasează), „📎 Atașament" (upload PDF → base64 →
    `/atasament`; listă + link download), „🔗 Leagă răspuns" (input flowId →
    `/leaga-raspuns`).
  - Listă: `GET /api/registratura/intrari?directie=intrare&...` (filtre an,
    registru, status, q).
- Gating la load (deja existent din Faza 1): `GET /api/me/can-registratura`.
- `esc()` obligatoriu pe orice câmp afișat. ZERO `localStorage`/`sessionStorage`.
- CSRF: requesturile POST trimit headerul `X-CSRF-Token` (folosește exact
  helperul de fetch CSRF deja folosit în paginile existente — inspectează cum
  fac `notif-widget.js`/paginile curente și oglindește).

JS propriu în `public/js/registratura/main.js` (extindere, nu rescriere a
părții Faza 1). Încărcat cu `?v=3.9.480`.

---

### 5. Bump versiune & cache busting

**5a. `package.json`:**
old_str: `"version": "3.9.479",`
new_str: `"version": "3.9.480",`

**5b. `public/sw.js`:**
old_str: `const CACHE_VERSION = 'docflowai-v195';`
new_str: `const CACHE_VERSION = 'docflowai-v196';`

**5c. Cache busting HTML:**
```bash
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.479/\?v=3.9.480/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII (rulează-le toate, raportează output-ul)

```bash
# 1. Migrarea 075
grep -c "id: '075_registratura_faza2'" server/db/index.mjs        # Așteptat: 1
grep -c "CREATE TABLE IF NOT EXISTS registru_atasamente" server/db/index.mjs  # Așteptat: 1
grep -c "ADD COLUMN IF NOT EXISTS status" server/db/index.mjs     # Așteptat: ≥ 1

# 2. Serviciu — directie parametrizat, calea emise neschimbată semantic
grep -c "const directie = String(p.directie" server/services/registratura.mjs # Așteptat: 1
grep -c "VALUES (\\\$1,\\\$2,\\\$3,\\\$4,\\\$5,\\\$6,'iesire'" server/services/registratura.mjs
# Așteptat: 0 (literalul 'iesire' a fost înlocuit cu \$7)

# 3. Router Faza 2
grep -c "router.post('/api/registratura/intrari'" server/routes/registratura.mjs       # Așteptat: 1
grep -c "/api/registratura/intrari/:id/status" server/routes/registratura.mjs          # Așteptat: 1
grep -c "/api/registratura/intrari/:id/leaga-raspuns" server/routes/registratura.mjs   # Așteptat: 1
grep -c "/api/registratura/intrari/:id/atasament" server/routes/registratura.mjs       # Așteptat: ≥ 1
grep -c "LEFT JOIN flows fr ON fr.id = r.raspuns_flow_id" server/routes/registratura.mjs
# Așteptat: ≥ 2 (intrari + export.csv)

# 4. Frontend
grep -c "df-subtabs.js?v=3.9.480" public/registratura.html        # Așteptat: 1
grep -c 'data-subtab="intrari"' public/registratura.html          # Așteptat: ≥ 1
grep -c 'data-subtab="iesiri"'  public/registratura.html          # Așteptat: ≥ 1

# 5. Versiune + SW + cache busting
grep '"version"' package.json | head -1                            # "version": "3.9.480",
grep "^const CACHE_VERSION" public/sw.js                            # docflowai-v196
grep -rE "\?v=3\.9\.479" public/*.html | wc -l                     # 0

# 6. NO-TOUCH check
for f in cloud-signing.mjs bulk-signing.mjs; do
  git diff develop --name-only | grep -q "server/routes/flows/$f" && echo "FAIL: $f" || echo "OK: $f neatins"
done
git diff develop --name-only | grep -q "server/routes/flows/lifecycle.mjs" && echo "FAIL: lifecycle" || echo "OK: lifecycle neatins"
git diff develop --name-only | grep -q "server/routes/flows/crud.mjs" && echo "FAIL: crud" || echo "OK: crud neatins"
for f in pades.mjs java-pades-client.mjs; do
  git diff develop --name-only | grep -q "server/services/$f" && echo "FAIL: $f" || echo "OK: $f neatins"
done
git diff develop --name-only | grep -q "server/signing/providers/STSCloudProvider.mjs" && echo "FAIL: STSCloud" || echo "OK: STSCloud neatins"
# stampFooterOnPdf în index.mjs: confirmă că NU s-a schimbat funcția
git diff develop -- server/index.mjs | grep -E "^\+|^-" | grep -i "footerRight\|stampFooter\|_regPrefix" | wc -l
# Așteptat: 0 (Faza 2 nu atinge footer-ul)

# 7. Syntax
node --check server/services/registratura.mjs && echo "OK serviciu"
node --check server/routes/registratura.mjs && echo "OK router"
node --check server/index.mjs && echo "OK index"
node --check public/sw.js && echo "OK sw"

# 8. Tests (criticul)
npm test
# Așteptat: verde, fără regresii (count poate crește, nu scădea — Faza 1 era 583)
```

---

## 📊 RAPORT FINAL (completează după execuție)

```
═══════════════════════════════════════════════════════════
RAPORT FINAL — v3.9.480 Registratură Faza 2
═══════════════════════════════════════════════════════════

[ ] Migrarea 075_registratura_faza2 (coloane lifecycle + registru_atasamente)
[ ] registratura.mjs: directie parametrizat, calea emise neschimbată semantic
[ ] routes/registratura.mjs: POST intrare/status/leaga-raspuns/atasament + GET atașamente
[ ] _STATUS_SQL extins (iesire=flux ca Faza 1, intrare=stocat + override răspuns)
[ ] al doilea LEFT JOIN flows fr adăugat în intrari + export.csv
[ ] registratura.html: df-subtabs Ieșiri|Intrări + modal înregistrare + acțiuni
[ ] main.js extins (Faza 1 mutat sub subtab iesiri, neschimbat)
[ ] package.json 3.9.480 + sw.js v196 + cache busting
[ ] VERIFICĂRILE 1–7 rulate, output atașat
[ ] npm test VERDE — output atașat
[ ] git push origin develop

Test count Faza1 / Faza2: 583 / ____
Smoke staging — confirmă manual:
  [ ] Înregistrare intrare în registrul „Petiții" → primește nr., termen = +30 zile
  [ ] Tranziție inregistrat→repartizat→in_lucru→solutionat (în afara ordinii = 400)
  [ ] Atașament PDF scanat upload + download OK
  [ ] Leagă răspuns un flux; finalizează acel flux → intrarea devine 'solutionat' (derivat)
  [ ] Document EMIS (Faza 1): număr/footer/STS — NESCHIMBAT (regresie zero)

Fișiere modificate: ____   Fișiere noi: ____
OBSERVAȚII / DEVIERI: ____
═══════════════════════════════════════════════════════════
```

---

## 🔒 CONSTRÂNGERI ABSOLUTE (recapitulare)

1. **develop only.** Niciun checkout/merge/push pe `main`.
2. NO-TOUCH (vezi secțiunea dedicată). `crud.mjs`, `lifecycle.mjs`,
   `stampFooterOnPdf`, zona STS/PAdES — neatinse.
3. Calea **emise** din `allocateNumber` rămâne semantic identică Faza 1
   (apelul din `crud.mjs` nu se schimbă; default `directie='iesire'`).
4. Legătura intrare↔ieșire = **derivată la citire**, fără hook pe finalizare.
5. Tranzițiile de status validate server-side (`TRANZITII`); UI nu e sursă de adevăr.
6. CSRF pe toate POST-urile noi (`_csrf`).
7. Zero `localStorage`/`sessionStorage`. `esc()` pe tot ce se afișează.
8. `npm test` verde, fără regresii. Niciun test șters/dezactivat.
9. La final, după teste verzi: `git add -A && git commit && git push origin develop`.
```
