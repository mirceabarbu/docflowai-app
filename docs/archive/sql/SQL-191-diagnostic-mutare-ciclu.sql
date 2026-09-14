-- ============================================================================
-- SQL-191 — DIAGNOSTIC: mutarea ciclului 1 între două dosare ALOP
--
-- READ-ONLY. Un pas pe execuție. NU repară nimic. NU rula nimic din SQL-191b
-- (reparația) până nu vedem rezultatele de aici.
--
-- Dosar A = cel GREȘIT   (DF   813.736,21 RON) — de golit și blocat
-- Dosar B = cel CORECT   (DF 1.065.946,64 RON) — primește ciclul
--
-- ⚠️ Valoarea DF se calculează cu EXACT expresia aplicației
--    (alop.mjs:794): SUM(rows_val[*].valt_actualiz).
-- ============================================================================


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 1 — identificarea celor două dosare după valoarea DF
-- ════════════════════════════════════════════════════════════════════════════
SELECT a.id                        AS alop_id,
       a.titlu,
       a.status,
       a.cancelled_at,
       a.ciclu_curent,
       a.df_id,
       fd.nr_unic_inreg            AS df_nr,
       fd.revizie_nr,
       (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(fd.rows_val, '[]'::jsonb)) r) AS df_valoare,
       a.created_at,
       a.updated_at
  FROM alop_instances a
  JOIN formulare_df fd ON fd.id = a.df_id AND fd.deleted_at IS NULL
 WHERE (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(fd.rows_val, '[]'::jsonb)) r)
       IN (813736.21, 1065946.64)
 ORDER BY df_valoare;

-- ⚠️ AȘTEPTAT: 2 rânduri. Dacă ies mai multe, notează-mi id-urile — înseamnă că
--    valoarea nu e discriminator unic și mergem pe titlu/număr DF.
--    ⭐ Notează `alop_id` pentru A (813.736,21) și B (1.065.946,64):
--       toate paginile următoare le folosesc.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 2 — starea financiară completă a ambelor dosare, una lângă alta
--           Înlocuiește <A> și <B> cu id-urile din PASUL 1.
-- ════════════════════════════════════════════════════════════════════════════
SELECT CASE WHEN a.id = '<A>' THEN 'A (gresit, 813.736,21)'
            ELSE 'B (corect, 1.065.946,64)' END           AS dosar,
       a.id, a.status, a.ciclu_curent, a.cancelled_at, a.completed_at,
       a.df_id, a.df_flow_id, a.df_completed_at,
       a.ord_id, a.ord_flow_id, a.ord_completed_at,
       a.lichidare_confirmed_at, a.lichidare_confirmed_by,
       a.lichidare_nr_factura   AS lich_factura,
       a.lichidare_valoare_factura,
       a.plata_confirmed_at, a.plata_confirmed_by,
       a.plata_nr_ordin, a.plata_data, a.plata_suma_efectiva,
       a.suma_totala_platita,
       a.valoare_totala, a.compartiment, a.created_by
  FROM alop_instances a
 WHERE a.id IN ('<A>', '<B>');

-- ⚠️ Ce citesc aici: dacă A are `plata_confirmed_at` completat, ciclul e DECONTAT —
--    mutarea devine o operație pe bani deja plătiți, nu pe o legătură.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 3 — ⭐ CICLURI ARHIVATE. Răspunde la întrebarea decisivă:
--           ciclul 1 e ARHIVAT (rând aici) sau e CEL CURENT (pe alop_instances)?
-- ════════════════════════════════════════════════════════════════════════════
SELECT c.alop_id,
       CASE WHEN c.alop_id = '<A>' THEN 'A' ELSE 'B' END AS dosar,
       c.id                        AS ciclu_id,
       c.ciclu_nr,
       c.status,
       c.ord_id, c.ord_flow_id,
       c.lichidare_confirmed_at, c.lichidare_nr_factura, c.lichidare_valoare_factura,
       c.plata_confirmed_at, c.plata_nr_ordin, c.plata_data, c.plata_suma_efectiva,
       c.created_at
  FROM alop_ord_cicluri c
 WHERE c.alop_id IN ('<A>', '<B>')
 ORDER BY c.alop_id, c.ciclu_nr;

