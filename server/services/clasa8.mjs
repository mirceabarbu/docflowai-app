/**
 * server/services/clasa8.mjs
 *
 * Agregator centralizator Clasa 8: per Cod SSI extrage din BD:
 *   - Angajamente bugetare  (DF Sec.B rows_ctrl[].sum_rezv_crdt_bug_act col.10=8+9,
 *                            DOAR ultima revizie per nr_unic_inreg, flow APROBAT)
 *   - Ordonanțări           (ORD rows[].suma_ordonantata_plata col.4, flow APROBAT)
 *   - Plăți (proporțional)  (alop_ord_cicluri + alop_instances ciclu curent,
 *                            plata_confirmed_at IS NOT NULL)
 *
 * „Aprobat" = JOIN flows f ON f.id = doc.flow_id
 *           WHERE f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true
 * (Pattern canonic, vezi server/routes/formulare-db.mjs „DF aprobate".)
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

  const ssi          = (filters.ssi    || '').trim();
  const compartiment = (filters.compartiment || '').trim();
  const qText        = (filters.q      || '').trim();

  const params = [orgId];
  let paramIdx = 1;

  // qText filter — aplicat la nivel de DF/ORD pentru performanță
  const dfQFilter = qText
    ? `AND (
         fd.compartiment_specialitate ILIKE $${++paramIdx}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(fd.rows_ctrl,'[]'::jsonb)) r
                    WHERE COALESCE(r->>'cod_SSI', r->>'codSSI', '') ILIKE $${paramIdx}
                       OR COALESCE(r->>'program','') ILIKE $${paramIdx}
                       OR COALESCE(r->>'cod_angajament','') ILIKE $${paramIdx})
       )`
    : '';
  if (qText) params.push(`%${qText}%`);

  const ordQFilter = qText
    ? `AND (
         fo.beneficiar ILIKE $${paramIdx}
         OR fo.compartiment_specialitate ILIKE $${paramIdx}
         OR EXISTS (SELECT 1 FROM jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r
                    WHERE COALESCE(r->>'cod_SSI', r->>'codSSI', '') ILIKE $${paramIdx}
                       OR COALESCE(r->>'program','') ILIKE $${paramIdx})
       )`
    : '';

  const dfCompFilter  = compartiment ? `AND fd.compartiment_specialitate = $${++paramIdx}` : '';
  if (compartiment) params.push(compartiment);

  const ordCompFilter = compartiment ? `AND fo.compartiment_specialitate = $${paramIdx}` : '';

  const ssiFinalFilter = ssi ? `AND a.cod_ssi ILIKE $${++paramIdx}` : '';
  if (ssi) params.push(`%${ssi}%`);

  const sql = `
    WITH
    -- ─────────────────────────────────────────────────────────────────────
    -- ANGAJAMENTE BUGETARE: ultima revizie aprobată per nr_unic_inreg.
    -- Sursă: DF Sec.B rows_ctrl[].sum_rezv_crdt_bug_act (col.10 = 8+9,
    --        Suma rezervată din credite bugetare actualizată).
    -- „Aprobat" = flow signing completat (NU doar form-data-entry).
    -- ─────────────────────────────────────────────────────────────────────
    latest_approved_df AS (
      SELECT DISTINCT ON (fd.nr_unic_inreg)
        fd.id, fd.rows_ctrl, fd.org_id, fd.nr_unic_inreg
      FROM formulare_df fd
      JOIN flows f ON f.id = fd.flow_id
      WHERE fd.org_id = $1
        AND fd.deleted_at IS NULL
        AND fd.flow_id IS NOT NULL
        AND fd.nr_unic_inreg IS NOT NULL
        AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
        ${dfCompFilter}
        ${dfQFilter}
      ORDER BY fd.nr_unic_inreg, fd.revizie_nr DESC NULLS LAST
    ),
    angajamente AS (
      SELECT
        cod_ssi,
        SUM(suma) AS suma,
        COUNT(DISTINCT df_id) AS df_count
      FROM (
        SELECT
          df.id AS df_id,
          COALESCE(r->>'cod_SSI', r->>'codSSI', '') AS cod_ssi,
          NULLIF(r->>'sum_rezv_crdt_bug_act','')::numeric AS suma
        FROM latest_approved_df df
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(df.rows_ctrl, '[]'::jsonb)) r
      ) sub
      WHERE cod_ssi <> ''
      GROUP BY cod_ssi
    ),

    -- ─────────────────────────────────────────────────────────────────────
    -- ORDONANȚĂRI: ORD aprobate (flow completat).
    -- Sursă: rows[].suma_ordonantata_plata (col.4 din ORD table).
    -- ORD-urile nu au revizii ⇒ doar filtru pe aprobat.
    -- ─────────────────────────────────────────────────────────────────────
    ordonantari AS (
      SELECT
        cod_ssi,
        SUM(suma) AS suma,
        COUNT(DISTINCT ord_id) AS ord_count
      FROM (
        SELECT
          fo.id AS ord_id,
          COALESCE(r->>'cod_SSI', r->>'codSSI', '') AS cod_ssi,
          NULLIF(r->>'suma_ordonantata_plata','')::numeric AS suma
        FROM formulare_ord fo
        JOIN flows f ON f.id = fo.flow_id
        CROSS JOIN LATERAL jsonb_array_elements(COALESCE(fo.rows, '[]'::jsonb)) r
        WHERE fo.org_id = $1
          AND fo.deleted_at IS NULL
          AND fo.flow_id IS NOT NULL
          AND (f.data->>'status' = 'completed' OR (f.data->>'completed')::boolean = true)
          ${ordCompFilter}
          ${ordQFilter}
      ) sub
      WHERE cod_ssi <> ''
      GROUP BY cod_ssi
    ),

    -- ─────────────────────────────────────────────────────────────────────
    -- PLĂȚI: două surse — alop_ord_cicluri (arhivate) + alop_instances (curent).
    -- Alocare proporțională pe rândurile ORD (regula de 3) — neschimbat.
    -- NU adăugăm filtru de aprobat la ORD pentru proporțional, întrucât
    -- workflow-ul ALOP impune deja: plata se confirmă DOAR după ORD aprobat.
    -- ─────────────────────────────────────────────────────────────────────
    plati_sources AS (
      SELECT c.ord_id, c.plata_suma_efectiva AS plata_suma, c.org_id
      FROM alop_ord_cicluri c
      WHERE c.org_id = $1
        AND c.plata_confirmed_at IS NOT NULL
        AND c.plata_suma_efectiva IS NOT NULL
        AND c.ord_id IS NOT NULL

      UNION ALL

      SELECT ai.ord_id, ai.plata_suma_efectiva AS plata_suma, ai.org_id
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

    buget AS (
      SELECT cod_ssi, valoare AS suma
      FROM clasa8_buget
      WHERE org_id = $1
    ),

    -- Universul cod_SSI = unirea celor 4 surse
    universe AS (
      SELECT cod_ssi FROM angajamente
      UNION SELECT cod_ssi FROM ordonantari
      UNION SELECT cod_ssi FROM plati
      UNION SELECT cod_ssi FROM buget
    ),

    -- Agregat final
    agregat AS (
      SELECT
        u.cod_ssi,
        ROUND(COALESCE(a.suma, 0)::numeric, 2)  AS angajamente,
        ROUND(COALESCE(o.suma, 0)::numeric, 2)  AS ordonantari,
        ROUND(COALESCE(p.suma, 0)::numeric, 2)  AS plati,
        ROUND((COALESCE(a.suma,0) - COALESCE(o.suma,0))::numeric, 2) AS ramane_din_angajamente,
        b.suma AS buget,
        CASE WHEN b.suma IS NULL THEN NULL
             ELSE ROUND((b.suma - COALESCE(a.suma,0))::numeric, 2)
        END AS ramane_din_buget,
        COALESCE(a.df_count,  0) AS df_count,
        COALESCE(o.ord_count, 0) AS ord_count
      FROM universe u
      LEFT JOIN angajamente  a ON a.cod_ssi = u.cod_ssi
      LEFT JOIN ordonantari  o ON o.cod_ssi = u.cod_ssi
      LEFT JOIN plati        p ON p.cod_ssi = u.cod_ssi
      LEFT JOIN buget        b ON b.cod_ssi = u.cod_ssi
    )

    SELECT
      a.cod_ssi,
      a.angajamente,
      a.ordonantari,
      a.plati,
      a.ramane_din_angajamente,
      a.buget,
      a.ramane_din_buget,
      a.df_count,
      a.ord_count
    FROM agregat a
    WHERE a.cod_ssi <> ''
      ${ssiFinalFilter}
    ORDER BY a.cod_ssi ASC
    LIMIT 5000
  `;

  const { rows } = await pool.query(sql, params);

  const items = rows.map(r => ({
    cod_ssi:                 r.cod_ssi,
    buget:                   r.buget == null ? null : Number(r.buget),
    angajamente:             Number(r.angajamente),
    ordonantari:             Number(r.ordonantari),
    plati:                   Number(r.plati),
    ramane_din_angajamente:  Number(r.ramane_din_angajamente),
    ramane_din_buget:        r.ramane_din_buget == null ? null : Number(r.ramane_din_buget),
    df_count:                Number(r.df_count),
    ord_count:               Number(r.ord_count),
  }));

  const totals = items.reduce((acc, x) => {
    if (x.buget !== null) acc.buget += x.buget;
    acc.angajamente += x.angajamente;
    acc.ordonantari += x.ordonantari;
    acc.plati       += x.plati;
    if (x.ramane_din_buget !== null) acc.ramane_din_buget += x.ramane_din_buget;
    acc.ramane_din_angajamente += x.ramane_din_angajamente;
    return acc;
  }, { buget: 0, angajamente: 0, ordonantari: 0, plati: 0, ramane_din_buget: 0, ramane_din_angajamente: 0 });

  Object.keys(totals).forEach(k => { totals[k] = Math.round(totals[k] * 100) / 100; });

  return {
    items,
    totals,
    count: items.length,
    filters_applied: {
      ssi:          ssi || null,
      compartiment: compartiment || null,
      q:            qText || null,
    },
  };
}
