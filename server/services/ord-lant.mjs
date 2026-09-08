/**
 * DocFlowAI — server/services/ord-lant.mjs  (#186)
 *
 * LANȚUL DE ORDONANȚĂRI al unui dosar ALOP — sursa unică pentru:
 *   1. derivarea coloanei 3 („Plăți anterioare") a unei ORD noi;
 *   2. suma ORDONANȚATĂ pe dosar (disponibilul de ordonanțat, porțile de plafon).
 *
 * ── De ce e nevoie de un serviciu, nu de un query ad-hoc ────────────────────
 * `formulare_ord` NU are coloană `alop_id`. Legăturile dosar→ORD sunt DOUĂ:
 *   - `alop_ord_cicluri.alop_id + .ord_id` — ciclurile ARHIVATE (ordinea = `ciclu_nr`)
 *   - `alop_instances.ord_id`              — ciclul CURENT (ultimul din lanț)
 * Orice cod care are nevoie de „ORD-ul anterior" trebuie să le unească pe amândouă.
 *
 * ── Regulile de adevăr ale tabelului „Responsabil CAB" (OMF 1140/2025) ──────
 *   col.2 Recepții            — DATĂ EXTERNĂ din sistemul CAB. ⛔ Aplicația NU o derivă
 *                               NICIODATĂ; e completată manual și dovedită prin captură.
 *   col.3 Plăți anterioare    — `col.3 + col.4` de pe ultima ORD APROBATĂ a dosarului.
 *   col.4 Sumă ordonanțată    — introdusă de utilizator.
 *   col.5 Recepții neplătite  — `col.2 − col.3 − col.4`, ≥ 0 (validateOrdCol5).
 *
 * ⚠️ NUANȚA DIN GHID (Cap. II.1.2, pct. 3) — motivul pentru care derivarea NU e o simplă
 * adunare: „la înscrierea informațiilor în col.3 nu se va ține cont de cheltuielile care au
 * fost angajate, lichidate și ordonanțate anterior și care nu au apărut decontate în
 * extrasul de cont la momentul întocmirii formularului". Deci `col.4` al predecesorului se
 * adaugă DOAR dacă plata acelui ciclu e CONFIRMATĂ (decontată). Altfel col.3 derivată
 * rămâne exact `col.3` al predecesorului.
 *
 * ⚠️ `col3 === null` înseamnă „NU SE ȘTIE" (prima ordonanțare a dosarului), nu „zero lei".
 * Frontendul trebuie să le trateze diferit: pe `null` nu scrie nimic în tabel.
 *
 * Derivarea e o SUGESTIE de prefill, nu o garanție: col.3 rămâne editabilă, iar
 * responsabilul CAB rămâne răspunzător pentru col. 1, 2, 3 și 5 (decizie owner).
 *
 * ⚠️ Convenția de parsare a banilor e IMPORTATĂ (`numMoney` din formular-shared.mjs) —
 * nu există o a doua definiție aici.
 */

import { pool } from '../db/index.mjs';
import { numMoney } from './formular-shared.mjs';
import { docAprobatSql } from './df-aprobat-sql.mjs';

/**
 * Însumează o coloană a tabelului CAB peste TOATE rândurile unui `formulare_ord.rows`.
 * Un ORD multi-bloc (mai mulți furnizori) are mai multe rânduri și toate contează.
 * FUNCȚIE PURĂ.
 * @param {Array<Object>|string|null} rows  formulare_ord.rows (JSONB)
 * @param {string} camp  'receptii' | 'plati_anterioare' | 'suma_ordonantata_plata'
 * @returns {number}
 */
export function sumaColoana(rows, camp) {
  let arr = rows;
  if (typeof arr === 'string') { try { arr = JSON.parse(arr); } catch { arr = []; } }
  if (!Array.isArray(arr)) return 0;
  return arr.reduce((s, r) => s + numMoney(r && r[camp]), 0);
}

/**
 * Aritmetica derivării col.3, IZOLATĂ ca funcție PURĂ (testabilă fără DB).
 * @param {{col3:number, col4:number, plata_confirmata:boolean}|null} pred
 * @returns {{col3:number|null, sursa:'lant'|'prima_ord', plata_predecesor_confirmata:boolean}}
 */
export function col3DinPredecesor(pred) {
  if (!pred) return { col3: null, sursa: 'prima_ord', plata_predecesor_confirmata: false };
  const conf = pred.plata_confirmata === true;
  // Nuanța din ghid: col.4 al predecesorului intră DOAR dacă a fost decontat.
  const col3 = conf ? (Number(pred.col3) || 0) + (Number(pred.col4) || 0) : (Number(pred.col3) || 0);
  return { col3, sursa: 'lant', plata_predecesor_confirmata: conf };
}

