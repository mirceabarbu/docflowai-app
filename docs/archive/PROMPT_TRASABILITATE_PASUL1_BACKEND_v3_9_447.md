# DocFlowAI — 🔗 TRASABILITATE (PASUL 1: Backend + Endpoint + Teste) v3.9.447

> **PASUL 1 din 2** — backend pentru modal Trasabilitate (UI vine în PASUL 2 v3.9.448).
> **Pre-requisite:** v3.9.446 (substring search Cod SSI) deployat. Dacă ai sărit peste 446, bumpul e v3.9.445 → v3.9.447 (nu blochează — sunt independente).

```
DocFlowAI v3.9.446 → v3.9.447 (SW v162 → v163)
Branch: develop
Subiect: feat(trasabilitate): backend agregator arbore DF↔ALOP↔ORD (PASUL 1 din 2)

═══════════════════════════════════════════════════════════
CONTEXT
═══════════════════════════════════════════════════════════

Lista DF/ORD are doar 7 coloane (Nr/Titlu, Inițiator, CAB, Status, Creat,
Actualizat, Acțiuni). Imposibil de văzut, pentru un DF dat:
  - Pe ce ALOP a fost folosit
  - Care ORD-uri au fost generate (poate fi 5+ prin cicluri)
  - Status fiecăruia + suma plătită

Și invers, pentru un ORD dat:
  - Care DF i-a stat la bază (cu reviziile sale)
  - Pe ce ALOP a fost generat
  - Dacă e ORD curent sau dintr-un ciclu arhivat („noua lichidare")

PASUL 1 livrează endpoint-ul `/api/trasabilitate/:type/:id` care întoarce
arborele complet, gata pentru renderare în modal (PASUL 2).

DECIZII LUATE ÎMPREUNĂ:
  - Tip livrare: buton 🔗 + modal cu arbore complet (Opțiunea C, scalează 5+ ORD)
  - Identificator ALOP: titlu integral (font mai mic în UI, wrap pe 2 rânduri)
  - Cicluri: separat ORD curent activ vs ORD-uri arhivate (cicluri închise)
  - Datele tipice: 5+ ORD-uri/DF (audit cu istoric lung) → modal e singura opțiune scalabilă

ARHITECTURĂ DATE:
  - 1 DF (nr_unic_inreg) → N revizii (R0, R1, R2... în formulare_df)
  - 1 DF nr_unic_inreg → 0..M ALOP-uri (alop_instances.df_id, fără UNIQUE)
  - 1 ALOP → 1 ORD curent (alop_instances.ord_id, NULLable)
  - 1 ALOP → 0..N cicluri arhivate (alop_ord_cicluri, fiecare cu propriul ord_id)
  - 1 ORD → 1 DF parent (formulare_ord.df_id)
  - 1 ORD poate fi: ord curent al unui ALOP, SAU dintr-un ciclu arhivat

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs / bulk-signing.mjs
- server/signing/pades.mjs / java-pades-client.mjs
- server/middleware/auth.mjs (dual-mode din v3.9.442)
- server/services/clasa8.mjs / server/routes/clasa8.mjs (Clasa 8 OK din v3.9.445)
- TOATE fișierele frontend (PASUL 2 atinge UI-ul)

═══════════════════════════════════════════════════════════
PASUL 1.1 — Service module: server/services/trasabilitate.mjs (FIȘIER NOU)
═══════════════════════════════════════════════════════════

Creează server/services/trasabilitate.mjs cu următorul conținut EXACT:

/**
 * server/services/trasabilitate.mjs
 *
 * Agregator pentru arborele de trasabilitate DF ↔ ALOP ↔ ORD.
 * Folosit de modal-ul „Trasabilitate" deschis din lista DF sau ORD.
 *
 * Read-only. Nu scrie nimic în BD.
 *
 * Strategia: 4 query-uri secvențiale (citibile + testabile) — mai bine
 * decât un mega-CTE pentru un endpoint apelat rar (la click utilizator).
 *
 * Multi-tenant: orgId e filtru obligatoriu pe TOATE query-urile.
 *
 * Identificare „aprobat" (pattern canonic, vezi formulare-db.mjs):
 *   flow_id IS NOT NULL
 *   AND (f.data->>'status' = 'completed'
 *        OR (f.data->>'completed')::boolean = true)
 */

/**
 * Returnează arborele de trasabilitate pornind de la un DF sau ORD.
 *
 * @param {object}  pool   - PostgreSQL pool
 * @param {number}  orgId  - ID organizație (multi-tenant gate)
 * @param {string}  type   - 'df' | 'ord'
 * @param {string}  id     - UUID-ul DF-ului sau ORD-ului root
 * @returns {Promise<object|null>} - obiectul cu arborele, sau null dacă root nu există
 */
export async function getTrasabilitate(pool, orgId, type, id) {
  if (!pool || !orgId) {
    throw new Error('trasabilitate.getTrasabilitate: pool și orgId sunt obligatorii');
  }
  if (type !== 'df' && type !== 'ord') {
    throw new Error(`trasabilitate.getTrasabilitate: type invalid '${type}', acceptate: 'df' | 'ord'`);
  }

  // ── Q1: Validare root + extracție context (nr_unic_inreg DF) ──────────────
  let dfNrUnic = null;
  let dfRootId = null;     // doar pentru type='ord': id-ul DF-ului direct legat
  let rootIsOrd = type === 'ord';

  if (type === 'df') {
    const { rows } = await pool.query(
      `SELECT id, nr_unic_inreg
         FROM formulare_df
        WHERE id = $1 AND org_id = $2 AND deleted_at IS NULL`,
      [id, orgId]
    );
    if (!rows.length) return null;
    dfNrUnic = rows[0].nr_unic_inreg;
  } else { // ord
    const { rows } = await pool.query(
      `SELECT fo.id, fo.df_id,
              fd.nr_unic_inreg AS df_nr_unic_inreg
         FROM formulare_ord fo
         LEFT JOIN formulare_df fd ON fd.id = fo.df_id AND fd.org_id = $2
        WHERE fo.id = $1 AND fo.org_id = $2 AND fo.deleted_at IS NULL`,
      [id, orgId]
    );
    if (!rows.length) return null;
    dfNrUnic = rows[0].df_nr_unic_inreg; // poate fi null dacă ORD-ul nu are df_id
    dfRootId = rows[0].df_id;
  }

  // ── Q2: Toate reviziile DF (dacă există nr_unic_inreg) ────────────────────
  let dfRevizii = [];
  if (dfNrUnic) {
    const { rows } = await pool.query(
      `SELECT fd.id, fd.nr_unic_inreg, fd.subtitlu_df AS titlu,
              COALESCE(fd.revizie_nr, 0) AS revizie_nr,
              COALESCE(fd.este_revizie, FALSE) AS este_revizie,
              fd.status, fd.flow_id, fd.created_at, fd.updated_at,
              CASE WHEN fd.flow_id IS NOT NULL
                   AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
                   THEN TRUE ELSE FALSE END AS aprobat
         FROM formulare_df fd
         LEFT JOIN flows f ON f.id::text = fd.flow_id
        WHERE fd.nr_unic_inreg = $1
          AND fd.org_id = $2
          AND fd.deleted_at IS NULL
        ORDER BY fd.revizie_nr ASC NULLS FIRST`,
      [dfNrUnic, orgId]
    );
    dfRevizii = rows.map(r => ({
      id:               r.id,
      nr_unic_inreg:    r.nr_unic_inreg,
      titlu:            r.titlu || '',
      revizie_nr:       Number(r.revizie_nr),
      este_revizie:     r.este_revizie,
      status:           r.status,
      aprobat:          r.aprobat,
      created_at:       r.created_at,
      updated_at:       r.updated_at,
      is_root_df:       type === 'df'  && r.id === id,
      is_root_df_link:  type === 'ord' && r.id === dfRootId,
    }));
  }

  // ── Q3: ALOP-uri + ORD curent ─────────────────────────────────────────────
  // Pentru type='df': toate ALOP-urile cu df_id IN (reviziile DF)
  // Pentru type='ord': ALOP-ul/-urile care conțin acest ORD (curent SAU ciclu arhivat)
  let alopuriRows = [];
  if (type === 'df' && dfRevizii.length) {
    const dfIds = dfRevizii.map(r => r.id);
    const { rows } = await pool.query(
      `SELECT
         a.id, a.titlu, a.status, a.valoare_totala, a.suma_totala_platita,
         a.ciclu_curent, a.df_id, a.ord_id,
         a.lichidare_confirmed_at, a.lichidare_nr_factura, a.lichidare_nr_pv,
         a.plata_confirmed_at, a.plata_nr_ordin, a.plata_suma_efectiva,
         a.created_at, a.completed_at, a.cancelled_at, a.cancelled_reason,
         foc.nr_unic_inreg AS ord_curent_nr_unic_inreg,
         foc.beneficiar    AS ord_curent_titlu,
         foc.status        AS ord_curent_status,
         foc.flow_id       AS ord_curent_flow_id,
         CASE WHEN foc.flow_id IS NOT NULL
              AND (foc_f.data->>'status' = 'completed' OR (foc_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_curent_aprobat
       FROM alop_instances a
       LEFT JOIN formulare_ord foc ON foc.id = a.ord_id AND foc.org_id = $1
       LEFT JOIN flows        foc_f ON foc_f.id::text = foc.flow_id
       WHERE a.org_id = $1
         AND a.df_id = ANY($2::uuid[])
       ORDER BY a.created_at ASC`,
      [orgId, dfIds]
    );
    alopuriRows = rows;
  } else if (type === 'ord') {
    const { rows } = await pool.query(
      `SELECT
         a.id, a.titlu, a.status, a.valoare_totala, a.suma_totala_platita,
         a.ciclu_curent, a.df_id, a.ord_id,
         a.lichidare_confirmed_at, a.lichidare_nr_factura, a.lichidare_nr_pv,
         a.plata_confirmed_at, a.plata_nr_ordin, a.plata_suma_efectiva,
         a.created_at, a.completed_at, a.cancelled_at, a.cancelled_reason,
         foc.nr_unic_inreg AS ord_curent_nr_unic_inreg,
         foc.beneficiar    AS ord_curent_titlu,
         foc.status        AS ord_curent_status,
         foc.flow_id       AS ord_curent_flow_id,
         CASE WHEN foc.flow_id IS NOT NULL
              AND (foc_f.data->>'status' = 'completed' OR (foc_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_curent_aprobat
       FROM alop_instances a
       LEFT JOIN formulare_ord foc ON foc.id = a.ord_id AND foc.org_id = $1
       LEFT JOIN flows        foc_f ON foc_f.id::text = foc.flow_id
       WHERE a.org_id = $1
         AND (a.ord_id = $2
              OR a.id IN (SELECT alop_id FROM alop_ord_cicluri
                          WHERE ord_id = $2 AND org_id = $1))
       ORDER BY a.created_at ASC`,
      [orgId, id]
    );
    alopuriRows = rows;
  }

  // ── Q4: Cicluri arhivate per ALOP ─────────────────────────────────────────
  let cicluriPerAlop = {};
  if (alopuriRows.length) {
    const alopIds = alopuriRows.map(a => a.id);
    const { rows } = await pool.query(
      `SELECT
         c.id, c.alop_id, c.ciclu_nr, c.ord_id, c.status,
         c.lichidare_confirmed_at, c.lichidare_nr_factura, c.lichidare_data_factura,
         c.lichidare_nr_pv, c.lichidare_data_pv, c.lichidare_notes,
         c.plata_confirmed_at, c.plata_nr_ordin, c.plata_data,
         c.plata_suma_efectiva, c.plata_observatii,
         fo.nr_unic_inreg AS ord_nr_unic_inreg,
         fo.beneficiar    AS ord_titlu,
         fo.status        AS ord_status,
         fo.flow_id       AS ord_flow_id,
         CASE WHEN fo.flow_id IS NOT NULL
              AND (fo_f.data->>'status' = 'completed' OR (fo_f.data->>'completed')::boolean = true)
              THEN TRUE ELSE FALSE END AS ord_aprobat
       FROM alop_ord_cicluri c
       LEFT JOIN formulare_ord fo ON fo.id = c.ord_id AND fo.org_id = $1
       LEFT JOIN flows fo_f ON fo_f.id::text = fo.flow_id
       WHERE c.org_id = $1
         AND c.alop_id = ANY($2::uuid[])
       ORDER BY c.alop_id, c.ciclu_nr ASC`,
      [orgId, alopIds]
    );
    rows.forEach(c => {
      if (!cicluriPerAlop[c.alop_id]) cicluriPerAlop[c.alop_id] = [];
      cicluriPerAlop[c.alop_id].push({
        id:                 c.id,
        ciclu_nr:           Number(c.ciclu_nr),
        ord_id:             c.ord_id,
        ord_nr_unic_inreg:  c.ord_nr_unic_inreg,
        ord_titlu:          c.ord_titlu || '',
        ord_status:         c.ord_status,
        ord_aprobat:        c.ord_aprobat,
        is_root_ord:        rootIsOrd && c.ord_id === id,
        status:             c.status,
        lichidare_confirmed_at: c.lichidare_confirmed_at,
        lichidare_nr_factura:   c.lichidare_nr_factura,
        lichidare_data_factura: c.lichidare_data_factura,
        lichidare_nr_pv:    c.lichidare_nr_pv,
        lichidare_data_pv:  c.lichidare_data_pv,
        lichidare_notes:    c.lichidare_notes,
        plata_confirmed_at: c.plata_confirmed_at,
        plata_nr_ordin:     c.plata_nr_ordin,
        plata_data:         c.plata_data,
        plata_suma_efectiva: c.plata_suma_efectiva !== null
                              ? Number(c.plata_suma_efectiva) : null,
        plata_observatii:   c.plata_observatii,
      });
    });
  }

  // ── Asamblare răspuns ─────────────────────────────────────────────────────
  const alopuri = alopuriRows.map(a => ({
    id:                  a.id,
    titlu:               a.titlu || '',
    status:              a.status,
    valoare_totala:      a.valoare_totala !== null ? Number(a.valoare_totala) : null,
    suma_totala_platita: a.suma_totala_platita !== null ? Number(a.suma_totala_platita) : null,
    ciclu_curent:        a.ciclu_curent !== null ? Number(a.ciclu_curent) : 1,
    df_id:               a.df_id,
    created_at:          a.created_at,
    completed_at:        a.completed_at,
    cancelled_at:        a.cancelled_at,
    cancelled_reason:    a.cancelled_reason,

    ord_curent: a.ord_id ? {
      id:                  a.ord_id,
      nr_unic_inreg:       a.ord_curent_nr_unic_inreg,
      titlu:               a.ord_curent_titlu || '',
      status:              a.ord_curent_status,
      aprobat:             !!a.ord_curent_aprobat,
      ciclu_nr:            a.ciclu_curent !== null ? Number(a.ciclu_curent) : 1,
      is_root_ord:         rootIsOrd && a.ord_id === id,
      lichidare_confirmed_at: a.lichidare_confirmed_at,
      lichidare_nr_factura:   a.lichidare_nr_factura,
      lichidare_nr_pv:        a.lichidare_nr_pv,
      plata_confirmed_at:     a.plata_confirmed_at,
      plata_nr_ordin:         a.plata_nr_ordin,
      plata_suma_efectiva:    a.plata_suma_efectiva !== null ? Number(a.plata_suma_efectiva) : null,
    } : null,

    cicluri_arhivate: cicluriPerAlop[a.id] || [],
  }));

  return {
    ok:        true,
    root_type: type,
    root_id:   id,
    df_revizii: dfRevizii,
    alopuri,
  };
}

═══════════════════════════════════════════════════════════
PASUL 1.2 — Route module: server/routes/trasabilitate.mjs (FIȘIER NOU)
═══════════════════════════════════════════════════════════

Creează server/routes/trasabilitate.mjs cu următorul conținut EXACT:

/**
 * server/routes/trasabilitate.mjs
 * Endpoint pentru arborele de trasabilitate DF ↔ ALOP ↔ ORD.
 * Mount: app.use('/api/trasabilitate', trasabilitateRouter)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { logger }      from '../middleware/logger.mjs';
import { pool }        from '../db/index.mjs';
import { getTrasabilitate } from '../services/trasabilitate.mjs';

const router = Router();

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// GET /api/trasabilitate/:type/:id
router.get('/:type/:id', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const { type, id } = req.params;
    if (type !== 'df' && type !== 'ord') {
      return res.status(400).json({ error: 'invalid_type', message: 'type trebuie să fie df sau ord' });
    }
    if (!UUID_REGEX.test(id)) {
      return res.status(400).json({ error: 'invalid_id', message: 'id trebuie să fie UUID valid' });
    }

    const result = await getTrasabilitate(pool, orgId, type, id);
    if (!result) return res.status(404).json({ error: 'not_found' });
    return res.json(result);
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'trasabilitate aggregate error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;

═══════════════════════════════════════════════════════════
PASUL 1.3 — Mount în server/index.mjs
═══════════════════════════════════════════════════════════

3.1 — Adaugă import (lângă celelalte router imports, ~linia 522):

old_str:
import clasa8Router            from './routes/clasa8.mjs';

new_str:
import clasa8Router            from './routes/clasa8.mjs';
import trasabilitateRouter     from './routes/trasabilitate.mjs';

3.2 — Adaugă mount după montarea clasa8Router (~linia 1758):

old_str:
app.use('/api/clasa8',             clasa8Router);             // Centralizator Clasa 8 (read-only)

new_str:
app.use('/api/clasa8',             clasa8Router);             // Centralizator Clasa 8 (read-only)
app.use('/api/trasabilitate',      trasabilitateRouter);      // Arbore trasabilitate DF↔ALOP↔ORD

═══════════════════════════════════════════════════════════
PASUL 1.4 — Adaugă fișierele noi în npm run check
═══════════════════════════════════════════════════════════

În package.json, în scriptul "check":

  Caută: `node --check server/services/clasa8.mjs && `
  Imediat DUPĂ adaugă: `node --check server/services/trasabilitate.mjs && `

  Caută: `node --check server/routes/clasa8.mjs && `
  Imediat DUPĂ adaugă: `node --check server/routes/trasabilitate.mjs && `

Verifică sintactic cu: npm run check

═══════════════════════════════════════════════════════════
PASUL 1.5 — Teste integration: server/tests/integration/trasabilitate.test.mjs (NOU)
═══════════════════════════════════════════════════════════

Creează server/tests/integration/trasabilitate.test.mjs cu următorul conținut:

/**
 * Integration tests — Trasabilitate (arbore DF↔ALOP↔ORD)
 *
 * Acoperire:
 *   ✓ 401 fără autentificare
 *   ✓ 400 type invalid
 *   ✓ 400 id non-UUID
 *   ✓ 404 root nu există
 *   ✓ 200 DF root cu reviziile + ALOP-uri + cicluri arhivate
 *   ✓ 200 ORD root cu DF parent + ALOP + cicluri
 *   ✓ 500 când BD aruncă eroare
 *   ✓ Multi-tenant: orgId din JWT propagat în query ($1)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return { pool: { query: mockQuery } };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule         from '../../db/index.mjs';
import trasabilitateRouter   from '../../routes/trasabilitate.mjs';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';
const VALID_UUID  = '550e8400-e29b-41d4-a716-446655440000';
const VALID_UUID2 = '550e8400-e29b-41d4-a716-446655440001';

function makeToken(overrides = {}) {
  return jwt.sign(
    { userId: 1, email: 'init@primaria.ro', role: 'user', orgId: 1, nume: 'Test', ...overrides },
    TEST_JWT_SECRET,
    { expiresIn: '2h' }
  );
}

function makeApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use((req, _res, next) => { req.requestId = 'test-req'; next(); });
  app.use('/api/trasabilitate', trasabilitateRouter);
  return app;
}

describe('GET /api/trasabilitate/:type/:id', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const app = makeApp();
    const r = await request(app).get(`/api/trasabilitate/df/${VALID_UUID}`);
    expect(r.status).toBe(401);
  });

  it('400 type invalid (alt cuvânt decât df/ord)', async () => {
    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/foo/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_type');
  });

  it('400 id non-UUID', async () => {
    const app = makeApp();
    const r = await request(app)
      .get('/api/trasabilitate/df/not-a-uuid')
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('invalid_id');
  });

  it('404 când root DF nu există în BD', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(404);
    expect(r.body.error).toBe('not_found');
  });

  it('200 DF root cu 2 revizii, 1 ALOP cu 1 ciclu arhivat + ORD curent', async () => {
    // Q1 — root DF + nr_unic_inreg
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: VALID_UUID, nr_unic_inreg: 'DF-2025-00125' }]
    });
    // Q2 — toate reviziile DF (R0 + R1)
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        { id: VALID_UUID, nr_unic_inreg: 'DF-2025-00125', titlu: 'DF Mobilier',
          revizie_nr: 0, este_revizie: false, status: 'completed', flow_id: 'flow-r0',
          aprobat: true, created_at: '2025-12-01', updated_at: '2025-12-05' },
        { id: VALID_UUID2, nr_unic_inreg: 'DF-2025-00125', titlu: 'DF Mobilier',
          revizie_nr: 1, este_revizie: true, status: 'completed', flow_id: 'flow-r1',
          aprobat: true, created_at: '2026-02-01', updated_at: '2026-02-08' },
      ]
    });
    // Q3 — 1 ALOP cu ord_id (curent)
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'alop-uuid-1', titlu: 'Achiziție mobilier Q1 2026',
        status: 'completed', valoare_totala: '50000.00', suma_totala_platita: '30000.00',
        ciclu_curent: 2, df_id: VALID_UUID2, ord_id: 'ord-curent-uuid',
        lichidare_confirmed_at: '2026-04-10', lichidare_nr_factura: 'F-22',
        lichidare_nr_pv: 'PV-15',
        plata_confirmed_at: null, plata_nr_ordin: null, plata_suma_efectiva: null,
        created_at: '2026-02-10', completed_at: null, cancelled_at: null,
        cancelled_reason: null,
        ord_curent_nr_unic_inreg: 'ORD-2026-042', ord_curent_titlu: 'Mobilex SRL',
        ord_curent_status: 'completed', ord_curent_flow_id: 'ord-flow', ord_curent_aprobat: true,
      }]
    });
    // Q4 — 1 ciclu arhivat
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'ciclu-uuid-1', alop_id: 'alop-uuid-1', ciclu_nr: 1,
        ord_id: 'ord-arhivat-uuid', status: 'completed',
        lichidare_confirmed_at: '2026-03-05', lichidare_nr_factura: 'F-12',
        lichidare_data_factura: '2026-03-04', lichidare_nr_pv: 'PV-08',
        lichidare_data_pv: '2026-03-04', lichidare_notes: null,
        plata_confirmed_at: '2026-03-15', plata_nr_ordin: 'OP-321',
        plata_data: '2026-03-15', plata_suma_efectiva: '15000.00',
        plata_observatii: null,
        ord_nr_unic_inreg: 'ORD-2026-001', ord_titlu: 'Mobilex SRL',
        ord_status: 'completed', ord_flow_id: 'ord-arh-flow', ord_aprobat: true,
      }]
    });

    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(r.status).toBe(200);
    expect(r.body.root_type).toBe('df');
    expect(r.body.root_id).toBe(VALID_UUID);
    expect(r.body.df_revizii).toHaveLength(2);
    expect(r.body.df_revizii[0].is_root_df).toBe(true);  // R0 e root
    expect(r.body.df_revizii[1].is_root_df).toBe(false); // R1 NU e root
    expect(r.body.alopuri).toHaveLength(1);
    expect(r.body.alopuri[0].titlu).toBe('Achiziție mobilier Q1 2026');
    expect(r.body.alopuri[0].valoare_totala).toBe(50000); // Number, not string
    expect(r.body.alopuri[0].ord_curent).not.toBeNull();
    expect(r.body.alopuri[0].ord_curent.nr_unic_inreg).toBe('ORD-2026-042');
    expect(r.body.alopuri[0].cicluri_arhivate).toHaveLength(1);
    expect(r.body.alopuri[0].cicluri_arhivate[0].ord_nr_unic_inreg).toBe('ORD-2026-001');
    expect(r.body.alopuri[0].cicluri_arhivate[0].plata_suma_efectiva).toBe(15000);
  });

  it('200 ORD root: marchează corect is_root_ord pe ciclul/ord-ul curent corect', async () => {
    const ORD_ROOT = VALID_UUID;
    // Q1 — root ORD + df_id parent
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: ORD_ROOT, df_id: 'df-uuid', df_nr_unic_inreg: 'DF-2025-00125' }]
    });
    // Q2 — 1 revizie DF
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{ id: 'df-uuid', nr_unic_inreg: 'DF-2025-00125', titlu: 'DF',
               revizie_nr: 0, este_revizie: false, status: 'completed',
               flow_id: 'fl', aprobat: true,
               created_at: '2025-12-01', updated_at: '2025-12-05' }]
    });
    // Q3 — 1 ALOP cu ord_id = ORD root (deci is_root_ord pe ord_curent)
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'alop-1', titlu: 'A', status: 'in_progress',
        valoare_totala: null, suma_totala_platita: null, ciclu_curent: 1,
        df_id: 'df-uuid', ord_id: ORD_ROOT,
        lichidare_confirmed_at: null, lichidare_nr_factura: null, lichidare_nr_pv: null,
        plata_confirmed_at: null, plata_nr_ordin: null, plata_suma_efectiva: null,
        created_at: '2026-02-10', completed_at: null, cancelled_at: null,
        cancelled_reason: null,
        ord_curent_nr_unic_inreg: 'ORD-CUR', ord_curent_titlu: 'Furniz X',
        ord_curent_status: 'draft', ord_curent_flow_id: null, ord_curent_aprobat: false,
      }]
    });
    // Q4 — niciun ciclu arhivat
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });

    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/ord/${ORD_ROOT}`)
      .set('Cookie', `auth_token=${makeToken()}`);

    expect(r.status).toBe(200);
    expect(r.body.root_type).toBe('ord');
    expect(r.body.df_revizii[0].is_root_df).toBe(false);
    expect(r.body.df_revizii[0].is_root_df_link).toBe(true); // DF e legat la ORD root
    expect(r.body.alopuri[0].ord_curent.is_root_ord).toBe(true); // ORD root = ord curent
    expect(r.body.alopuri[0].cicluri_arhivate).toHaveLength(0);
  });

  it('multi-tenant: orgId din JWT propagat ca $1 în Q1', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken({ orgId: 42 })}`);
    const callArgs = dbModule.pool.query.mock.calls[0];
    // Q1 pentru DF: SELECT ... FROM formulare_df WHERE id=$1 AND org_id=$2
    expect(callArgs[1]).toEqual([VALID_UUID, 42]);
  });

  it('500 când BD aruncă eroare', async () => {
    dbModule.pool.query.mockRejectedValueOnce(new Error('db down'));
    const app = makeApp();
    const r = await request(app)
      .get(`/api/trasabilitate/df/${VALID_UUID}`)
      .set('Cookie', `auth_token=${makeToken()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('server_error');
  });
});

