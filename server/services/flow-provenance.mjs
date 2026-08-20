/**
 * DocFlowAI — flow-provenance.mjs  (P0-03, audit extern v3.9.746)
 * ---------------------------------------------------------------
 * Poarta de PROVENIENȚĂ a fluxului de semnare pentru dosarele ALOP.
 *
 * Constatarea P0-03: `link-df-flow` / `link-ord-flow` scriau `df_flow_id`/`ord_flow_id`
 * primit de la client FĂRĂ nicio validare (existență, organizație, stare, proveniență),
 * iar `df-completed` / `ord-completed` cereau doar „pointerul e non-NULL". Rezultat: un
 * utilizator autorizat pe ALOP putea avansa dosarul angajare→…→plata FĂRĂ niciun document
 * semnat. Nu e exploit neautentificat — e risc de integritate financiară (insider).
 *
 * ⛔ ZERO scrieri. Modulul DECIDE (întoarce `{ok}` sau `{ok:false,status,body}`), nu mutează
 * nimic; rutele aplică decizia. Fail-CLOSED peste tot: orice ramură neacoperită = refuz.
 *
 * Predicatele SQL `liveFlowSql` / `validSignedFlowSql` sunt definite AICI ca SURSĂ UNICĂ
 * și re-exportate — `flow-link-audit.mjs` (#120) le importă de aici. Două definiții ale
 * aceluiași predicat = drift garantat.
 */

// Fragment SQL: un flux e „valid semnat" (revendicabil ca sursă de adevăr) dacă
// e nețters, ne-anulat, ne-refuzat ȘI marcat finalizat.
export function validSignedFlowSql(alias = 'f') {
  return `${alias}.deleted_at IS NULL
      AND ${alias}.data->>'status' IS DISTINCT FROM 'cancelled'
      AND ${alias}.data->>'status' IS DISTINCT FROM 'refused'
      AND (${alias}.data->>'status' = 'completed' OR (${alias}.data->>'completed')::boolean = true)`;
}

// Fragment SQL: un flux e „viu" (revendică activ documentul, dar poate să nu fie
// încă semnat). Exclude nețters + ne-anulat + ne-refuzat. Un flux `completed` E viu
// aici (e un flux real). Excluderea `refused` NU e în specul PAS 1 (care spune doar
// „necancelate"), dar e NECESARĂ pentru clasa D: fără ea, o reinițiere legitimă după
// refuz (flux vechi refuzat + flux nou activ, ambele cu același meta.dfId) ar apărea
// permanent ca „fluxuri paralele" → cardul n-ar ajunge niciodată la 0.
export function liveFlowSql(alias = 'f') {
  return `${alias}.deleted_at IS NULL
      AND ${alias}.data->>'status' IS DISTINCT FROM 'cancelled'
      AND ${alias}.data->>'status' IS DISTINCT FROM 'refused'`;
}

// ── Config per tip de document ───────────────────────────────────────────────
const KINDS = {
  df: {
    metaKey: 'dfId',
    alopDocCol: 'df_id',
    alopFlowCol: 'df_flow_id',
    table: 'formulare_df',
    eticheta: 'Documentul de Fundamentare',
    // #134f — `alop.df_id` e acum „revizia ÎN VIGOARE" (ultima aprobată), deci fluxul
    // lansat pentru R(n+1) revendică o ALTĂ revizie decât cea pointată. Calea de
    // proveniență (b) trebuie să se execute ȘI când `df_id` e non-NULL.
    // ⛔ Doar pentru `df`: ORD-ul nu are revizii, iar ORD-urile ciclurilor ARHIVATE poartă
    // același `source_alop_id` — relaxarea acolo ar permite ca fluxul unui ORD vechi să
    // fie legat ca flux ORD curent.
    provenientaFaraDirect: true,
  },
  ord: {
    metaKey: 'ordId',
    alopDocCol: 'ord_id',
    alopFlowCol: 'ord_flow_id',
    table: 'formulare_ord',
    eticheta: 'Ordonanțarea de plată',
  },
};

const refuz = (status, error, message) => ({ ok: false, status, body: { error, message } });
const OK = { ok: true };

/**
 * Fluxul (identificat prin `metaDocId` = data->'meta'->>'dfId'/'ordId') revendică
 * DOCUMENTUL acestui ALOP?
 *
 * Două căi acceptate:
 *  (a) directă — `meta.dfId` === `alop.df_id`;
 *  (b) proveniență — documentul revendicat de flux APARȚINE DOSARULUI ALOP-ului, adică
 *      poartă `source_alop_id = alop.id` (oglindește `selfHealAlopDfLinkByAlop`,
 *      alop-link.mjs). Acoperă două situații:
 *        • ALOP încă fără document legat (`df_id` NULL) — calea cloud „Fără DF"
 *          (incident 04.08, DF 417); disponibilă pentru AMBELE tipuri;
 *        • #134f — `df_id` non-NULL, dar fluxul revendică o ALTĂ REVIZIE a aceluiași
 *          dosar (pointerul stă pe revizia în vigoare cât timp R(n+1) e în lucru).
 *          Disponibilă DOAR pentru tipurile cu `provenientaFaraDirect` (azi: `df`).
 *      ⛔ Predicatul rămâne apartenența la dosar (`source_alop_id` + `org_id` +
 *      `deleted_at IS NULL`). NICIUN fallback pe `nr_unic_inreg`: numărul e partajat
 *      între dosare (docs/incidents/DF-NR-DUPLICAT.md) ⇒ ar fi o poartă mai slabă.
 *
 * @returns {Promise<boolean>} — fail-closed: false la orice date insuficiente.
 */
