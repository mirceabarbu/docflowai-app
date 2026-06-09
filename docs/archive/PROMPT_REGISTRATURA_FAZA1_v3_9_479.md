# DocFlowAI — 📬 v3.9.479: Modul Registratură (Faza 1 — documente emise, registru unic `general`)

```
═══════════════════════════════════════════════════════════
⚠️  BRANCH OBLIGATORIU: develop
⚠️  NU face checkout/merge/push pe main. NICIODATĂ.
⚠️  Producția (main → app.docflowai.ro) o gestionează Mircea manual.
═══════════════════════════════════════════════════════════

DocFlowAI v3.9.478 → v3.9.479 (SW v194 → v195)
Branch: develop
Subiect: feat(registratura): modul Registratură Faza 1 — auto-numerotare documente
         emise + ștampilă în footer + pagină dedicată + Module & permisiuni
```

---

## 🎯 Context — ce construim în Faza 1

Modul **nou, separat**, cu **pagină dedicată** (`/registratura`), care dă **automat
număr de înregistrare** documentelor **emise** prin DocFlowAI (fluxuri de semnare).
Documentele **intrate** (înregistrare manuală, petiții, 544) = **Faza 2**, NU acum.

Principii blocate cu Mircea:

1. **Un singur registru** în Faza 1: `general`. Tipurile separate (`iesire`/`intern`/
   `petitii`/`544`) vin ulterior — schema le permite, dar NU le folosim acum.
2. **Numărul se alocă la CREAREA fluxului**, sincron, exact înainte de
   `stampFooterOnPdf` în `crud.mjs`. Motiv: nu poți tipări pe un PDF semnat
   (invalidează QES) — singura fereastră sigură e la creare, ca footer-ul.
3. **Ștampila în footer = strict aditivă.** `stampFooterOnPdf` capătă un câmp
   opțional; **când lipsește, comportamentul e byte-identic cu azi** (funcția a
   avut regresii STS în trecut — orice schimbare trebuie să fie pur aditivă).
4. **`flowType: 'ancore'`** NU se ștampilează (PDF pre-fielded, intangibil) — primește
   totuși număr, vizibil doar în registru + metadate.
5. **Idempotență**: `UNIQUE(org_id, registru, sursa_tip, sursa_id)` — retry / reinitiate
   NU produce al doilea număr; întoarce numărul deja alocat.
6. **Status în registru = derivat la citire** prin `LEFT JOIN flows` (flux anulat/
   refuzat/finalizat se reflectă automat). **ZERO hook în `lifecycle.mjs`** —
   Faza 1 nu atinge căile de anulare/refuz/semnare.
7. **Modulul apare în „Module & permisiuni"** automat — `INSERT` în `module_catalog`
   (ca `df`/`ord`/`clasa8`); pagina admin entitlements îl listează fără cod nou.

---

## ⛔ ABSOLUTE — NU se ating

1. `server/routes/flows/cloud-signing.mjs`
2. `server/routes/flows/bulk-signing.mjs`
3. `server/services/pades.mjs`
4. `server/services/java-pades-client.mjs`
5. `server/signing/providers/STSCloudProvider.mjs`
6. `server/routes/flows/lifecycle.mjs` — **NU îl atingi.** Status-ul în registru se
   derivă la citire prin JOIN, nu prin hook pe anulare/refuz.
7. Logica de plasare cartuș / signerRects din `stampFooterOnPdf` — **nu o atingi**.
   Singura schimbare permisă în funcție: extinderea liniei `footerRight`.
8. Niciun test existent nu e șters / dezactivat.

---

## 📋 Modificări detaliate

### 1. `server/db/index.mjs` — migrarea `074_registratura` (în array-ul inline `MIGRATIONS`)

**Verificare context curent:**
```bash
grep -n "id: '073_alop_plata_source'" server/db/index.mjs
# Așteptat: o singură ocurență (ultima migrare din array)
grep -n "^];" server/db/index.mjs | head -1
# Așteptat: linia care închide array-ul MIGRATIONS, imediat după 073
```

**Patch:** adaugă obiectul migrării nou ca **ultim element** în array, înainte de `];`
care închide `MIGRATIONS`.

