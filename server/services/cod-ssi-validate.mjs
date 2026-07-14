/**
 * DocFlowAI — server/services/cod-ssi-validate.mjs
 *
 * Validează codurile SSI dintr-un DF împotriva bugetului Clasa 8 al organizației.
 *
 * Context (incident 13.07.2026): câmpul „Cod SSI" din DF e un <datalist> — doar
 * sugestie. Fără validare server-side, un cod inventat (o cifră în plus, un caracter
 * lipsă) putea ajunge pe un DF semnat cu QES și exportat XML către Ministerul
 * Finanțelor. Acesta e SINGURA sursă de adevăr; frontend-ul doar avertizează.
 *
 * ⛔ DOUĂ ortografii ale cheii JSONB — `cod_SSI` (snake_case, Sec.B rows_ctrl) ȘI
 *    `codSSI` (camelCase, Sec.A rows_val + rows_plati). Helperul unic `_rowCodSsi`
 *    acoperă AMBELE. O validare care prinde doar una lasă cealaltă să treacă.
 *
 * ⛔ FĂRĂ CACHE — bugetul se poate reimporta oricând; un cache ar accepta coduri
 *    tocmai șterse. E o validare, nu o listă de sugestii.
 *
 * ⛔ Comparație EXACTĂ, case-sensitive, după trim(). Fără ILIKE, fără prefixe.
 *
 * Sursa validă: `clasa8_buget` (org_id, cod_ssi). Deși importurile sunt versionate
 * (`clasa8_buget_versions`), tabela `clasa8_buget` ține DOAR versiunea ACTIVĂ —
 * `POST /api/clasa8/buget/import` face `DELETE FROM clasa8_buget WHERE org_id` apoi
 * re-inserează rândurile noii versiuni. Deci un simplu `SELECT ... WHERE org_id`
 * întoarce exact universul activ de coduri; nu e nevoie de filtru pe version_id.
 */

/** Extrage codul SSI dintr-un rând, tolerant la ambele ortografii. */
export const _rowCodSsi = (r) => String(r?.cod_SSI ?? r?.codSSI ?? '').trim();

// Tabelele de rânduri din DF care poartă Cod SSI (inventar 13.07.2026):
//   rows_val   — Sec.A tabel 1 (angajament)     → cheia `codSSI`
//   rows_plati — Sec.A tabel 2 (plăți estimate)  → cheia `codSSI`
//   rows_ctrl  — Sec.B CAB (credite bugetare)    → cheia `cod_SSI`
const SSI_ROW_FIELDS = ['rows_val', 'rows_plati', 'rows_ctrl'];

/** Normalizează o valoare JSONB (array JS sau string) la un array. */
function _asRows(v) {
  if (Array.isArray(v)) return v;
  if (typeof v === 'string' && v.trim()) {
    try { const p = JSON.parse(v); return Array.isArray(p) ? p : []; } catch { return []; }
  }
  return [];
}

/**
 * Validează codurile SSI dintr-un DF (sau dintr-un fragment de body) împotriva
 * bugetului Clasa 8 al organizației.
 *
 * @param {object} pool  - PostgreSQL pool
 * @param {number} orgId - ID organizație (izolare multi-tenant, obligatoriu)
 * @param {object} dfData - obiect cu una sau mai multe din cheile rows_val /
 *                          rows_plati / rows_ctrl (array-uri de rânduri). Doar
 *                          câmpurile PREZENTE se validează (ex. la PUT P2 = doar rows_ctrl).
 * @returns {Promise<{ ok: boolean, invalid: Array<{tabel,index,cod}>, bugetGol: boolean }>}
 *
 * ⚡ Iese ÎNAINTE de orice query DB dacă nu există niciun cod ne-gol de validat —
 *    rândurile cu cod gol sunt VALIDE (nu toate rândurile cer cod SSI). Această
 *    proprietate păstrează intacte testele mock cu `pool.query` poziţional.
 */
export async function validateCodSsi(pool, orgId, dfData) {
  const found = []; // { tabel, index, cod } — doar coduri ne-goale
  for (const field of SSI_ROW_FIELDS) {
    if (!dfData || !(field in dfData)) continue;
    _asRows(dfData[field]).forEach((r, i) => {
      const cod = _rowCodSsi(r);
      if (cod) found.push({ tabel: field, index: i, cod });
    });
  }

  // Niciun cod de validat ⇒ valid. NU atingem DB (rândurile goale nu se blochează).
  if (found.length === 0) return { ok: true, invalid: [], bugetGol: false };

  const { rows } = await pool.query(
    'SELECT cod_ssi FROM clasa8_buget WHERE org_id = $1',
    [orgId]
  );

  // Buget neimportat ⇒ blocare (fail-CLOSED, fără excepții pe module).
  if (rows.length === 0) return { ok: false, invalid: [], bugetGol: true };

  const valid = new Set(rows.map(r => String(r.cod_ssi).trim()));
  const invalid = found.filter(f => !valid.has(f.cod));
  return { ok: invalid.length === 0, invalid, bugetGol: false };
}

/**
 * Traduce rezultatul `validateCodSsi` într-un răspuns HTTP `{ status, body }` sau
 * `null` dacă totul e valid. Refolosit de rutele DF (PUT direct + lifecycle shared),
 * ca structura erorii să fie identică peste tot (frontend-ul evidențiază `invalid[]`).
 */
export async function codSsiBlockResponse(pool, orgId, dfData) {
  const check = await validateCodSsi(pool, orgId, dfData);
  if (check.bugetGol) {
    return { status: 400, body: {
      error: 'clasa8_neimportat',
      message: 'Bugetul Clasa 8 nu este importat. Importă bugetul înainte de a completa DF-uri.',
    } };
  }
  if (!check.ok) {
    const first = check.invalid[0];
    return { status: 400, body: {
      error: 'cod_ssi_invalid',
      message: `Cod SSI inexistent în bugetul Clasa 8: ${first.cod} (rândul ${first.index + 1}).`,
      invalid: check.invalid,
    } };
  }
  return null;
}
