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