old_str:
```javascript
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_ord_cicluri'
        ) THEN RETURN; END IF;

        ALTER TABLE alop_ord_cicluri
          ADD COLUMN IF NOT EXISTS plata_source TEXT;
      END $g$;
    `
  }
];
```

new_str:
```javascript
      DO $g$ BEGIN
        IF NOT EXISTS (SELECT 1 FROM information_schema.tables
          WHERE table_schema='public' AND table_name='alop_ord_cicluri'
        ) THEN RETURN; END IF;

        ALTER TABLE alop_ord_cicluri
          ADD COLUMN IF NOT EXISTS plata_source TEXT;
      END $g$;
    `
  },
  {
    id: '074_registratura',
    sql: `
      -- Registratură Faza 1: serii de numerotare + intrări registru.
      -- Faza 1 folosește DOAR registru='general', directie='iesire'.
      -- Schema permite extindere (petitii/544/intrare) fără migrare nouă.

      CREATE TABLE IF NOT EXISTS registru_serii (
        org_id     INTEGER     NOT NULL REFERENCES organizations(id),
        registru   TEXT        NOT NULL DEFAULT 'general',
        an         INTEGER     NOT NULL,
        pattern    TEXT        NOT NULL DEFAULT '{nr}/{dd}.{mm}.{yyyy}',
        contor     INTEGER     NOT NULL DEFAULT 0,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        PRIMARY KEY (org_id, registru, an)
      );

      CREATE TABLE IF NOT EXISTS registru_intrari (
        id           BIGSERIAL   PRIMARY KEY,
        org_id       INTEGER     NOT NULL REFERENCES organizations(id),
        registru     TEXT        NOT NULL DEFAULT 'general',
        an           INTEGER     NOT NULL,
        numar        INTEGER     NOT NULL,
        numar_format TEXT        NOT NULL,
        data_inreg   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        directie     TEXT        NOT NULL DEFAULT 'iesire'
                                 CHECK (directie IN ('iesire','intrare','intern')),
        sursa_tip    TEXT        NOT NULL DEFAULT 'flow',
        sursa_id     TEXT        NOT NULL,
        flow_id      TEXT,
        obiect       TEXT        NOT NULL DEFAULT '',
        expeditor    TEXT        NOT NULL DEFAULT '',
        destinatar   TEXT        NOT NULL DEFAULT '',
        compartiment TEXT,
        created_by   INTEGER     REFERENCES users(id),
        meta         JSONB       NOT NULL DEFAULT '{}',
        created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Idempotență: o sursă = o singură poziție per registru per org.
      CREATE UNIQUE INDEX IF NOT EXISTS uq_registru_sursa
        ON registru_intrari (org_id, registru, sursa_tip, sursa_id);
      CREATE INDEX IF NOT EXISTS idx_registru_org_an
        ON registru_intrari (org_id, registru, an, numar DESC);
      CREATE INDEX IF NOT EXISTS idx_registru_flow
        ON registru_intrari (flow_id) WHERE flow_id IS NOT NULL;

      INSERT INTO module_catalog
        (module_key, display_name, category, default_enabled, display_order)
      VALUES
        ('registratura', 'Registratură', 'documente', TRUE, 80)
      ON CONFLICT (module_key) DO NOTHING;
    `
  }
];
```

---

### 2. `server/services/registratura.mjs` — serviciu nou (alocare atomică, idempotentă)

**Fișier NOU.** Conține o singură funcție publică, `allocateNumber`. Alocarea e
atomică (tranzacție + `UPDATE ... RETURNING` pe `registru_serii`) și idempotentă
(`ON CONFLICT DO NOTHING` pe `uq_registru_sursa`; la conflict → întoarce poziția
existentă). NU aruncă — pe eroare logează și întoarce `null` (fluxul NU trebuie
blocat dacă registratura pică; numărul lipsește, atât).

create_file `server/services/registratura.mjs`:
```javascript
/**
 * server/services/registratura.mjs — Registratură Faza 1
 *
 * allocateNumber(): alocă un număr de înregistrare pentru un document EMIS
 * (sursa_tip='flow'). Atomic prin UPDATE ... RETURNING pe registru_serii.
 * Idempotent prin UNIQUE(org_id, registru, sursa_tip, sursa_id):
 *   - prima dată  → alocă, întoarce { numar, numarFormat, data, an }
 *   - retry/reinit → întoarce poziția deja existentă (NU al doilea număr)
 * Nu aruncă: pe orice eroare logează și întoarce null (fluxul nu se blochează).
 */

import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';

function _fmt(pattern, { nr, d }) {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return String(pattern || '{nr}/{dd}.{mm}.{yyyy}')
    .replace('{nr}', String(nr))
    .replace('{dd}', dd)
    .replace('{mm}', mm)
    .replace('{yyyy}', yyyy);
}

/**
 * @param {object} p
 * @param {number} p.orgId        — obligatoriu
 * @param {string} p.sursaId      — obligatoriu (flowId pentru documente emise)
 * @param {string} [p.registru='general']
 * @param {string} [p.sursaTip='flow']
 * @param {string} [p.flowId]
 * @param {string} [p.obiect]
 * @param {string} [p.expeditor]
 * @param {string} [p.destinatar]
 * @param {string} [p.compartiment]
 * @param {number} [p.createdBy]
 * @returns {Promise<{numar:number,numarFormat:string,data:string,an:number}|null>}
 */
export async function allocateNumber(p = {}) {
  const orgId   = Number(p.orgId);
  const sursaId = String(p.sursaId || '').trim();
  const registru = String(p.registru || 'general').trim() || 'general';
  const sursaTip = String(p.sursaTip || 'flow').trim() || 'flow';
  if (!pool || !orgId || !sursaId) return null;

  const now = new Date();
  const an = now.getFullYear();
  let client;
  try {
    client = await pool.connect();
    await client.query('BEGIN');

    // 1. Idempotență: poziția există deja pentru această sursă?
    const exist = await client.query(
      `SELECT numar, numar_format, data_inreg, an
         FROM registru_intrari
        WHERE org_id=$1 AND registru=$2 AND sursa_tip=$3 AND sursa_id=$4
        LIMIT 1`,
      [orgId, registru, sursaTip, sursaId]
    );
    if (exist.rows.length) {
      await client.query('COMMIT');
      const r = exist.rows[0];
      return {
        numar: r.numar,
        numarFormat: r.numar_format,
        data: new Date(r.data_inreg).toISOString(),
        an: r.an,
      };
    }

    // 2. Upsert seria + incrementare atomică a contorului.
    await client.query(
      `INSERT INTO registru_serii (org_id, registru, an)
         VALUES ($1,$2,$3)
       ON CONFLICT (org_id, registru, an) DO NOTHING`,
      [orgId, registru, an]
    );
    const seq = await client.query(
      `UPDATE registru_serii
          SET contor = contor + 1, updated_at = NOW()
        WHERE org_id=$1 AND registru=$2 AND an=$3
        RETURNING contor, pattern`,
      [orgId, registru, an]
    );
    const numar = seq.rows[0].contor;
    const pattern = seq.rows[0].pattern;
    const numarFormat = _fmt(pattern, { nr: numar, d: now });

    // 3. Inserare poziție. ON CONFLICT acoperă cursa cu un retry concurent.
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

    if (!ins.rows.length) {
      // Cursă: alt request a inserat între timp. Rollback contorul nostru
      // (revert increment) și citește poziția câștigătoare.
      await client.query(
        `UPDATE registru_serii SET contor = contor - 1
          WHERE org_id=$1 AND registru=$2 AND an=$3`,
        [orgId, registru, an]
      );
      const win = await client.query(
        `SELECT numar, numar_format, data_inreg, an
           FROM registru_intrari
          WHERE org_id=$1 AND registru=$2 AND sursa_tip=$3 AND sursa_id=$4
          LIMIT 1`,
        [orgId, registru, sursaTip, sursaId]
      );
      await client.query('COMMIT');
      if (!win.rows.length) return null;
      const r = win.rows[0];
      return {
        numar: r.numar,
        numarFormat: r.numar_format,
        data: new Date(r.data_inreg).toISOString(),
        an: r.an,
      };
    }

    await client.query('COMMIT');
    const r = ins.rows[0];
    return {
      numar: r.numar,
      numarFormat: r.numar_format,
      data: new Date(r.data_inreg).toISOString(),
      an: r.an,
    };
  } catch (e) {
    try { if (client) await client.query('ROLLBACK'); } catch {}
    logger.warn({ err: e, orgId, sursaId }, 'registratura: allocateNumber eșuat');
    return null;
  } finally {
    if (client) client.release();
  }
}
```

---

### 3. `server/routes/flows/crud.mjs` — hook alocare la creare flux

Alocarea se face **exact înainte** de apelul `_stampFooterOnPdf`, iar numărul se
pasează atât în obiectul de footer cât și în `data` (persistat). Funcționează și
pentru `ancore` (alocă număr, dar nu ștampilează — `stampFooterOnPdf` oricum
sare peste `ancore`).

**3a. Import serviciu (sus, lângă celelalte importuri din crud.mjs).**

**Verificare context:**
```bash
grep -n "^import\|stampFooterOnPdf" server/routes/flows/crud.mjs | head -8
```

Adaugă, lângă restul importurilor din capul fișierului:

old_str:
```javascript
let _notify, _wsPush, _PDFLib, _stampFooterOnPdf, _isSignerTokenExpired;
```

new_str:
```javascript
import { allocateNumber as _allocateRegNumber } from '../../services/registratura.mjs';
let _notify, _wsPush, _PDFLib, _stampFooterOnPdf, _isSignerTokenExpired;
```

**3b. Alocare + injectare în apelul de footer.**

**Verificare context:**
```bash
grep -n "const _stampResult = await _stampFooterOnPdf" server/routes/flows/crud.mjs
# Așteptat: o singură ocurență
```

old_str:
```javascript
    if (finalPdfB64 && _stampFooterOnPdf && (body.flowType || 'tabel') !== 'ancore') {
      try {
        // b242: stampFooterOnPdf returnează { pdfB64, signerFields }
        // signerFields = [{fieldName, pageIndex}] — câmpurile /Sig pre-create
        const _stampResult = await _stampFooterOnPdf(finalPdfB64, {
          flowId,
          createdAt,
          initName,
          initFunctie,
          institutie: initInstitutie,
          compartiment: initCompartiment,
          flowType: body.flowType || 'tabel',
          signers: normalizedSigners,
          preventRewriteIfSigned: true,
        });
```

new_str:
```javascript
    // Registratură Faza 1: alocă numărul ÎNAINTE de footer (fereastra QES-safe).
    // Idempotent pe (org, general, flow, flowId) → reinitiate nu dublează.
    // Nu blochează fluxul dacă pică (allocateNumber întoarce null).
    let _reg = null;
    try {
      _reg = await _allocateRegNumber({
        orgId,
        sursaId: flowId,
        sursaTip: 'flow',
        flowId,
        obiect: docName || '',
        expeditor: initInstitutie || '',
        compartiment: initCompartiment || null,
      });
    } catch (e) { logger.warn({ err: e, flowId }, 'registratura: alocare la creare eșuată'); }

    if (finalPdfB64 && _stampFooterOnPdf && (body.flowType || 'tabel') !== 'ancore') {
      try {
        // b242: stampFooterOnPdf returnează { pdfB64, signerFields }
        // signerFields = [{fieldName, pageIndex}] — câmpurile /Sig pre-create
        const _stampResult = await _stampFooterOnPdf(finalPdfB64, {
          flowId,
          createdAt,
          initName,
          initFunctie,
          institutie: initInstitutie,
          compartiment: initCompartiment,
          flowType: body.flowType || 'tabel',
          signers: normalizedSigners,
          nrInregistrareFormat: _reg ? _reg.numarFormat : null,
          preventRewriteIfSigned: true,
        });
```

**3c. Persistă numărul în `data` (pentru registru/UI).**

**Verificare context:**
```bash
grep -n "originalPdfB64: preFooterPdfB64," server/routes/flows/crud.mjs
# Așteptat: o singură ocurență, în obiectul `data`
```

old_str:
```javascript
      originalPdfB64: preFooterPdfB64,  // PDF curat (convertit dacă era non-PDF), fără footer — pentru reinitiate
      pdfB64: finalPdfB64,
      signers: normalizedSigners,
```

new_str:
```javascript
      originalPdfB64: preFooterPdfB64,  // PDF curat (convertit dacă era non-PDF), fără footer — pentru reinitiate
      pdfB64: finalPdfB64,
      nrInregistrare:      _reg ? _reg.numarFormat : null,  // Registratură Faza 1
      nrInregistrareData:  _reg ? _reg.data        : null,
      signers: normalizedSigners,
```

---

### 4. `server/index.mjs` — `stampFooterOnPdf` linia `footerRight` (STRICT ADITIV)

Singura schimbare permisă în funcție. Când `nrInregistrareFormat` lipsește,
`footerRight` e **byte-identic** cu azi (prefix = string gol). `rightWidth` se
recalculează din `footerRight`, deci alinierea la dreapta rămâne corectă fără
alt cod. NU se adaugă `drawText` nou, NU se atinge logica de cartuș.

**Verificare context:**
```bash
grep -n "const footerRight = ro(flowData.flowId" server/index.mjs
# Așteptat: o singură ocurență (în stampFooterOnPdf)
```

old_str:
```javascript
    const footerLeft  = createdDate + (parts ? '  |  ' + parts : '');
    const footerRight = ro(flowData.flowId || '') + '  |  DocFlowAI';
```

new_str:
```javascript
    const footerLeft  = createdDate + (parts ? '  |  ' + parts : '');
    // Registratură Faza 1: prefix aditiv. Absent → identic cu comportamentul vechi.
    const _regPrefix  = flowData.nrInregistrareFormat
      ? ro('Nr. inreg. ' + flowData.nrInregistrareFormat) + '  |  '
      : '';
    const footerRight = _regPrefix + ro(flowData.flowId || '') + '  |  DocFlowAI';
```

---

### 5. `server/routes/registratura.mjs` — router NOU (read-only în Faza 1)

Model: `server/routes/opme.mjs` (requireAuth helper-mode, org-scoping pe
`actor.orgId`, gating server-driven). Endpoints:

- `GET /api/registratura/intrari` — listă paginată, org-scoped, status derivat
  prin `LEFT JOIN flows`. Filtre: `an`, `q` (obiect/numar_format), `status`.
- `GET /api/registratura/export.csv` — același filtru, CSV (audit).
- `GET /api/me/can-registratura` — `{ can: bool }` (oglindă `can-import-opme`).

create_file `server/routes/registratura.mjs`:
```javascript
/**
 * server/routes/registratura.mjs — Registratură Faza 1 (read-only)
 *
 * GET /api/registratura/intrari      — listă paginată registru (org-scoped)
 * GET /api/registratura/export.csv   — export CSV (audit)
 * GET /api/me/can-registratura       — gating server-driven { can: bool }
 *
 * Auth: cookie JWT (requireAuth helper-mode). Org isolation pe actor.orgId.
 * Status afișat = derivat la citire din flows (anulat/refuzat/finalizat reflectat
 * automat, fără hook pe lifecycle).
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { pool } from '../db/index.mjs';
import { logger } from '../middleware/logger.mjs';
import { isModuleEnabled } from '../services/entitlements.mjs';

const router = Router();

function _db(res) {
  if (!pool) { res.status(503).json({ error: 'db_unavailable' }); return false; }
  return true;
}

// Status de afișat în registru, derivat din starea curentă a fluxului.
const _STATUS_SQL = `
  CASE
    WHEN f.id IS NULL THEN 'inregistrat'
    WHEN (f.data->>'cancelledAt') IS NOT NULL THEN 'anulat'
    WHEN (f.data->>'refusedAt')   IS NOT NULL THEN 'refuzat'
    WHEN (f.data->>'completed')::boolean IS TRUE THEN 'finalizat'
    ELSE 'in_lucru'
  END
`;

router.get('/api/me/can-registratura', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  try {
    const can = await isModuleEnabled(pool, {
      moduleKey: 'registratura',
      userId: actor.id || actor.userId,
      orgId: actor.orgId,
    });
    res.json({ can: !!can });
  } catch (e) {
    logger.warn({ err: e }, 'can-registratura eșuat');
    res.json({ can: false });
  }
});

router.get('/api/registratura/intrari', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const orgId  = actor.orgId;
    const an     = req.query.an ? parseInt(req.query.an, 10) : null;
    const q      = String(req.query.q || '').trim();
    const status = String(req.query.status || '').trim();
    const page   = Math.max(1, parseInt(req.query.page || '1', 10));
    const limit  = Math.min(100, Math.max(10, parseInt(req.query.limit || '50', 10)));
    const offset = (page - 1) * limit;

    const where = ['r.org_id = $1', "r.registru = 'general'"];
    const params = [orgId];
    if (an)  { params.push(an);          where.push(`r.an = $${params.length}`); }
    if (q)   { params.push(`%${q}%`);    where.push(`(r.obiect ILIKE $${params.length} OR r.numar_format ILIKE $${params.length})`); }

    let statusFilter = '';
    if (status) { params.push(status); statusFilter = `AND (${_STATUS_SQL}) = $${params.length}`; }

    params.push(limit, offset);
    const sql = `
      SELECT r.id, r.numar, r.numar_format, r.data_inreg, r.directie,
             r.obiect, r.expeditor, r.destinatar, r.compartiment, r.flow_id,
             ${_STATUS_SQL} AS status,
             COUNT(*) OVER() AS total_count
        FROM registru_intrari r
        LEFT JOIN flows f ON f.id = r.flow_id
       WHERE ${where.join(' AND ')} ${statusFilter}
       ORDER BY r.an DESC, r.numar DESC
       LIMIT $${params.length - 1} OFFSET $${params.length}`;
    const { rows } = await pool.query(sql, params);
    const total = rows.length ? Number(rows[0].total_count) : 0;
    res.json({
      total, page, limit,
      items: rows.map(r => ({
        id: r.id, numar: r.numar, numarFormat: r.numar_format,
        data: r.data_inreg, directie: r.directie, obiect: r.obiect,
        expeditor: r.expeditor, destinatar: r.destinatar,
        compartiment: r.compartiment, flowId: r.flow_id, status: r.status,
      })),
    });
  } catch (e) {
    logger.error({ err: e }, 'registratura: listare eșuată');
    res.status(500).json({ error: 'internal' });
  }
});

router.get('/api/registratura/export.csv', async (req, res) => {
  const actor = requireAuth(req, res);
  if (!actor) return;
  if (!_db(res)) return;
  try {
    const orgId = actor.orgId;
    const an    = req.query.an ? parseInt(req.query.an, 10) : null;
    const where = ['r.org_id = $1', "r.registru = 'general'"];
    const params = [orgId];
    if (an) { params.push(an); where.push(`r.an = $${params.length}`); }
    const { rows } = await pool.query(`
      SELECT r.numar_format, r.data_inreg, r.directie, r.obiect,
             r.expeditor, r.destinatar, r.compartiment,
             ${_STATUS_SQL} AS status
        FROM registru_intrari r
        LEFT JOIN flows f ON f.id = r.flow_id
       WHERE ${where.join(' AND ')}
       ORDER BY r.an DESC, r.numar DESC`, params);
    const esc = (v) => {
      const s = String(v == null ? '' : v);
      return /[",\n;]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
    };
    const head = ['Nr inregistrare','Data','Directie','Obiect','Expeditor','Destinatar','Compartiment','Status'];
    const lines = [head.join(';')];
    for (const r of rows) {
      lines.push([
        r.numar_format,
        new Date(r.data_inreg).toLocaleString('ro-RO', { timeZone: 'Europe/Bucharest' }),
        r.directie, r.obiect, r.expeditor, r.destinatar, r.compartiment || '', r.status,
      ].map(esc).join(';'));
    }
    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="registru_${an || 'all'}.csv"`);
    res.send('\uFEFF' + lines.join('\n'));
  } catch (e) {
    logger.error({ err: e }, 'registratura: export CSV eșuat');
    res.status(500).json({ error: 'internal' });
  }
});