═══════════════════════════════════════════════════════════
PASUL 1.6 — Cache busting (3.9.446 → 3.9.447, SW v162 → v163)
═══════════════════════════════════════════════════════════

6.1 — package.json:
  old_str:   "version": "3.9.446",
  new_str:   "version": "3.9.447",

  NOTĂ: dacă ai sărit peste v3.9.446, înlocuiește cu versiunea actuală
  curentă (probabil 3.9.445).

6.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v162';
  new_str: const CACHE_VERSION = 'docflowai-v163';

  NOTĂ: dacă SW e încă pe v161 (n-ai rulat 446), înlocuiește cu v161 → v163.

6.3 — NU bumpăm referințele HTML încă. Sunt valide până la PASUL 2 (v3.9.448),
       când adăugăm UI-ul + buton 🔗 + modal trasabilitate.

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Service module sintactic OK:
   node --check server/services/trasabilitate.mjs

2. Route module sintactic OK:
   node --check server/routes/trasabilitate.mjs

3. Service e importat în route:
   grep "from '../services/trasabilitate.mjs'" server/routes/trasabilitate.mjs
   → 1 linie

4. Router montat în index.mjs:
   grep -c "trasabilitateRouter\|/api/trasabilitate" server/index.mjs
   → ≥ 3 (import + mount + comentariu)