// Lanțul complet dosar→ORD, ordonat DESCRESCĂTOR după ordinea emiterii.
// `ord_seq`: `ciclu_nr` pentru arhivate; `ciclu_curent` (mereu > toate cele arhivate,
// cu sentinelă mare la NULL) pentru ORD-ul curent ⇒ curentul iese primul.
// „Aprobat" = `docAprobatSql` — SINGURUL predicat de aprobare din arbore (#166).
const SQL_LANT_ORD = `
  SELECT * FROM (
    SELECT
      fo.id                                 AS ord_id,
      fo.nr_ordonant_pl                     AS nr_ord,
      fo.rows                               AS rows,
      c.ciclu_nr                            AS ord_seq,
      ${docAprobatSql('fo', 'f')}           AS aprobat,
      (c.plata_confirmed_at IS NOT NULL)    AS plata_confirmata
    FROM alop_ord_cicluri c
    JOIN formulare_ord fo ON fo.id = c.ord_id AND fo.deleted_at IS NULL
    LEFT JOIN flows f ON f.id = fo.flow_id
    WHERE c.alop_id = $1 AND c.org_id = $2

    UNION ALL

    SELECT
      fo.id                                 AS ord_id,
      fo.nr_ordonant_pl                     AS nr_ord,
      fo.rows                               AS rows,
      COALESCE(a.ciclu_curent, 1000000)     AS ord_seq,
      ${docAprobatSql('fo', 'f')}           AS aprobat,
      (a.plata_confirmed_at IS NOT NULL)    AS plata_confirmata
    FROM alop_instances a
    JOIN formulare_ord fo ON fo.id = a.ord_id AND fo.deleted_at IS NULL
    LEFT JOIN flows f ON f.id = fo.flow_id
    WHERE a.id = $1 AND a.org_id = $2
  ) t
  ORDER BY t.ord_seq DESC
`;

/**
 * Lanțul complet de ORD-uri al unui dosar, de la cel mai recent la cel mai vechi.
 * @returns {Promise<Array<{ord_id,nr_ord,aprobat,plata_confirmata,col2,col3,col4,col3_plus_col4}>>}
 */
export async function getLantOrd(alopId, orgId, db = pool) {
  if (!alopId) return [];
  const { rows } = await db.query(SQL_LANT_ORD, [alopId, orgId]);
  return rows.map(r => {
    const col2 = sumaColoana(r.rows, 'receptii');
    const col3 = sumaColoana(r.rows, 'plati_anterioare');
    const col4 = sumaColoana(r.rows, 'suma_ordonantata_plata');
    return {
      ord_id: r.ord_id,
      nr_ord: r.nr_ord,
      ord_seq: Number(r.ord_seq),
      aprobat: r.aprobat === true,
      plata_confirmata: r.plata_confirmata === true,
      col2, col3, col4,
      col3_plus_col4: col3 + col4,
    };
  });
}

/**
 * Predecesorul relevant pentru derivare = ultima ORD APROBATĂ a dosarului,
 * excluzând ORD-ul pentru care derivăm (`excludeOrdId`).
 * @returns {Promise<Object|null>}
 */
export async function getOrdPredecesor(alopId, orgId, { excludeOrdId } = {}, db = pool) {
  const lant = await getLantOrd(alopId, orgId, db);
  const ex = excludeOrdId ? String(excludeOrdId) : null;
  return lant.find(o => o.aprobat && (!ex || String(o.ord_id) !== ex)) || null;
}

/**
 * Col.3 derivată pentru o ORD a dosarului.
 * @returns {Promise<{col3:number|null, sursa:'lant'|'prima_ord',
 *                    predecesor:Object|null, plata_predecesor_confirmata:boolean}>}
 */
export async function derivaCol3(alopId, orgId, { pentruOrdId } = {}, db = pool) {
  const pred = await getOrdPredecesor(alopId, orgId, { excludeOrdId: pentruOrdId }, db);
  const { col3, sursa, plata_predecesor_confirmata } = col3DinPredecesor(pred);
  return { col3, sursa, predecesor: pred, plata_predecesor_confirmata };
}

/**
 * DISPONIBILUL DIN RECEPȚII = `col.2 − (col.3 + col.4)` de pe ultima ORD aprobată,
 * adică exact col.5 a acelui document. `null` când dosarul nu are predecesor aprobat
 * (nu se poate ști nimic despre recepții).
 */
export async function disponibilDinReceptii(alopId, orgId, { excludeOrdId } = {}, db = pool) {
  const pred = await getOrdPredecesor(alopId, orgId, { excludeOrdId }, db);
  if (!pred) return null;
  return pred.col2 - pred.col3_plus_col4;
}

/**
 * SUMA ORDONANȚATĂ pe dosar = Σ col.4 peste ciclurile arhivate + ORD-ul curent.
 *
 * ⚠️ Extrasă din poarta de la `POST /api/alop/:id/noua-lichidare` ca să existe O SINGURĂ
 * definiție: acolo se cheamă CU `anExercitiu` (plafon pe creditele bugetare ale anului),
 * iar în `GET /api/alop/:id` FĂRĂ (disponibilul se raportează la valoarea DF-ului, care e
 * un angajament MULTIANUAL). `anExercitiu === null` ⇒ fără filtrare pe an.
 *
 * `ordIdCurent` se dă EXPLICIT (nu se re-citește din DB) fiindcă `noua-lichidare` rulează
 * într-o tranzacție care tocmai a citit `alop.ord_id`.
 *
 * SE SCAD ORDONANȚĂRILE, NU PLĂȚILE (distincție owner, fix 12). Ciclurile arhivate nu
 * stochează suma ordonanțată ⇒ JOIN `ord_id → SUM(formulare_ord.rows.suma_ordonantata_plata)`.
 *
 * @returns {Promise<{arhivat:number, curent:number, total:number}>}
 */