export default router;
```

---

### 6. `server/index.mjs` — montare router + import

**Verificare context:**
```bash
grep -n "import opmeRouter from './routes/opme.mjs';" server/index.mjs
grep -n "app.use('/', opmeRouter);" server/index.mjs
```

**6a.** Import (lângă `import opmeRouter`):

old_str:
```javascript
import opmeRouter from './routes/opme.mjs';
```

new_str:
```javascript
import opmeRouter from './routes/opme.mjs';
import registraturaRouter from './routes/registratura.mjs';
```

**6b.** Montare (după `app.use('/', opmeRouter);`):

old_str:
```javascript
app.use('/', opmeRouter);             // OPME F1129 import (pachet A — fără matching)
```

new_str:
```javascript
app.use('/', opmeRouter);             // OPME F1129 import (pachet A — fără matching)
app.use('/', registraturaRouter);     // Registratură Faza 1: numerotare documente emise
```

---

### 7. `public/registratura.html` + `public/js/registratura/main.js` — pagină dedicată

Pagina folosește shell-ul standard (`df-utils.js` + `df-shell.js`, încărcate cu
`?v=3.9.479`). Inspectează `public/setari.html` pentru structura exactă de shell
(head, sidebar `.df-nav-group`/`.df-nav-item`, `df-user-menu`) și **oglindește-o
identic** — același container, aceleași clase. Conținutul propriu:

- Titlu pagină „Registratură" + subtitlu „Registrul de intrare-ieșire — documente emise".
- Bară filtre: `<select>` an (ultimii 3 ani), input căutare `q`, `<select>` status
  (toate / înregistrat / în lucru / finalizat / refuzat / anulat), buton „Export CSV".
- Tabel: Nr. înregistrare · Data · Obiect · Expeditor · Compartiment · Status
  (badge colorat — verde finalizat, gri în_lucru/înregistrat, roșu anulat/refuzat).
- Paginare simplă (prev/next, total).
- La load: `GET /api/me/can-registratura`; dacă `{can:false}` → mesaj „Modul
  inactiv pentru organizația ta" + ascunde tabelul (NU redirect dur).
- Fetch listă din `GET /api/registratura/intrari` cu query params; escapare HTML
  obligatorie pe orice câmp (`esc()` din `df-utils.js`).
- Export = `window.location = '/api/registratura/export.csv?...'`.
- ZERO `localStorage`/`sessionStorage`. Stil consistent cu paginile existente
  (`components.css`, prefix `df-`).

JS-ul propriu în `public/js/registratura/main.js`, încărcat cu `?v=3.9.479`.

**Link în sidebar:** în `public/js/df-shell.js`, lângă blocul care injectează
idempotent link-ul „Setări" în `.df-nav-group` (caută `a[href="/setari"]`), adaugă
**același pattern** pentru un link „Registratură" → `/registratura`, idempotent
(`a[href="/registratura"]`), în aceeași secțiune de navigare. Vizibilitatea fină
pe modul rămâne pe Faza 2; în Faza 1 pagina se autoprotejează prin
`can-registratura`. NU schimba altă logică din `df-shell.js`.

---

### 8. Bump versiune & cache busting

**8a. `package.json`** — bump `3.9.478` → `3.9.479`:

old_str: `"version": "3.9.478",`
new_str: `"version": "3.9.479",`

**8b. `public/sw.js`** — bump SW:

old_str: `const CACHE_VERSION = 'docflowai-v194';`
new_str: `const CACHE_VERSION = 'docflowai-v195';`

**8c. Cache busting HTML** (inclusiv noul `registratura.html`):
```bash
find public -maxdepth 1 -name "*.html" -type f -exec \
  sed -i -E 's/\?v=3\.9\.478/\?v=3.9.479/g' {} +