5. Pattern „aprobat" canonic folosit:
   grep -cE "f\.data->>'status'\s*=\s*'completed'" server/services/trasabilitate.mjs
   → ≥ 4 (DF revizii + ord curent + ord arhivat + alop ord)

6. Multi-tenant gate pe org_id în toate query-urile:
   grep -c "AND.*org_id\s*=\s*\$" server/services/trasabilitate.mjs
   → ≥ 6 (Q1 DF + Q1 ORD + Q2 + Q3-DF + Q3-ORD + Q4)

7. Validare type ∈ {df, ord} și UUID:
   grep -c "invalid_type\|invalid_id" server/routes/trasabilitate.mjs
   → 2

8. npm run check pasează (toate 50+ fișiere syntactic OK)

9. npm test verde: 371 + 8 noi = 379/379 (sau mai mult dacă ai rulat 446)

10. Server pornește fără erori:
    JWT_SECRET=test-jwt-secret-vitest-docflowai-2025 PORT=9999 node server/index.mjs &
    sleep 3
    curl -s http://localhost:9999/healthz | head -1
    kill %1 2>/dev/null

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/services/trasabilitate.mjs \
        server/routes/trasabilitate.mjs \
        server/index.mjs \
        server/tests/integration/trasabilitate.test.mjs \
        package.json \
        public/sw.js

