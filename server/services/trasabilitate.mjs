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
         a.created_at, a.completed_at, a.cancelled_at,
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
         a.created_at, a.completed_at, a.cancelled_at,
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