```

---

## ✅ VERIFICĂRI OBLIGATORII (rulează-le toate, raportează output-ul)

```bash
# 1. Migrarea 074 prezentă în array
grep -c "id: '074_registratura'" server/db/index.mjs
# Așteptat: 1
grep -c "CREATE TABLE IF NOT EXISTS registru_intrari" server/db/index.mjs
# Așteptat: 1
grep -c "INSERT INTO module_catalog" server/db/index.mjs | head -1
# Așteptat: ≥ 2 (070 + 074)

# 2. Serviciu nou
test -f server/services/registratura.mjs && echo "OK serviciu" || echo "FAIL"
grep -c "export async function allocateNumber" server/services/registratura.mjs
# Așteptat: 1

# 3. Hook în crud.mjs
grep -c "_allocateRegNumber" server/routes/flows/crud.mjs
# Așteptat: 2 (import + apel)
grep -c "nrInregistrareFormat: _reg" server/routes/flows/crud.mjs
# Așteptat: 1
grep -c "nrInregistrare:      _reg" server/routes/flows/crud.mjs
# Așteptat: 1

# 4. Footer strict aditiv (index.mjs)
grep -c "_regPrefix" server/index.mjs
# Așteptat: 2 (definiție + folosire)
grep -c "const footerRight = _regPrefix + ro(flowData.flowId" server/index.mjs
# Așteptat: 1