git commit -m "feat(trasabilitate): backend agregator arbore DF↔ALOP↔ORD (v3.9.447)

PASUL 1 din 2 — backend pentru modal Trasabilitate (UI vine în PASUL 2).

Endpoint nou GET /api/trasabilitate/:type/:id (read-only, multi-tenant).
type ∈ {'df','ord'}. id e UUID validat regex.

Returnează arborele complet:
  - root_type / root_id
  - df_revizii: toate reviziile DF cu același nr_unic_inreg (R0..Rn) + flag aprobat
  - alopuri: ALOP-urile legate (de orice revizie DF), cu:
      - ord_curent: ORD-ul activ (alop_instances.ord_id) + lichidare/plată curentă
      - cicluri_arhivate: ORD-uri din cicluri închise (alop_ord_cicluri),
        fiecare cu lichidare/plată proprie + plata_suma_efectiva

Pattern 'aprobat' canonic, identic cu formulare-db.mjs:
  flow_id IS NOT NULL
  AND (f.data->>'status'='completed' OR (f.data->>'completed')::boolean=true)

Strategie 4 query-uri secvențiale (citibile + testabile) — preferat
față de un mega-CTE pentru un endpoint apelat rar (la click utilizator).

Marcaje root pentru UI:
  - is_root_df: true pe revizia DF root (când type='df')
  - is_root_df_link: true pe revizia DF legată direct la ORD root (când type='ord')
  - is_root_ord: true pe ord_curent SAU ciclu arhivat dacă match cu root_id