-- ⚠️ ZERO rânduri pe A ⇒ ciclul 1 e ciclul CURENT (trăiește pe alop_instances).
--    Un rând pe A cu ciclu_nr=1 ⇒ e arhivat, iar dosarul are deja un ciclu 2 pornit.
--    Rânduri pe B ⇒ B are deja istoric ⇒ `ciclu_nr` al ciclului mutat trebuie
--    renumerotat, altfel se ciocnește cu ce există.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 4 — toate ORD-urile care aparțin fiecărui dosar, cu verdictul de semnare
-- ════════════════════════════════════════════════════════════════════════════
SELECT CASE WHEN o.source_alop_id = '<A>' THEN 'A' ELSE 'B' END AS dosar,
       o.id                        AS ord_id,
       o.nr_ordonant_pl            AS ord_nr,
       o.status                    AS ord_status,
       o.df_id                     AS ord_pointeaza_spre_df,
       o.flow_id,
       o.deleted_at IS NOT NULL    AS sters,
       (SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(o.rows, '[]'::jsonb)) r)  AS col4_total,
       (
         o.flow_id IS NOT NULL
         AND f.deleted_at IS NULL
         AND (f.data->>'status') IS DISTINCT FROM 'cancelled'
         AND (f.data->>'status') IS DISTINCT FROM 'refused'
         AND ((f.data->>'status') = 'completed'
              OR (f.data->>'completed')::boolean = true)
       )                           AS flux_valid_semnat,
       o.created_at
  FROM formulare_ord o
  LEFT JOIN flows f ON f.id = o.flow_id
 WHERE o.source_alop_id IN ('<A>', '<B>')
 ORDER BY o.source_alop_id, o.created_at;

-- ⚠️ ⭐ Coloana `ord_pointeaza_spre_df` e miezul deciziei de produs: ORD-ul care se
--    mută poartă în corpul lui DF-ul dosarului A (813.736,21) și a fost validat pe
--    col.10 din acel DF. PDF-ul semnat QES nu poate fi rescris.
--
-- ⚠️ `flux_valid_semnat = true` ⇒ mutăm un document cu semnătură calificată.


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 5 — dovada plății: liniile OPME atașate dosarelor / ciclurilor
-- ════════════════════════════════════════════════════════════════════════════
SELECT l.matched_alop_id,
       CASE WHEN l.matched_alop_id = '<A>' THEN 'A' ELSE 'B' END AS dosar,
       l.matched_ciclu_id,
       l.nr_op, l.suma_op, l.cod_angajament, l.indicator_angajament,
       l.den_beneficiar, l.matched_at
  FROM opme_lines l
 WHERE l.matched_alop_id IN ('<A>', '<B>')
 ORDER BY l.matched_alop_id, l.matched_at;

-- ⚠️ Fiecare rând de aici trebuie re-atașat odată cu ciclul, altfel plata efectivă
--    rămâne contorizată pe dosarul greșit (și `plata_suma_efectiva` diverge de OPME).


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 6 — DF-urile ambelor dosare (toate reviziile), ca să fie clar ce NU se mută
-- ════════════════════════════════════════════════════════════════════════════
SELECT CASE WHEN fd.source_alop_id = '<A>' THEN 'A' ELSE 'B' END AS dosar,
       fd.id, fd.nr_unic_inreg, fd.revizie_nr, fd.status, fd.flow_id,
       (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric), 0)
          FROM jsonb_array_elements(COALESCE(fd.rows_val, '[]'::jsonb)) r) AS df_valoare,
       fd.created_at
  FROM formulare_df fd
 WHERE fd.source_alop_id IN ('<A>', '<B>')
   AND fd.deleted_at IS NULL
 ORDER BY fd.source_alop_id, fd.revizie_nr;


-- ════════════════════════════════════════════════════════════════════════════
-- PASUL 7 — istoricul de stări (arată dacă poarta a mai fost lovită pe aceste dosare)
-- ════════════════════════════════════════════════════════════════════════════
SELECT l.alop_id,
       CASE WHEN l.alop_id = '<A>' THEN 'A' ELSE 'B' END AS dosar,
       l.old_status, l.new_status, l.violation, l.changed_by, l.changed_at
  FROM alop_status_log l
 WHERE l.alop_id IN ('<A>', '<B>')
 ORDER BY l.changed_at;

-- ⚠️ Orice UPDATE de status pe care îl vom face trece prin trigger-ul porții
--    (migrația 109, RAISE EXCEPTION) și lasă urmă aici. Din `completed` singura
--    tranziție legală e `completed → lichidare` — deci dacă A e `completed`,
--    blocarea lui NU se poate face prin `status='cancelled'`.
-- ============================================================================