# 5. Router montat
test -f server/routes/registratura.mjs && echo "OK router" || echo "FAIL"
grep -c "registraturaRouter" server/index.mjs
# Așteptat: 2 (import + app.use)

# 6. Pagină + JS + sidebar
test -f public/registratura.html && echo "OK html" || echo "FAIL"
test -f public/js/registratura/main.js && echo "OK js" || echo "FAIL"
grep -c 'href="/registratura"' public/js/df-shell.js
# Așteptat: ≥ 1

# 7. Versiune + SW aliniate
grep '"version"' package.json | head -1
# Așteptat: "version": "3.9.479",
grep "^const CACHE_VERSION" public/sw.js
# Așteptat: const CACHE_VERSION = 'docflowai-v195';
grep -rE "\?v=3\.9\.478" public/*.html | wc -l
# Așteptat: 0

# 8. NO-TOUCH check
for f in cloud-signing.mjs bulk-signing.mjs; do
  git diff develop --name-only | grep -q "server/routes/flows/$f" && echo "FAIL: $f modificat" || echo "OK: $f neatins"
done
git diff develop --name-only | grep -q "server/routes/flows/lifecycle.mjs" && echo "FAIL: lifecycle modificat" || echo "OK: lifecycle neatins"
for f in pades.mjs java-pades-client.mjs; do
  git diff develop --name-only | grep -q "server/services/$f" && echo "FAIL: $f modificat" || echo "OK: $f neatins"
done
git diff develop --name-only | grep -q "server/signing/providers/STSCloudProvider.mjs" && echo "FAIL: STSCloud modificat" || echo "OK: STSCloud neatins"

# 9. Syntax check
node --check server/services/registratura.mjs && echo "OK syntax serviciu"
node --check server/routes/registratura.mjs && echo "OK syntax router"
node --check server/routes/flows/crud.mjs && echo "OK syntax crud"
node --check server/index.mjs && echo "OK syntax index"
node --check public/sw.js && echo "OK syntax sw"

# 10. Tests (criticul)
npm test
# Așteptat: verde, fără regresii (numărul de teste poate crește, nu scădea)
```

---

## 📊 RAPORT FINAL (completează după execuție)

```
═══════════════════════════════════════════════════════════
RAPORT FINAL — v3.9.479 Registratură Faza 1
═══════════════════════════════════════════════════════════

[ ] Migrarea 074_registratura adăugată (registru_serii + registru_intrari + module_catalog)
[ ] server/services/registratura.mjs creat — allocateNumber atomic + idempotent
[ ] crud.mjs: alocare la creare + injectare footer + persistare în data
[ ] index.mjs: footerRight strict aditiv (absent → byte-identic cu vechiul)
[ ] server/routes/registratura.mjs creat + montat (intrari + export.csv + can-registratura)
[ ] public/registratura.html + public/js/registratura/main.js create
[ ] df-shell.js: link sidebar „Registratură" (idempotent, pattern Setări)
[ ] package.json 3.9.479 + sw.js v195 + cache busting HTML
[ ] Toate VERIFICĂRILE 1–9 rulate, output atașat
[ ] npm test VERDE, fără regresii — output atașat

Tabele create la startup (confirmă din log migrare): ____
Test count înainte / după: ____ / ____
Fișiere modificate (git diff --name-only): ____
Fișiere noi: ____

OBSERVAȚII / DEVIERI: ____
═══════════════════════════════════════════════════════════
```

---

## 🔒 CONSTRÂNGERI ABSOLUTE (recapitulare la final)

1. **develop only.** Niciun checkout/merge/push pe `main`.
2. NO-TOUCH: `cloud-signing.mjs`, `bulk-signing.mjs`, `pades.mjs`,
   `java-pades-client.mjs`, `STSCloudProvider.mjs`, `lifecycle.mjs`.
3. `stampFooterOnPdf`: **doar** linia `footerRight` se extinde, strict aditiv.
   Logica de cartuș / signerRects / placement rămâne intactă. Flux fără
   registratură ⇒ footer byte-identic cu azi.
4. `allocateNumber` **nu aruncă niciodată** — pe eroare întoarce `null`, fluxul
   se creează oricum (doar fără număr).
5. Idempotență obligatorie: reinitiate / retry pe același `flowId` ⇒ același număr.
6. Zero `localStorage`/`sessionStorage` în frontend.
7. `npm test` verde, fără regresii. Niciun test șters/dezactivat.
8. La final, după teste verzi: `git add -A && git commit && git push origin develop`.
```
