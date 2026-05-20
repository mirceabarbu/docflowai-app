# DocFlowAI — 🩹 CLASA 8 HOTFIX: surse corecte + UI cleanup (v3.9.445)

> **Hotfix peste v3.9.444** — corectează 2 buguri funcționale critice (sursă greșită + filtru status incorect) + 2 ajustări UI cosmetice. Tabelul actual arată cifre eronate.

```
DocFlowAI v3.9.444 → v3.9.445 (SW v160 → v161)
Branch: develop
Subiect: fix(clasa8): coloana 10 Sec.B + flow aprobat + ultima revizie + UI cleanup

═══════════════════════════════════════════════════════════
CONTEXT — 4 probleme rezolvate
═══════════════════════════════════════════════════════════

P1 (CRITIC) — Coloana greșită din DF Sec.B
  Curent (PASUL 1): rows_ctrl[].sum_rezv_crdt_ang_act
                    (col.7 = 5+6, suma rezervată CREDITE DE ANGAJAMENT)
  Corect:           rows_ctrl[].sum_rezv_crdt_bug_act
                    (col.10 = 8+9, suma rezervată CREDITE BUGETARE)

  Coloana din Clasa 8 se numește „Angajamente bugetare" — corespunde
  semantic cu col.10 (credite BUGETARE), nu col.7 (credite ANGAJAMENT).
  Schimbarea e literalmente 3 caractere: 'ang' → 'bug'.

P2 (CRITIC) — Filtru status: 'completed' ≠ 'aprobat'
  Curent (PASUL 1): fd.status = 'completed' și fo.status = 'completed'
    Asta înseamnă „P1+P2 au terminat data entry" — NU înseamnă aprobat.
    Documentele neaprobate (flow nesemnat) intră în centralizator!
  Corect: documentul are flow_id legat și flow-ul de semnare e completat:
    JOIN flows f ON f.id = fd.flow_id
    WHERE (f.data->>'status' = 'completed'
           OR (f.data->>'completed')::boolean = true)

  Pattern canonic — folosit deja în server/routes/formulare-db.mjs
  (endpoint „DF aprobate") și în server/routes/alop.mjs.

P2.5 (CRITIC, doar pentru DF) — Doar ultima revizie per nr_unic_inreg
  Un DF poate avea mai multe revizii (R0, R1, R2…) cu același nr_unic_inreg.
  Pentru Clasa 8 ne interesează DOAR ultima revizie aprobată — sumarea
  tuturor reviziilor ar dubla/tripla angajamentele.

  Soluție: DISTINCT ON (fd.nr_unic_inreg) ORDER BY revizie_nr DESC NULLS LAST.

  ORD nu are coloanele revizie_nr/parent_ord_id (vezi schema 049_formulare_ord),
  deci pentru ORD doar filtrăm pe flow aprobat fără DISTINCT ON.

P3 (UI cosmetic) — Headere tabel cu paranteze redundante
  Curent: 'Cod SSI (din DF/ORD)', 'BUGET (din fișier importat)',
          'Angajamente bugetare (number #.###,##)' etc.
  Corect: doar denumirile fără paranteze. Sub-textele acelea erau hint-uri
  pentru implementare, nu pentru utilizatori finali.

P4 (UI cosmetic) — Filter label cu detaliu tehnic redundant
  Curent: '🔎 Filtrare după Cod SSI (live, debounce 350 ms)'
  Corect: '🔎 Filtrare după Cod SSI'

═══════════════════════════════════════════════════════════
ZONĂ NO-TOUCH
═══════════════════════════════════════════════════════════
- server/signing/providers/STSCloudProvider.mjs
- server/routes/flows/cloud-signing.mjs / bulk-signing.mjs
- server/signing/pades.mjs / java-pades-client.mjs
- server/middleware/auth.mjs (dual-mode din v3.9.442 — NU ATINGE)
- server/routes/clasa8.mjs (PASUL 1 — endpoint logic OK, doar SQL-ul din service e greșit)
- public/js/formular/clasa8.js (PASUL 2 — UI logic OK, doar HTML headers se schimbă)
- public/js/formular/list.js (switchListTab e OK)

═══════════════════════════════════════════════════════════
PASUL 1 — Înlocuire integrală a funcției getClasa8Aggregate
═══════════════════════════════════════════════════════════

Strategia: citește mai întâi server/services/clasa8.mjs cu `view`, identifică
funcția getClasa8Aggregate, apoi str_replace pe ea în întregime.

Folosește ca old_str funcția curentă completă (de la
`export async function getClasa8Aggregate(pool, orgId, filters = {}) {`
până la accolada finală a funcției — INCLUZÂND-O).

new_str (înlocuiește integral funcția):

export async function getClasa8Aggregate(pool, orgId, filters = {}) {
  if (!pool || !orgId) {
    throw new Error('clasa8.getClasa8Aggregate: pool și orgId sunt obligatorii');
  }

  const ssiPrefix    = (filters.ssi    || '').trim();
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

  const ssiFinalFilter = ssiPrefix ? `AND a.cod_ssi ILIKE $${++paramIdx}` : '';
  if (ssiPrefix) params.push(`${ssiPrefix}%`);

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

    -- Universul cod_SSI = unirea celor 3 surse
    universe AS (
      SELECT cod_ssi FROM angajamente
      UNION
      SELECT cod_ssi FROM ordonantari
      UNION
      SELECT cod_ssi FROM plati
    ),

    -- Agregat final
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

  const items = rows.map(r => ({
    cod_ssi:                 r.cod_ssi,
    buget:                   null,
    angajamente:             Number(r.angajamente),
    ordonantari:             Number(r.ordonantari),
    plati:                   Number(r.plati),
    ramane_din_angajamente:  Number(r.ramane_din_angajamente),
    df_count:                Number(r.df_count),
    ord_count:               Number(r.ord_count),
  }));

  const totals = items.reduce((acc, x) => {
    acc.angajamente += x.angajamente;
    acc.ordonantari += x.ordonantari;
    acc.plati       += x.plati;
    acc.ramane_din_angajamente += x.ramane_din_angajamente;
    return acc;
  }, { angajamente: 0, ordonantari: 0, plati: 0, ramane_din_angajamente: 0 });

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
PASUL 2 — Update JSDoc-ul header în clasa8.mjs
═══════════════════════════════════════════════════════════

În server/services/clasa8.mjs, la începutul fișierului, înlocuiește
comentariile JSDoc despre surse:

old_str:
 * Agregator centralizator Clasa 8: per Cod SSI extrage din BD:
 *   - Angajamente bugetare  (din formulare_df Sec.B, status='completed')
 *   - Ordonanțări           (din formulare_ord rows, status='completed')
 *   - Plăți (proporțional)  (din alop_ord_cicluri + alop_instances ciclu curent)

new_str:
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

═══════════════════════════════════════════════════════════
PASUL 3 — Test nou pentru noua structură SQL
═══════════════════════════════════════════════════════════

În server/tests/integration/clasa8.test.mjs, în interiorul describe-ului
„GET /api/clasa8", caută testul `it('500 când BD aruncă eroare'` și
ADAUGĂ DUPĂ acel `it()` (înainte de închiderea describe-ului) un test nou:

  it('SQL folosește sursele corecte: rows_ctrl col.10 + flow APROBAT + DISTINCT ON ultima revizie', async () => {
    dbModule.pool.query.mockResolvedValueOnce({ rows: [] });
    const app = makeApp();
    await request(app).get('/api/clasa8').set('Cookie', `auth_token=${makeToken()}`);

    const sql = dbModule.pool.query.mock.calls[0][0];

    // ── Pozitive: trebuie să fie prezente ────────────────────────────────
    // Filtru aprobat (flow signing completat)
    expect(sql).toContain('JOIN flows f');
    expect(sql).toMatch(/f\.data->>'status'\s*=\s*'completed'/);
    expect(sql).toMatch(/f\.data->>'completed'/);
    // Ultima revizie per nr_unic_inreg
    expect(sql).toContain('DISTINCT ON (fd.nr_unic_inreg)');
    expect(sql).toMatch(/ORDER BY fd\.nr_unic_inreg,\s*fd\.revizie_nr DESC/);
    // Angajamente: Sec.B col.10 = sum_rezv_crdt_bug_act
    expect(sql).toContain('rows_ctrl');
    expect(sql).toContain('sum_rezv_crdt_bug_act');
    // Ordonanțări: ORD col.4
    expect(sql).toContain('suma_ordonantata_plata');
    // Plăți: confirmate efectiv
    expect(sql).toContain('plata_confirmed_at IS NOT NULL');

    // ── Negative: NU trebuie să mai fie sursa veche ──────────────────────
    expect(sql).not.toContain('sum_rezv_crdt_ang_act'); // col.7 (credite ANG, greșit)
    expect(sql).not.toContain('valt_actualiz');         // Sec.A (greșit ca sursă)
    expect(sql).not.toMatch(/\bfd\.status\s*=\s*'completed'/);
    expect(sql).not.toMatch(/\bfo\.status\s*=\s*'completed'/);
  });

NOTĂ: testul verifică structura SQL emisă, nu rezultatul. Validarea reală
a aritmeticii rămâne pe seama testelor manuale post-deploy pe staging.

═══════════════════════════════════════════════════════════
PASUL 4 — UI cleanup în public/formular.html
═══════════════════════════════════════════════════════════

PASUL 4.1 — Filter label: scoate „(live, debounce 350 ms)"

old_str:
      <label style="font-size:.77rem;color:var(--df-text-3);display:block;margin-bottom:4px;">
        🔎 Filtrare după Cod SSI (live, debounce 350 ms)
      </label>

new_str:
      <label style="font-size:.77rem;color:var(--df-text-3);display:block;margin-bottom:4px;">
        🔎 Filtrare după Cod SSI
      </label>

PASUL 4.2 — Headere tabel: scoate sub-textele cu paranteze

Caută în public/formular.html secțiunea cu thead-ul tabelului #clasa8-table.
Locația: imediat după <table id="clasa8-table" ... > → <thead> → <tr>.

old_str:
        <tr style="background:rgba(255,255,255,.04);border-bottom:2px solid var(--df-border-2);">
          <th style="text-align:left;padding:12px 14px;font-weight:700;color:var(--df-text-2);min-width:140px;">Cod SSI<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(din DF/ORD)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">BUGET<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(din fișier importat)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Angajamente bugetare<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(number #.###,##)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Ordonanțări<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(number #.###,##)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Plăți<br><span style="font-weight:400;font-size:.74rem;color:var(--df-text-5);">(number #.###,##)</span></th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Rămâne din<br>angajamente</th>
        </tr>

new_str:
        <tr style="background:rgba(255,255,255,.04);border-bottom:2px solid var(--df-border-2);">
          <th style="text-align:left;padding:12px 14px;font-weight:700;color:var(--df-text-2);min-width:140px;">Cod SSI</th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">BUGET</th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Angajamente bugetare</th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Ordonanțări</th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Plăți</th>
          <th style="text-align:right;padding:12px 14px;font-weight:700;color:var(--df-text-2);">Rămâne din<br>angajamente</th>
        </tr>

═══════════════════════════════════════════════════════════
PASUL 5 — Cache busting (3.9.444 → 3.9.445, SW v160 → v161)
═══════════════════════════════════════════════════════════

5.1 — package.json:
  old_str:   "version": "3.9.444",
  new_str:   "version": "3.9.445",

5.2 — public/sw.js:
  old_str: const CACHE_VERSION = 'docflowai-v160';
  new_str: const CACHE_VERSION = 'docflowai-v161';

5.3 — Cache busting în HTML (doar fișierele care au URL-uri citate de browser):
  Singurele fișiere HTML care încarcă clasa8.js sau au DOM modificat sunt
  formular.html. Bumpăm complet referințele v=3.9.444 → v=3.9.445 în toate
  cele 4 HTML-uri pentru consistență (nu vrem versiuni mixed-up):

  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    sed -i 's/v=3\.9\.444/v=3.9.445/g' "$f"
  done

  Verifică:
  for f in public/formular.html public/refnec-form.html \
           public/notafd-invest-form.html public/admin.html; do
    OLD=$(grep -c "v=3\.9\.444" "$f")
    NEW=$(grep -c "v=3\.9\.445" "$f")
    echo "$f: 444=$OLD, 445=$NEW"
    [ "$OLD" -eq 0 ] && [ "$NEW" -gt 0 ] && echo "  ✓ OK" || echo "  ✗ FAIL"
  done

═══════════════════════════════════════════════════════════
VERIFICARE OBLIGATORIE
═══════════════════════════════════════════════════════════

1. Modul service sintactic OK:
   node --check server/services/clasa8.mjs

2. Sursa nouă prezentă (col.10 Sec.B):
   grep -c "sum_rezv_crdt_bug_act" server/services/clasa8.mjs
   → ≥ 1

3. Sursa veche eliminată (col.7 Sec.B):
   grep -c "sum_rezv_crdt_ang_act" server/services/clasa8.mjs
   → 0

4. JOIN flows + flow-status (filtru aprobat):
   grep -cE "JOIN flows f" server/services/clasa8.mjs
   → ≥ 2 (DF + ORD)
   grep -cE "f\.data->>'status'" server/services/clasa8.mjs
   → ≥ 2

5. DISTINCT ON ultima revizie:
   grep -c "DISTINCT ON (fd.nr_unic_inreg)" server/services/clasa8.mjs
   → 1
   grep -c "fd\.revizie_nr DESC" server/services/clasa8.mjs
   → 1

6. NU mai filtrăm pe form-status greșit:
   grep -cE "\bfd\.status\s*=\s*'completed'" server/services/clasa8.mjs
   → 0
   grep -cE "\bfo\.status\s*=\s*'completed'" server/services/clasa8.mjs
   → 0

7. UI cleanup formular.html:
   grep -c "live, debounce 350 ms" public/formular.html
   → 0
   grep -cE "din DF/ORD|din fișier importat|number #\." public/formular.html
   → 0 (toate sub-textele paranteze din thead-ul Clasa 8 dispărute)

8. Buton sub-tab + secțiunea continuă să existe (NU am rupt accidental):
   grep -c 'id="ltab-clasa8"' public/formular.html
   → 1
   grep -c 'id="clasa8-section"' public/formular.html
   → 1

9. Cache busting curat:
   grep -c "v=3.9.445" public/formular.html
   → ≥ 50 (toate referințele bump-ate)
   grep -c "v=3.9.444" public/formular.html
   → 0

10. Sintaxă globală + teste:
    npm run check
    npm test verde, fără regresii (suite ar trebui să rămână 370/370 + 1 test nou = 371/371)

═══════════════════════════════════════════════════════════
COMMIT pe develop
═══════════════════════════════════════════════════════════
git add server/services/clasa8.mjs \
        server/tests/integration/clasa8.test.mjs \
        public/formular.html \
        public/refnec-form.html \
        public/notafd-invest-form.html \
        public/admin.html \
        public/sw.js \
        package.json

git commit -m "fix(clasa8): coloana 10 Sec.B + flow APROBAT + ultima revizie + UI cleanup (v3.9.445)

P1 (CRITIC) — Coloana greșită din DF Sec.B
  Înainte: rows_ctrl[].sum_rezv_crdt_ang_act (col.7 = credite ANGAJAMENT)
  După:    rows_ctrl[].sum_rezv_crdt_bug_act (col.10 = credite BUGETARE)
  Coloana din UI se numește 'Angajamente bugetare' → corespunde col.10.

P2 (CRITIC) — Filtru status: 'completed' ≠ 'aprobat'
  Înainte: fd.status='completed' și fo.status='completed'
           (înseamnă form data entry, NU document aprobat/semnat).
  După:    JOIN flows f WHERE f.data->>'status'='completed'
                            OR (f.data->>'completed')::boolean=true
  Pattern canonic, identic cu server/routes/formulare-db.mjs 'DF aprobate'.

P2.5 (CRITIC, doar DF) — Doar ultima revizie per nr_unic_inreg
  Adăugat DISTINCT ON (fd.nr_unic_inreg) ORDER BY revizie_nr DESC NULLS LAST
  în CTE latest_approved_df. Previne dublarea/triplarea angajamentelor
  când un document are R0+R1+R2 toate aprobate.
  ORD nu are revizii ⇒ nu se aplică.

P3 (UI) — Headere tabel curățate
  Eliminat sub-textele paranteze: '(din DF/ORD)', '(din fișier importat)',
  '(number #.###,##)' x3. Acelea erau hint-uri de implementare, nu
  pentru utilizatori.

P4 (UI) — Filter label simplificat
  '🔎 Filtrare după Cod SSI (live, debounce 350 ms)' →
  '🔎 Filtrare după Cod SSI'.

Test nou: clasa8.test.mjs verifică SQL conține JOIN flows / DISTINCT ON /
sum_rezv_crdt_bug_act ȘI nu mai conține sum_rezv_crdt_ang_act sau
fd.status='completed' (regression guard).

Cache: package 3.9.444 → 3.9.445, SW v160 → v161, HTML refs bumpate."

git push origin develop

═══════════════════════════════════════════════════════════
TEST POST-DEPLOY (staging) — checklist verificare aritmetică
═══════════════════════════════════════════════════════════

1. Hard refresh /formular.html (Ctrl+Shift+R) → tab Clasa 8.

2. UI cleanup vizibil:
   - Filter label: 'Filtrare după Cod SSI' (FĂRĂ '(live, debounce 350 ms)')
   - Headere: doar denumirile, fără sub-textele 'din DF/ORD', 'din fișier
     importat', 'number #.###,##'

3. Aritmetică ANGAJAMENTE — alege un cod_SSI cunoscut din DF aprobat:
   - Deschide DF respectiv în UI → tabela Sec.B → identifică rândul cu
     codul SSI → notează valoarea din coloana 10 (Suma rezervată credite
     bugetare actualizată).
   - Compară cu valoarea din Clasa 8 → trebuie să fie identică (sau sumă,
     dacă codul apare în mai multe DF-uri aprobate).

4. Aritmetică REVIZIE — dacă există un nr_unic_inreg cu R0 și R1 ambele
   aprobate:
   - Notează valorile col.10 din R0 și R1 separat.
   - În Clasa 8 valoarea ar trebui să fie DOAR cea din R1 (ultima revizie),
     NU R0+R1.

5. Aritmetică ORDONANȚĂRI — alege un cod_SSI dintr-un ORD aprobat:
   - Deschide ORD → tabela rânduri → notează valoarea col.4
     (suma_ordonantata_plata) pentru rândul cu codul SSI respectiv.
   - În Clasa 8 valoarea pentru cod_SSI ar trebui să corespundă (sau sumă
     pentru mai multe ORD-uri aprobate cu același cod).

6. Aritmetică PLĂȚI (proporțional) — neschimbată față de PASUL 1, dar
   re-verifică un caz:
   - ORD cu 2 rânduri (cod_SSI A=400, cod_SSI B=600, total=1000)
   - Plata efectivă=500 → A trebuie să primească 500*(400/1000)=200
   - Verifică în UI: Plăți pentru A=200, pentru B=300

7. Test status filter — caz de exclusion:
   - Creează un DF nou cu Sec.B completată DAR fără să trimiți spre semnare
     (deci fără flow_id, status form='draft').
   - În Clasa 8 codul respectiv NU trebuie să apară (înainte de fix apărea).
   - Trimite-l spre semnare. Atât timp cât NU e semnat de toți, NU apare.
   - După ce toți semnează → apare.

8. Filtru și export:
   - Tastează prefix valid → vezi doar rânduri matching → counter actualizat
   - Reset → vezi toate
   - Export Excel → fișier descărcat, cu header curat (fără sub-text)

9. Empty state:
   - Tastează ceva ce nu există → vezi 🪺 'Niciun cod SSI găsit'

STOP dacă:
- Aritmetica angajamente e încă greșită → verifică în SQL că folosim col.10:
  `grep "sum_rezv_crdt_bug_act" server/services/clasa8.mjs`
- DF neaprobate apar în continuare → verifică JOIN flows + flow-status:
  `grep -A 3 "JOIN flows f" server/services/clasa8.mjs`
- Reviziile R0+R1 se sumează → verifică DISTINCT ON:
  `grep "DISTINCT ON" server/services/clasa8.mjs`
- UI încă afișează sub-textul → cache stale, hard refresh sau verifică
  bumpul cache-busting în formular.html
```