export async function sumaOrdonantataDosar(alopId, { orgId, anExercitiu = null, ordIdCurent } = {}, db = pool) {
  const { rows } = await db.query(
    `SELECT
       COALESCE((
         SELECT SUM(co.s)
           FROM alop_ord_cicluri c
           CROSS JOIN LATERAL (
             SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
               FROM formulare_ord fo
               LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
              WHERE fo.id = c.ord_id
           ) co
          WHERE c.alop_id=$1
            AND ($2::int IS NULL OR COALESCE(c.an_exercitiu, EXTRACT(YEAR FROM c.plata_data)::int, EXTRACT(YEAR FROM c.created_at)::int) = $2)
       ), 0) AS arhivat,
       COALESCE((
         SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0)
           FROM formulare_ord fo
           LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
          WHERE fo.id=$3
       ), 0) AS curent`,
    [alopId, anExercitiu, ordIdCurent ?? null]
  );
  const arhivat = parseFloat(rows[0]?.arhivat || 0);
  const curent = parseFloat(rows[0]?.curent || 0);
  return { arhivat, curent, total: arhivat + curent };
}

/**
 * PORȚILE DE ORDONANȚARE (#186, Etapa D) — două praguri DISTINCTE, decizie owner:
 *
 *  - BLOCARE: `ordonantat_deja + suma > valoarea DF-ului aprobat`. E limita
 *    ANGAJAMENTULUI LEGAL; peste ea nu se ordonanțează, punct.
 *  - AVERTISMENT (nu blocaj): suma se încadrează în DF dar depășește DISPONIBILUL DIN
 *    RECEPȚII (`col.2 − (col.3+col.4)` de pe ultima ORD aprobată). Motivul pentru care
 *    NU blochează: recepțiile pot fi mai mici decât DF-ul pur și simplu fiindcă
 *    responsabilul CAB nu a înregistrat încă recepția în sistemul CAB — și o poate face
 *    imediat după. Frontendul afișează AMBELE cifre, ca omul să știe ce ignoră.
 *
 * ⛔ Poarta de la `noua-lichidare` (creditele bugetare col.10, per an de exercițiu) e o
 * verificare SEPARATĂ și rămâne exact cum e. Aici se ADAUGĂ, nu se înlocuiește.
 *
 * @returns {Promise<{blocat:boolean, avertisment:boolean, suma:number,
 *                    df_valoare:number|null, ordonantat:number,
 *                    disponibil_df:number|null, disponibil_receptii:number|null}>}
 */
export async function verificaPlafonOrdonantare({ alopId, orgId, suma, excludeOrdId, dfId }, db = pool) {
  const s = Number(suma) || 0;
  const out = {
    blocat: false, avertisment: false, suma: s,
    df_valoare: null, ordonantat: 0, disponibil_df: null, disponibil_receptii: null,
  };
  if (!alopId) return out;

  const { rows: alopRows } = await db.query(
    `SELECT a.id, a.ord_id, a.df_id,
            (SELECT COALESCE(SUM((r->>'valt_actualiz')::numeric),0)
               FROM formulare_df df
               LEFT JOIN jsonb_array_elements(COALESCE(df.rows_val,'[]'::jsonb)) r ON true
              WHERE df.id = COALESCE($3::uuid, a.df_id)) AS df_valoare
       FROM alop_instances a
      WHERE a.id=$1 AND a.org_id=$2 AND a.cancelled_at IS NULL`,
    [alopId, orgId, dfId || null]
  );
  if (!alopRows[0]) return out;

  const dfVal = alopRows[0].df_valoare == null ? null : parseFloat(alopRows[0].df_valoare);
  // ⚠️ ORD-ul pentru care verificăm NU intră în cumul (altfel s-ar număra de două ori:
  // o dată din `rows`-ul lui salvat, o dată din `suma` primită).
  const ordIdCurent = (excludeOrdId && String(excludeOrdId) === String(alopRows[0].ord_id))
    ? null : alopRows[0].ord_id;
  const { total: ordonantat } = await sumaOrdonantataDosar(
    alopId, { orgId, anExercitiu: null, ordIdCurent }, db
  );
  out.ordonantat = ordonantat;
  out.df_valoare = dfVal;

  if (dfVal != null && dfVal > 0) {
    out.disponibil_df = dfVal - ordonantat;
    if (s > out.disponibil_df + 0.001) out.blocat = true;
  }

  const dispRec = await disponibilDinReceptii(alopId, orgId, { excludeOrdId }, db);
  out.disponibil_receptii = dispRec;
  if (!out.blocat && dispRec != null && s > dispRec + 0.001) out.avertisment = true;

  return out;
}
