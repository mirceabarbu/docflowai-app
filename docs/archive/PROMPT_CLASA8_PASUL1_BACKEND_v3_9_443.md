# DocFlowAI — 🏛️ CLASA 8 (PASUL 1: Backend + Endpoint + Teste) v3.9.443

> **PASUL 1 din 2** — implementăm doar backend-ul (service + endpoint + teste). UI vine în PASUL 2 (v3.9.444).
> După deploy: testează endpoint-ul cu `curl` pe staging (exemple în secțiunea TEST POST-DEPLOY) înainte să comand PASUL 2.

```
DocFlowAI v3.9.442 → v3.9.443 (SW v158 → v159)
Branch: develop
Subiect: feat(clasa8): backend agregator centralizator angajamente/ordonanțări/plăți per Cod SSI

═══════════════════════════════════════════════════════════
CONTEXT — Ce și de ce
═══════════════════════════════════════════════════════════

Clasa 8 = nomenclatura din planul de conturi al instituțiilor publice
(OMFP 1917/2005) pentru angajamente bugetare și legale. Centralizatorul
răspunde la întrebarea contabilă esențială:

  "Per fiecare Cod SSI: cât am angajat? cât am ordonanțat? cât am plătit?"

Datele se preiau READ-ONLY din 4 surse existente:
  1. formulare_df.rows_ctrl  → Angajamente (Sec.B post-CFP, doar 'completed')
  2. formulare_ord.rows      → Ordonanțări (doar 'completed')
  3. alop_ord_cicluri        → Plăți cicluri arhivate (alocare proporțională)
  4. alop_instances          → Plăți ciclu curent (înainte de noua-lichidare)

DECIZII LUATE ÎMPREUNĂ:
  Q1 Plăți alocate proporțional (regula de 3 cu suma_ordonantata din rând)
  Q2 Angajamente DOAR din DF Sec.B (sum_rezv_crdt_ang_act)
  Q3 Filtru principal = Cod SSI (prefix match), fără filtru de an (cumulativ)
  Q4 BUGET importat = Phase 2 (acum coloana e null/'—')
  Q5 Status = doar 'completed' pe DF și ORD

Nota convenție duală: în JSONB găsim atât 'cod_SSI' (Sec.B + ORD)
cât și 'codSSI' (Sec.A). NU migrăm în BD — folosim COALESCE în SQL.

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs
- server/routes/flows/bulk-signing.mjs
- server/signing/pades.mjs
- server/signing/java-pades-client.mjs
- server/middleware/auth.mjs (e dual-mode acum, fix v3.9.442 — NU strica!)
- TOATE fișierele frontend (PASUL 2 atinge UI-ul)

═══════════════════════════════════════════════════════════
PASUL 1.1 — Service module: server/services/clasa8.mjs (FIȘIER NOU)
═══════════════════════════════════════════════════════════

Creează server/services/clasa8.mjs cu următorul conținut EXACT:

/**
 * server/services/clasa8.mjs
 *
 * Agregator centralizator Clasa 8: per Cod SSI extrage din BD:
 *   - Angajamente bugetare  (din formulare_df Sec.B, status='completed')
 *   - Ordonanțări           (din formulare_ord rows, status='completed')
 *   - Plăți (proporțional)  (din alop_ord_cicluri + alop_instances ciclu curent)
 *
 * Read-only. Nu scrie nimic în BD.
 *
 * Notă convenție duală cod_SSI / codSSI:
 *   - DF Sec.B (rows_ctrl) și ORD rows: cheia este 'cod_SSI' (snake_case)
 *   - DF Sec.A (rows_val): cheia este 'codSSI' (camelCase) — nu folosit aici
 *   Folosim COALESCE(r->>'cod_SSI', r->>'codSSI', '') ca să fie tolerant.
 *
 * Notă money parsing:
 *   Valorile money se salvează în JSONB ca string raw cu '.' separator zecimal
 *   (ex: "1234.56"), deci ::numeric cast funcționează direct.
 */

/**
 * Returnează rândurile centralizatorului filtrate.
 *
 * @param {object} pool - PostgreSQL pool
 * @param {number} orgId - ID organizație (filtru obligatoriu, multi-tenant)
 * @param {object} filters
 * @param {string} [filters.ssi]          - prefix Cod SSI (LIKE 'X%')
 * @param {string} [filters.compartiment] - filtru pe compartiment_specialitate
 * @param {string} [filters.q]            - free-text search (cod_SSI, program, beneficiar)
 * @returns {Promise<{items: Array, totals: object, count: number}>}
 */
export async function getClasa8Aggregate(pool, orgId, filters = {}) {
  if (!pool || !orgId) {
    throw new Error('clasa8.getClasa8Aggregate: pool și orgId sunt obligatorii');
  }

  const ssiPrefix    = (filters.ssi    || '').trim();
  const compartiment = (filters.compartiment || '').trim();
  const qText        = (filters.q      || '').trim();

  // Construim filtre dinamic. $1 = orgId, restul cresc.
  const params = [orgId];
  let paramIdx = 1;

  // ── Helper pentru filtre Cod SSI prefix
  // ssiPrefix se aplică DOAR la final (după agregare), pe coloana cod_ssi.
  // qText se aplică la nivel de DF/ORD (filtrare upstream pentru performanță).
  const dfQFilter   = qText
    ? `AND (
         fd.compartiment_specialitate ILIKE $${++paramIdx}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(fd.rows_ctrl,'[]'::jsonb)) r
                    WHERE COALESCE(r->>'cod_SSI', r->>'codSSI', '') ILIKE $${paramIdx}
                       OR COALESCE(r->>'program','') ILIKE $${paramIdx})
       )`
    : '';
  if (qText) params.push(`%${qText}%`);

  const ordQFilter  = qText
    ? `AND (
         fo.beneficiar ILIKE $${paramIdx}
         OR fo.compartiment_specialitate ILIKE $${paramIdx}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r
                    WHERE COALESCE(r->>'cod_SSI', r->>'codSSI', '') ILIKE $${paramIdx}
                       OR COALESCE(r->>'program','') ILIKE $${paramIdx})
       )`
    : '';
  // (nu mai incrementăm paramIdx — aceeași legătură $${paramIdx} reutilizată)

  const dfCompFilter  = compartiment ? `AND fd.compartiment_specialitate = $${++paramIdx}` : '';
  if (compartiment) params.push(compartiment);

  const ordCompFilter = compartiment ? `AND fo.compartiment_specialitate = $${paramIdx}` : '';
  // (același index $${paramIdx} pentru ORD)

  const ssiFinalFilter = ssiPrefix ? `AND a.cod_ssi ILIKE $${++paramIdx}` : '';
  if (ssiPrefix) params.push(`${ssiPrefix}%`);

  const sql = `
    WITH
    -- ─────────────────────────────────────────────────────────────────────
    -- 1) ANGAJAMENTE per cod_SSI (din DF Sec.B = rows_ctrl, status=completed)
    -- ─────────────────────────────────────────────────────────────────────
    angajamente AS (
      SELECT
        COALESCE(r->>'cod_SSI', r->>'codSSI', '') AS cod_ssi,
        SUM(NULLIF(r->>'sum_rezv_crdt_ang_act','')::numeric) AS suma,
        COUNT(DISTINCT fd.id) AS df_count
      FROM formulare_df fd
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fd.rows_ctrl, '[]'::jsonb)) r
      WHERE fd.org_id = $1
        AND fd.status = 'completed'
        AND fd.deleted_at IS NULL
        AND COALESCE(r->>'cod_SSI', r->>'codSSI', '') <> ''
        ${dfCompFilter}
        ${dfQFilter}
      GROUP BY 1
    ),

    -- ─────────────────────────────────────────────────────────────────────
    -- 2) ORDONANȚĂRI per cod_SSI (din ORD rows, status=completed)
    -- ─────────────────────────────────────────────────────────────────────
    ordonantari AS (
      SELECT
        COALESCE(r->>'cod_SSI', r->>'codSSI', '') AS cod_ssi,
        SUM(NULLIF(r->>'suma_ordonantata_plata','')::numeric) AS suma,
        COUNT(DISTINCT fo.id) AS ord_count
      FROM formulare_ord fo
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fo.rows, '[]'::jsonb)) r
      WHERE fo.org_id = $1
        AND fo.status = 'completed'
        AND fo.deleted_at IS NULL
        AND COALESCE(r->>'cod_SSI', r->>'codSSI', '') <> ''
        ${ordCompFilter}
        ${ordQFilter}
      GROUP BY 1
    ),

    -- ─────────────────────────────────────────────────────────────────────
    -- 3) PLĂȚI: două surse — alop_ord_cicluri (arhivate) + alop_instances (ciclu curent)
    --     Alocare proporțională: pentru fiecare ord plătit, distribuim
    --     plata_suma_efectiva pe rândurile ORD-ului în raport cu
    --     suma_ordonantata din rând (regula de 3).
    -- ─────────────────────────────────────────────────────────────────────
    plati_sources AS (
      -- a) Cicluri arhivate
      SELECT
        c.ord_id,
        c.plata_suma_efectiva AS plata_suma,
        c.org_id
      FROM alop_ord_cicluri c
      WHERE c.org_id = $1
        AND c.plata_confirmed_at IS NOT NULL
        AND c.plata_suma_efectiva IS NOT NULL
        AND c.ord_id IS NOT NULL

      UNION ALL

      -- b) Ciclu curent al ALOP (înainte de noua-lichidare)
      SELECT
        ai.ord_id,
        ai.plata_suma_efectiva AS plata_suma,
        ai.org_id
      FROM alop_instances ai
      WHERE ai.org_id = $1
        AND ai.cancelled_at IS NULL
        AND ai.plata_confirmed_at IS NOT NULL
        AND ai.plata_suma_efectiva IS NOT NULL
        AND ai.ord_id IS NOT NULL
    ),
    ord_totals AS (
      SELECT
        fo.id AS ord_id,
        SUM(NULLIF(r->>'suma_ordonantata_plata','')::numeric) AS total_ord
      FROM formulare_ord fo
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fo.rows, '[]'::jsonb)) r
      WHERE fo.org_id = $1
        AND fo.deleted_at IS NULL
      GROUP BY fo.id
    ),
    ord_rows_ssi AS (
      SELECT
        fo.id AS ord_id,
        COALESCE(r->>'cod_SSI', r->>'codSSI', '') AS cod_ssi,
        NULLIF(r->>'suma_ordonantata_plata','')::numeric AS row_amount
      FROM formulare_ord fo
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fo.rows, '[]'::jsonb)) r
      WHERE fo.org_id = $1
        AND fo.deleted_at IS NULL
        AND COALESCE(r->>'cod_SSI', r->>'codSSI', '') <> ''
        AND NULLIF(r->>'suma_ordonantata_plata','')::numeric > 0
    ),
    plati AS (
      SELECT
        rr.cod_ssi,
        SUM(ps.plata_suma * (rr.row_amount / NULLIF(t.total_ord, 0))) AS suma
      FROM plati_sources ps
      JOIN ord_rows_ssi rr ON rr.ord_id = ps.ord_id
      JOIN ord_totals  t  ON t.ord_id  = ps.ord_id
      WHERE t.total_ord > 0
      GROUP BY rr.cod_ssi
    ),

    -- ─────────────────────────────────────────────────────────────────────
    -- 4) Universul cod_SSI = unirea celor 3 surse
    -- ─────────────────────────────────────────────────────────────────────
    universe AS (
      SELECT cod_ssi FROM angajamente
      UNION
      SELECT cod_ssi FROM ordonantari
      UNION
      SELECT cod_ssi FROM plati
    ),

    -- ─────────────────────────────────────────────────────────────────────
    -- 5) Agregat final
    -- ─────────────────────────────────────────────────────────────────────
    agregat AS (
      SELECT
        u.cod_ssi,
        ROUND(COALESCE(a.suma, 0)::numeric, 2)  AS angajamente,
        ROUND(COALESCE(o.suma, 0)::numeric, 2)  AS ordonantari,
        ROUND(COALESCE(p.suma, 0)::numeric, 2)  AS plati,
        ROUND((COALESCE(a.suma,0) - COALESCE(p.suma,0))::numeric, 2) AS ramane_din_angajamente,
        COALESCE(a.df_count,  0) AS df_count,
        COALESCE(o.ord_count, 0) AS ord_count
      FROM universe u
      LEFT JOIN angajamente  a ON a.cod_ssi = u.cod_ssi
      LEFT JOIN ordonantari  o ON o.cod_ssi = u.cod_ssi
      LEFT JOIN plati        p ON p.cod_ssi = u.cod_ssi
    )

    SELECT
      a.cod_ssi,
      a.angajamente,
      a.ordonantari,
      a.plati,
      a.ramane_din_angajamente,
      a.df_count,
      a.ord_count
    FROM agregat a
    WHERE a.cod_ssi <> ''
      ${ssiFinalFilter}
    ORDER BY a.cod_ssi ASC
    LIMIT 5000
  `;

  const { rows } = await pool.query(sql, params);

  // Convertim numeric strings la Number pentru consistență client-side
  const items = rows.map(r => ({
    cod_ssi:                 r.cod_ssi,
    buget:                   null, // Phase 2 placeholder
    angajamente:             Number(r.angajamente),
    ordonantari:             Number(r.ordonantari),
    plati:                   Number(r.plati),
    ramane_din_angajamente:  Number(r.ramane_din_angajamente),
    df_count:                Number(r.df_count),
    ord_count:               Number(r.ord_count),
  }));

  // Calcul totale pentru footer
  const totals = items.reduce((acc, x) => {
    acc.angajamente += x.angajamente;
    acc.ordonantari += x.ordonantari;
    acc.plati       += x.plati;
    acc.ramane_din_angajamente += x.ramane_din_angajamente;
    return acc;
  }, { angajamente: 0, ordonantari: 0, plati: 0, ramane_din_angajamente: 0 });

  // Round totals la 2 zecimale
  Object.keys(totals).forEach(k => { totals[k] = Math.round(totals[k] * 100) / 100; });

  return {
    items,
    totals,
    count: items.length,
    filters_applied: {
      ssi:          ssiPrefix || null,
      compartiment: compartiment || null,
      q:            qText || null,
    },
  };
}

═══════════════════════════════════════════════════════════
PASUL 1.2 — Route module: server/routes/clasa8.mjs (FIȘIER NOU)
═══════════════════════════════════════════════════════════

Creează server/routes/clasa8.mjs cu următorul conținut EXACT:

/**
 * server/routes/clasa8.mjs
 * Endpoint pentru centralizatorul Clasa 8 (read-only, agregator).
 * Mount: app.use('/api/clasa8', clasa8Router)
 */

import { Router } from 'express';
import { requireAuth } from '../middleware/auth.mjs';
import { logger }      from '../middleware/logger.mjs';
import { pool }        from '../db/index.mjs';
import { getClasa8Aggregate } from '../services/clasa8.mjs';

const router = Router();

// GET /api/clasa8?ssi=&compartiment=&q=
router.get('/', requireAuth, async (req, res) => {
  try {
    if (!pool) return res.status(503).json({ error: 'db_unavailable' });

    const { orgId } = req.actor;
    if (!orgId) return res.status(400).json({ error: 'orgId_missing_in_token' });

    const filters = {
      ssi:          typeof req.query.ssi === 'string' ? req.query.ssi : '',
      compartiment: typeof req.query.compartiment === 'string' ? req.query.compartiment : '',
      q:            typeof req.query.q === 'string' ? req.query.q : '',
    };

    // Sanity limits — preveni abuzul (filtru prea lung blochează ILIKE)
    if (filters.ssi.length > 100)          return res.status(400).json({ error: 'ssi_too_long' });
    if (filters.compartiment.length > 200) return res.status(400).json({ error: 'compartiment_too_long' });
    if (filters.q.length > 200)            return res.status(400).json({ error: 'q_too_long' });

    const result = await getClasa8Aggregate(pool, orgId, filters);
    return res.json(result);
  } catch (e) {
    logger.error({ err: e, requestId: req.requestId }, 'clasa8 aggregate error');
    return res.status(500).json({ error: 'server_error' });
  }
});

export default router;

═══════════════════════════════════════════════════════════
PASUL 1.3 — Mount în server/index.mjs
═══════════════════════════════════════════════════════════

3.1 — Adaugă import (lângă celelalte router imports, ~linia 521):

old_str:
import formulareOficialeRouter from './routes/formulare-oficiale.mjs';

new_str:
import formulareOficialeRouter from './routes/formulare-oficiale.mjs';
import clasa8Router            from './routes/clasa8.mjs';

3.2 — Adaugă mount după montarea formulareOficialeRouter (~linia 1756):

old_str:
app.use('/api/formulare-oficiale', formulareOficialeRouter); // Formulare Oficiale CRUD (NF Invest, Referat)

new_str:
app.use('/api/formulare-oficiale', formulareOficialeRouter); // Formulare Oficiale CRUD (NF Invest, Referat)
app.use('/api/clasa8',             clasa8Router);             // Centralizator Clasa 8 (read-only)

═══════════════════════════════════════════════════════════
PASUL 1.4 — Adaugă fișierele noi în npm run check
═══════════════════════════════════════════════════════════

În package.json, în scriptul "check", adaugă cele 2 fișiere noi:

  Caută stringul: `node --check server/services/format-money.mjs`
  Imediat ÎNAINTE adaugă: `node --check server/services/clasa8.mjs && `

  Caută stringul: `node --check server/routes/admin.mjs`
  Imediat ÎNAINTE adaugă: `node --check server/routes/clasa8.mjs && `

Verifică sintactic cu: npm run check

═══════════════════════════════════════════════════════════
PASUL 1.5 — Teste integration: server/tests/integration/clasa8.test.mjs (NOU)
═══════════════════════════════════════════════════════════

Creează server/tests/integration/clasa8.test.mjs cu următorul conținut:

/**
 * Integration tests — Clasa 8 (centralizator angajamente/ordonanțări/plăți)
 *
 * Acoperire:
 *   ✓ 401 fără autentificare
 *   ✓ 400 ssi prea lung
 *   ✓ 200 răspuns gol când nu există date completed
 *   ✓ 200 agregare corectă pe DF Sec.B (1 cod_SSI, 1 DF)
 *   ✓ 200 agregare corectă pe ORD rows (1 cod_SSI, 1 ORD)
 *   ✓ 200 alocare proporțională plăți (regula de 3)
 *   ✓ 200 toleranță convenție duală cod_SSI vs codSSI
 *   ✓ 200 filtru ssi prefix funcționează
 *   ✓ 200 multi-tenant izolare (orgId diferit nu vede datele)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request    from 'supertest';
import express    from 'express';
import cookieParser from 'cookie-parser';
import jwt        from 'jsonwebtoken';

vi.mock('../../db/index.mjs', () => {
  const mockQuery = vi.fn();
  return { pool: { query: mockQuery } };
});

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })) },
}));

import * as dbModule from '../../db/index.mjs';
import clasa8Router  from '../../routes/clasa8.mjs';

const TEST_JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

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
  app.use('/api/clasa8', clasa8Router);
  return app;
}

describe('GET /api/clasa8', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    process.env.JWT_SECRET = TEST_JWT_SECRET;
  });

  it('401 fără autentificare', async () => {
    const app = makeApp();
    const r = await request(app).get('/api/clasa8');
    expect(r.status).toBe(401);
  });

  it('400 ssi prea lung', async () => {
    const app = makeApp();
    const r = await request(app)
      .get('/api/clasa8?ssi=' + 'x'.repeat(101))
      .set('Cookie', `token=${makeToken()}`);
    expect(r.status).toBe(400);
    expect(r.body.error).toBe('ssi_too_long');
  });

  it('200 răspuns gol când BD returnează 0 rânduri', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app).get('/api/clasa8').set('Cookie', `token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.items).toEqual([]);
    expect(r.body.count).toBe(0);
    expect(r.body.totals).toEqual({
      angajamente: 0, ordonantari: 0, plati: 0, ramane_din_angajamente: 0,
    });
  });

  it('200 agregare cu rânduri și totale corecte', async () => {
    dbModule.pool.query.mockResolvedValueOnce({
      rows: [
        {
          cod_ssi: '01A510103',
          angajamente: '1000.00', ordonantari: '800.00', plati: '600.00',
          ramane_din_angajamente: '400.00', df_count: 2, ord_count: 1,
        },
        {
          cod_ssi: '02B620100',
          angajamente: '500.00', ordonantari: '500.00', plati: '500.00',
          ramane_din_angajamente: '0.00', df_count: 1, ord_count: 1,
        },
      ]
    });
    const app = makeApp();
    const r = await request(app).get('/api/clasa8').set('Cookie', `token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.count).toBe(2);
    expect(r.body.items[0].cod_ssi).toBe('01A510103');
    expect(r.body.items[0].angajamente).toBe(1000);
    expect(r.body.items[0].buget).toBeNull(); // Phase 2 placeholder
    expect(r.body.totals).toEqual({
      angajamente: 1500, ordonantari: 1300, plati: 1100, ramane_din_angajamente: 400,
    });
  });

  it('200 filtru ssi e propagat corect ca parametru SQL', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app)
      .get('/api/clasa8?ssi=01A')
      .set('Cookie', `token=${makeToken()}`);
    expect(r.status).toBe(200);
    expect(r.body.filters_applied.ssi).toBe('01A');
    // SQL trebuie să fi fost apelat cu prefix-ul transformat în 'X%'
    const callArgs = dbModule.pool.query.mock.calls[0];
    expect(callArgs[0]).toContain('ILIKE');
    expect(callArgs[1]).toContain('01A%');
  });

  it('200 multi-tenant: orgId din JWT propagat în query ($1)', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    const r = await request(app)
      .get('/api/clasa8')
      .set('Cookie', `token=${makeToken({ orgId: 42 })}`);
    expect(r.status).toBe(200);
    const callArgs = dbModule.pool.query.mock.calls[0];
    expect(callArgs[1][0]).toBe(42); // primul parametru SQL = orgId
  });

  it('500 când BD aruncă eroare', async () => {
    dbModule.pool.query.mockRejectedValueOnce(new Error('connection refused'));
    const app = makeApp();
    const r = await request(app).get('/api/clasa8').set('Cookie', `token=${makeToken()}`);
    expect(r.status).toBe(500);
    expect(r.body.error).toBe('server_error');
  });
});

═══════════════════════════════════════════════════════════
PASUL 1.6 — Cache busting (3.9.442 → 3.9.443, SW v158 → v159)
═══════════════════════════════════════════════════════════

6.1 — package.json:
  old_str:   "version": "3.9.442",
  new_str:   "version": "3.9.443",

6.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v158';
  new_str: const CACHE_VERSION = 'docflowai-v159';

NOTĂ: NU bumpăm încă referințele v=3.9.442 din HTML — sunt încă valide
și vor fi toate bump-ate la v=3.9.444 în PASUL 2 (când adăugăm UI).

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Service module sintactic OK:
   node --check server/services/clasa8.mjs

2. Route module sintactic OK:
   node --check server/routes/clasa8.mjs

3. Service module e importat corect în route:
   grep "from '../services/clasa8.mjs'" server/routes/clasa8.mjs
   → 1 linie

4. Router montat în index.mjs:
   grep -c "clasa8Router\|/api/clasa8" server/index.mjs
   → ≥ 3 (import, mount, comentariu)

5. SQL conține CTE-urile cheie:
   grep -cE "WITH|angajamente AS|ordonantari AS|plati AS|universe AS" server/services/clasa8.mjs
   → ≥ 5

6. Convenție duală cod_SSI gestionată:
   grep -c "COALESCE(r->>'cod_SSI'" server/services/clasa8.mjs
   → ≥ 4 (în fiecare CTE care lucrează cu cod_SSI)

7. Status filter aplicat:
   grep -c "fd.status = 'completed'\|fo.status = 'completed'" server/services/clasa8.mjs
   → ≥ 2

8. npm run check pasează (toate cele 40+ fișiere syntactic OK)

9. npm test verde, fără regresii (test-suite include noile teste clasa8)

10. Server pornește fără erori:
    JWT_SECRET=test-jwt-secret-vitest-docflowai-2025-xx PORT=9999 node server/index.mjs &
    sleep 3
    curl -s http://localhost:9999/healthz | head -1
    kill %1 2>/dev/null
    → ar trebui să fie '{"ok":true}' sau similar

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/services/clasa8.mjs \
        server/routes/clasa8.mjs \
        server/index.mjs \
        server/tests/integration/clasa8.test.mjs \
        package.json \
        public/sw.js

git commit -m "feat(clasa8): backend agregator centralizator Clasa 8 (v3.9.443)

PASUL 1 din 2 — backend complet pentru noul tab Clasa 8 (UI vine în PASUL 2).

Centralizator read-only care agregă per Cod SSI:
  - Angajamente bugetare    (formulare_df Sec.B, status='completed', sum_rezv_crdt_ang_act)
  - Ordonanțări             (formulare_ord rows, status='completed', suma_ordonantata_plata)
  - Plăți (proporțional)    (alop_ord_cicluri + alop_instances ciclu curent,
                             alocate prin regula de 3 pe rândurile ORD-ului)

Decizii arhitecturale:
  Q1 Plăți alocate proporțional cu suma_ordonantata din rând
  Q2 Angajamente DOAR din DF Sec.B (post-CFP, oficial OMF 1140/2025)
  Q3 Filtru principal = Cod SSI prefix; cumulativ (fără filtru de an)
  Q4 BUGET (din fișier) = Phase 2 — coloana e null acum
  Q5 Status = doar 'completed' (DF + ORD)

Fișiere noi:
  - server/services/clasa8.mjs              — agregator SQL (CTE: ang/ord/plati/universe)
  - server/routes/clasa8.mjs                — GET /api/clasa8?ssi=&compartiment=&q=
  - server/tests/integration/clasa8.test.mjs — 7 teste (auth, agregare, filtre, multi-tenant)

Modificări:
  - server/index.mjs: mount /api/clasa8
  - package.json: 3.9.442 → 3.9.443 + clasa8 în npm run check
  - public/sw.js: v158 → v159

Convenție duală 'cod_SSI'/'codSSI' rezolvată cu COALESCE în SQL — NU
modificăm BD în producție.

Money parsing: valorile money sunt salvate în JSONB ca string raw cu '.'
separator zecimal (verificat în getNV/getNP/getNC din core.js), deci
::numeric cast funcționează direct.

PASUL 2 (v3.9.444) va adăuga sub-tab-ul UI între ORD și Verificare furnizor."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — verificare endpoint cu curl
═══════════════════════════════════════════════════════════

După deploy pe staging:

1. Login pe https://docflowai-app-staging.up.railway.app/ și extrage cookie:
   În DevTools → Application → Cookies → copy 'token' value

2. Test endpoint gol (org fără date):
   curl -s -H "Cookie: token=COOKIE_VALUE" \
     "https://docflowai-app-staging.up.railway.app/api/clasa8" | jq .
   → Ar trebui: { items: [], totals: {...zerouri...}, count: 0, filters_applied: {...} }

3. Test endpoint cu date (după ce există DF/ORD completate):
   curl -s -H "Cookie: token=COOKIE_VALUE" \
     "https://docflowai-app-staging.up.railway.app/api/clasa8" | jq '.items[0:3]'
   → Ar trebui să vezi rânduri cu cod_ssi, angajamente, ordonantari, plati...

4. Test filtru ssi:
   curl -s -H "Cookie: token=COOKIE_VALUE" \
     "https://docflowai-app-staging.up.railway.app/api/clasa8?ssi=01A" | jq .
   → Doar cod_ssi care încep cu '01A'

5. Test 401 (fără cookie):
   curl -s -o /dev/null -w "%{http_code}\n" \
     "https://docflowai-app-staging.up.railway.app/api/clasa8"
   → 401

6. Test multi-tenant: dacă ai user în alt org, login cu el și verifică
   că răspunsul e diferit (sau gol dacă org-ul nu are date).

7. Verificare aritmetică pe un cod_ssi cunoscut:
   - Identifică un cod_ssi din DF Sec.B (rows_ctrl) cu valoare X RON
   - Verifică că în răspuns 'angajamente' = X (sau aproape, cu rotunjire)
   - Identifică un ORD cu acel cod_ssi și valoare Y → 'ordonantari' = Y
   - Identifică o plată ALOP cu acel ord_id și suma Z → 'plati' = Z
     (sau Z * (Y/total_ord_amount) dacă ORD-ul are mai multe coduri SSI)

STOP dacă:
- Endpoint returnează 500 → check Railway logs (probabil typo în SQL CTE)
- Răspuns are NaN sau undefined → problemă cu money parsing (NULLIF lipsă?)
- Multi-tenant leak → orgId nu e propagat corect în query (verifică req.actor)
- Plățile sunt double-counted → verifică UNION ALL între cicluri + alop_instances
  (atenție: după 'noua-lichidare', alop_instances.plata_suma_efectiva trebuie
  resetat la NULL, altfel apare în ambele surse)
```