Fișiere noi:
  - server/services/trasabilitate.mjs              — agregator 4 queries
  - server/routes/trasabilitate.mjs                — GET /api/trasabilitate/:type/:id
  - server/tests/integration/trasabilitate.test.mjs — 8 teste

Modificări:
  - server/index.mjs: mount /api/trasabilitate
  - package.json: 3.9.446 → 3.9.447 + trasabilitate (service + route) în npm run check
  - public/sw.js: v162 → v163

PASUL 2 (v3.9.448) va adăuga: buton 🔗 lângă Nr. în lista DF/ORD +
modal cu arbore vizual + auto-load la click."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — 4 curl-uri
═══════════════════════════════════════════════════════════

După deploy pe staging:

1. Login pe https://docflowai-app-staging.up.railway.app/ și extrage cookie
   'auth_token' din DevTools → Application → Cookies.

2. Test fără auth:
   curl -s -o /dev/null -w "%{http_code}\n" \
     "https://docflowai-app-staging.up.railway.app/api/trasabilitate/df/00000000-0000-0000-0000-000000000000"
   → 401

3. Test type invalid:
   curl -s -H "Cookie: auth_token=COOKIE_VALUE" \
     "https://docflowai-app-staging.up.railway.app/api/trasabilitate/foo/00000000-0000-0000-0000-000000000000" | jq .
   → {"error":"invalid_type",...}