async function claimsAlopDocument(pool, { cfg, alop, orgId, metaDocId }) {
  const alopDocId = alop?.[cfg.alopDocCol];

  if (alopDocId != null && metaDocId != null && String(metaDocId) === String(alopDocId)) return true;

  // Calea (b) — apartenența la dosar. Când ALOP-ul are deja un document legat, ea se
  // deschide DOAR pentru tipurile marcate `provenientaFaraDirect` (vezi KINDS).
  const provenientaPermisa = alopDocId == null || cfg.provenientaFaraDirect === true;
  if (provenientaPermisa && metaDocId != null && alop?.id != null) {
    const { rows } = await pool.query(
      `SELECT 1 FROM ${cfg.table}
        WHERE id::text = $1 AND source_alop_id = $2 AND org_id = $3 AND deleted_at IS NULL
        LIMIT 1`,
      [String(metaDocId), alop.id, orgId]
    );
    if (rows[0]) return true;
  }

  return false;
}

/**
 * Poate fi legat fluxul `flowId` de ALOP-ul dat, ca flux de `kind`?
 * PUR ca decizie (nu scrie nimic), dar interoghează DB (primește pool).
 *
 * @param {import('pg').Pool} pool
 * @param {{ flowId:any, kind:'df'|'ord', alop:object, orgId:number|string }} args
 *   `alop` = rândul deja încărcat în rută; trebuie să conțină `id`, `df_id`, `ord_id`.
 * @returns {Promise<{ok:true} | {ok:false, status:number, body:object}>}
 */
export async function checkFlowLinkable(pool, { flowId, kind, alop, orgId } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) return refuz(400, 'kind_invalid', 'Tip de document necunoscut.');

  // 1. flowId gol / non-string → refuz FĂRĂ să atingem DB-ul.
  if (!flowId || typeof flowId !== 'string') {
    return refuz(400, 'flow_id_invalid', 'Identificatorul fluxului de semnare lipsește sau este invalid.');
  }
  if (!pool || !alop || orgId == null) {
    return refuz(403, 'flow_alt_org', 'Fluxul de semnare nu poate fi verificat pentru instituția dumneavoastră.');
  }

  const { rows } = await pool.query(
    `SELECT f.id,
            (f.org_id::text = $2::text OR f.data->>'orgId' = $2::text) AS same_org,
            (${liveFlowSql('f')})                                      AS live,
            f.data->'meta'->>'${cfg.metaKey}'                          AS meta_doc_id
       FROM flows f
      WHERE f.id = $1`,
    [flowId, String(orgId)]
  );

  // 2. fluxul nu există.
  const f = rows[0];
  if (!f) return refuz(404, 'flow_inexistent', 'Fluxul de semnare indicat nu există.');

  // 3. organizație diferită (NULL pe ambele surse ⇒ REFUZ, fail-closed).
  if (f.same_org !== true) {
    return refuz(403, 'flow_alt_org', 'Fluxul de semnare aparține altei instituții.');
  }

  // 4. fluxul nu e „viu" (șters / anulat / refuzat).
  if (f.live !== true) {
    return refuz(409, 'flux_anulat_sau_refuzat',
      'Fluxul de semnare este anulat, refuzat sau șters. Nu poate fi legat de acest dosar.');
  }

  // 5. proveniență — fluxul trebuie să revendice documentul acestui ALOP.
  const claims = await claimsAlopDocument(pool, { cfg, alop, orgId, metaDocId: f.meta_doc_id });
  if (!claims) {
    return refuz(403, 'flux_alt_document',
      'Fluxul de semnare aparține altui document. Nu poate fi legat de acest dosar.');
  }

  return OK;
}

/**
 * ALOP-ul are DOVADA semnării pentru faza `kind`? (poarta pentru df-completed/ord-completed)
 *
 * @param {import('pg').Pool} pool
 * @param {{ kind:'df'|'ord', alop:object, orgId:number|string }} args
 *   `alop` trebuie să conțină `id`, `df_id`/`ord_id` ȘI `df_flow_id`/`ord_flow_id`.
 * @returns {Promise<{ok:true} | {ok:false, status:number, body:object}>}
 */
export async function checkFlowSigned(pool, { kind, alop, orgId } = {}) {
  const cfg = KINDS[kind];
  if (!cfg) return refuz(400, 'kind_invalid', 'Tip de document necunoscut.');

  const NESEMNAT = () => refuz(409, 'document_nesemnat',
    'Fluxul de semnare nu este finalizat. Dosarul nu poate avansa fără documentul semnat.');

  const flowId = alop?.[cfg.alopFlowCol];
  if (!flowId) {
    return refuz(400, 'flux_lipsa',
      `${cfg.eticheta} nu are un flux de semnare legat. Lansați documentul la semnat mai întâi.`);
  }
  if (!pool || orgId == null) return NESEMNAT();

  const { rows } = await pool.query(
    `SELECT (${validSignedFlowSql('f')})            AS semnat,
            f.data->'meta'->>'${cfg.metaKey}'       AS meta_doc_id
       FROM flows f
      WHERE f.id = $1`,
    [String(flowId)]
  );

  // Flux inexistent sau nefinalizat / anulat / refuzat / șters ⇒ fără dovadă.
  const f = rows[0];
  if (!f || f.semnat !== true) return NESEMNAT();

  // Proveniență: același cod de eroare — nu divulgăm structura internă.
  const claims = await claimsAlopDocument(pool, { cfg, alop, orgId, metaDocId: f.meta_doc_id });
  if (!claims) return NESEMNAT();

  return OK;
}