4. Test cu DF real (alege un id din lista DF) — verifică arborele:
   curl -s -H "Cookie: auth_token=COOKIE_VALUE" \
     "https://docflowai-app-staging.up.railway.app/api/trasabilitate/df/UUID_DF_REAL" | jq .

   Ar trebui să vezi:
   {
     "ok": true, "root_type": "df", "root_id": "...",
     "df_revizii": [ ... ],   // 1+ rânduri
     "alopuri": [
       { "id": "...", "titlu": "...", "ord_curent": { ... }, "cicluri_arhivate": [...] }
     ]
   }

5. Test cu ORD real cu cicluri (dacă ai un ALOP cu „noua lichidare" făcută):
   curl -s -H "Cookie: auth_token=COOKIE_VALUE" \
     "https://docflowai-app-staging.up.railway.app/api/trasabilitate/ord/UUID_ORD_REAL" | jq .

   Verifică:
   - df_revizii[0].is_root_df_link === true (DF-ul legat la ORD)
   - alopuri[0].cicluri_arhivate[].is_root_ord === true (dacă ORD root e arhivat)
     SAU alopuri[0].ord_curent.is_root_ord === true (dacă ORD root e curent)

6. Multi-tenant gate: dacă ai user în alt org, autentifică-te cu el și
   încearcă URL-ul cu UUID-ul DF dintr-o organizație străină — ar trebui 404.

STOP dacă:
- 500 pe staging → check Railway logs (probabil typo în SQL sau alias missing)
- df_revizii.length === 0 dar DF-ul există → problemă cu nr_unic_inreg NULL
- alopuri.length === 0 când există ALOP în BD → check Q3 (df_id IN reviziile)
- is_root_ord nu e setat corect → check rootIsOrd flag în service.mjs
```
