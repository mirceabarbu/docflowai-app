/**
 * DocFlowAI — server/services/formular-shared.mjs
 *
 * Lifecycle DF/ORD consolidat, parametrizat pe `formType` ('df' | 'ord').
 *
 * Rutele din server/routes/formulare/ sunt wrappers subțiri peste aceste
 * funcții: `const r = await submitFormular(...); res.status(r.status).json(r.body)`.
 * Fiecare funcție întoarce `{ status, body }` — fără cuplare la `res`, ușor de testat.
 *
 * ⚠️ ASIMETRIILE DF↔ORD sunt INTENȚIONATE și probate în server/tests/db/caracterizare-*.
 * Trăiesc EXPLICIT în `FORMULAR_TYPES` (chei de config), NU în `if (ft==='ord')` îngropat.
 * NU le uniformiza. Orice buton/regulă nouă: adaugă o cheie aici + un test.
 */

import { pool } from '../db/index.mjs';
import { isPlatformAdmin } from './authz-scope.mjs';
import { logger } from '../middleware/logger.mjs';
import { recordFormularAudit } from '../db/queries/formulare-audit.mjs';
import { computeDocCapabilities } from './formular-capabilities.mjs';
import { loadActorComp, canEditFormular, canDestroyOnly } from './authz-formular.mjs';
import { crediteBugetareAnCurent } from './buget-an.mjs';
import { copyFormularAttachmentsToFlow } from './formular-flow-attachments.mjs';
import { codSsiBlockResponse } from './cod-ssi-validate.mjs';
import { normalizeAngajamentRows } from './angajament-normalize.mjs';

// ── helpers partajate (și de rutele create/PUT/capturi din server/routes/formulare/) ─────

/** Trimite notificare in-app corect (user_email + data JSONB) */
export async function sendNotif(userId, type, title, message, data) {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!rows.length) return;
    const ins = await pool.query(
      `INSERT INTO notifications (user_email, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, created_at`,
      [rows[0].email.toLowerCase(), type, title, message, JSON.stringify(data)]
    );
    return { id: ins.rows[0]?.id ?? null, created_at: ins.rows[0]?.created_at ?? null, email: rows[0].email.toLowerCase() };
  } catch (_) { /* non-fatal */ return null; }
}

export function pick(obj, fields) {
  const out = {};
  for (const f of fields) if (f in obj) out[f] = obj[f];
  return out;
}

export function buildUpdate(data, fields, startIdx = 1) {
  const sets = [];
  const vals = [];
  for (const f of fields) {
    if (!(f in data)) continue;
    vals.push(typeof data[f] === 'object' ? JSON.stringify(data[f]) : data[f]);
    sets.push(`${f}=$${startIdx + vals.length - 1}`);
  }
  return { sets, vals };
}

// SEC-100.2: cele 4 coloane de identitate ale ORD-ului sunt DERIVATE din DF, nu introduse.
// #100.1 le-a blocat în UI (readOnly) — dar un readOnly în DOM nu e un control de securitate.
// Aici serverul nu mai crede clientul: dacă ORD-ul are df_id, valorile vin din rows_ctrl.
// NU e validare: nu refuzăm nimic, nu ne uităm în clasa8_buget. Doar suprascriem.
export const ORD_IDENT_COLS = ['cod_angajament', 'indicator_angajament', 'program', 'cod_SSI'];

/**
 * @param {Array}  clientRows  rândurile din body (deja trecute prin normalizeAngajamentRows)
 * @param {Array}  ctrlRows    rows_ctrl al DF-ului legat
 * @returns {Array}            rândurile cu cele 4 coloane suprascrise din DF
 *
 * Corelare POZIȚIONALĂ — identică cu prefill-ul din onDfSelect (list.js:176).
 * Rândurile din ORD peste lungimea rows_ctrl (dacă apar) rămân NEATINSE: nu inventăm coduri.
 */
export function deriveOrdIdentityCols(clientRows, ctrlRows) {
  if (!Array.isArray(clientRows)) return clientRows;
  if (!Array.isArray(ctrlRows) || !ctrlRows.length) return clientRows;   // fără sursă ⇒ nu atingem
  return clientRows.map((row, i) => {
    const src = ctrlRows[i];
    if (!row || typeof row !== 'object' || Array.isArray(row)) return row;
    if (!src || typeof src !== 'object') return row;
    const out = { ...row };
    for (const k of ORD_IDENT_COLS) out[k] = src[k] ?? null;
    return out;
  });
}

// ── definiții de câmpuri (schema P1/P2 per tip) ──────────────────────────────────

/** Câmpuri DF sectiunea A (P1) */
export const DF_P1_FIELDS = [
  'cif','den_inst_pb','subtitlu_df','nr_unic_inreg','revizuirea','data_revizuirii',
  'compartiment_specialitate','obiect_fd_reviz_scurt','obiect_fd_reviz_lung',
  'ckbx_oblig_tert',
  'ckbx_stab_tin_cont','ckbx_ramane_suma','ramane_suma','rows_val',
  'ckbx_fara_ang_emis_ancrt','ckbx_cu_ang_emis_ancrt','ckbx_sting_ang_in_ancrt',
  'ckbx_fara_plati_ang_in_ancrt','ckbx_cu_plati_ang_in_mmani',
  'ckbx_ang_leg_emise_ct_an_urm','rows_plati',
  // FEATURE buget multi-anual (v3.9.558): an absolut care ancorează banda `ancrt` din
  // rows_plati. Editabil de P1 la creare; la REVIZIE se moștenește din părinte (copiat în
  // INSERT-ul din df.mjs /revizuieste, NU re-trimis din frontend). Vezi services/buget-an.mjs.
  'an_referinta',
];

/** Câmpuri DF sectiunea B (P2) */
export const DF_P2_FIELDS = [
  'ckbx_secta_inreg_ctrl_ang','ckbx_fara_inreg_ctrl_ang','sum_fara_inreg_ctrl_crdbug','sum_fara_inreg_ctrl_crd_bug',
  'ckbx_interzis_emit_ang','ckbx_interzis_intrucat','intrucat','rows_ctrl',
];

// v3.9.499: img2 ELIMINAT — captura 2 migrată la formulare_capturi(slot=2)
// via endpoint dedicat /api/formulare-capturi/ord/:id?slot=2. Coloana img2
// rămâne în DB pentru fallback citire ord-uri vechi (vezi populateOrd).
export const ORD_P1_FIELDS = [
  'cif','den_inst_pb','nr_ordonant_pl','data_ordont_pl',
  'nr_unic_inreg','beneficiar','documente_justificative',
  'iban_beneficiar','cif_beneficiar','banca_beneficiar',
  'inf_pv_plata','inf_pv_plata1','rows','compartiment_specialitate',
];

/** Câmpuri ORD P2 (actualizare rânduri cu receptii/plati/receptii_neplatite) */
export const ORD_P2_FIELDS = ['rows'];

// ── config per tip — discriminatori EXPLICIȚI ───────────────────────────────────

export const FORMULAR_TYPES = {
  df: {
    table: 'formulare_df',
    capsFt: 'notafd',
    p2Fields: DF_P2_FIELDS,
    submitStatuses: ['draft', 'returnat', 'de_revizuit'],
    budgetCheck: 'none',              // DF: buget = soft-warning DOAR în frontend (by design)
    // ASIMETRIE (incident 13.07.2026): DF validează HARD codurile SSI din rows_val/rows_plati/
    // rows_ctrl împotriva bugetului Clasa 8 (blocare la submit/complete/link-flow, 400). ORD are
    // cod SSI în `rows`, dar validarea NU s-a extins la ORD în această iterație (scope owner).
    codSsiValidate: true,
    alopOnComplete: 'df_angajare',    // DF complete → alop_instances draft→angajare + legat_alop
    alopMatchCol: 'df_id',            // coloana ALOP de match pe acest tip
    alopFlowField: 'df_flow_id',      // coloana ALOP de flux sincronizată la link-flow
    nrField: 'nr_unic_inreg',
    // link-flow (ASIMETRIE): DF setează status='transmis_flux' + toStatus în audit; ORD nu.
    linkFlowSetsStatus: 'transmis_flux',
    linkFlowSelectCols: '*',          // ASIMETRIE: DF SELECT * (vezi ORD — afectează authz p2_comp)
    alreadyOnFlowError: 'df_already_on_active_flow',
    alreadyOnFlowMessage: 'Documentul este deja pe un flux de semnare activ. Anulați fluxul curent înainte de a-l retrimite.',
    // sterge (POST /sterge): DF blochează dacă există ORD legată + relink conștient de revizii.
    stergeSelectCols: 'created_by, org_id, status, flow_id, revizie_nr, parent_df_id, nr_unic_inreg',
    deleteHasOrdCheck: true,
    deleteOnFlowMessage: 'Documentul a fost trimis pe fluxul de semnare și nu poate fi șters.',
    relinkOnDelete: 'df_revision_aware',
    notif: {
      submit: {
        type: 'formulare_df_p2',
        title: 'Document de Fundamentare — completare solicitată',
        message: (actor, doc) => `${actor.nume || actor.email} vă solicită completarea Secțiunii B din DF "${doc.nr_unic_inreg || 'fără număr'}"`,
      },
      complete: {
        type: 'formulare_df_completed',
        title: 'Document de Fundamentare — completat de Responsabil CAB',
        message: (actor, doc) => `${actor.nume || actor.email} a completat Secțiunea B din DF "${doc.nr_unic_inreg || 'fără număr'}"`,
      },
      returneaza: {
        type: 'formulare_df_returnat',
        title: 'Document de Fundamentare — returnat ca neconform',
        message: (actor, doc) => `${actor.nume || actor.email} a returnat DF "${doc.nr_unic_inreg || 'fără număr'}" cu observații`,
      },
    },
  },
  ord: {
    table: 'formulare_ord',
    capsFt: 'ordnt',
    p2Fields: ORD_P2_FIELDS,
    submitStatuses: ['draft', 'returnat'],   // ASIMETRIE: fără 'de_revizuit'
    budgetCheck: 'hard_col5',                // ORD: validare hard col.5 ≥ 0 → 422
    codSsiValidate: false,                   // ASIMETRIE: validarea Cod SSI vs Clasa 8 nu s-a extins la ORD

    alopOnComplete: null,                    // ORD complete NU atinge ALOP
    alopMatchCol: 'ord_id',
    alopFlowField: 'ord_flow_id',
    nrField: 'nr_ordonant_pl',
    linkFlowSetsStatus: null,                // ASIMETRIE: ORD NU schimbă status la link-flow
    linkFlowSelectCols: 'created_by, status, flow_id',  // ASIMETRIE: NU expune assigned_to (authz p2_comp)
    alreadyOnFlowError: 'ord_already_on_active_flow',
    alreadyOnFlowMessage: 'Ordonanțarea este deja pe un flux de semnare activ. Anulați fluxul curent înainte de a o retrimite.',
    stergeSelectCols: 'created_by, org_id, status, flow_id',
    deleteHasOrdCheck: false,
    deleteOnFlowMessage: 'Ordonanțarea a fost trimisă pe fluxul de semnare și nu poate fi ștearsă.',
    relinkOnDelete: 'ord_simple',
    notif: {
      submit: {
        type: 'formulare_ord_p2',
        title: 'Ordonanțare de Plată — completare solicitată',
        message: (actor, doc) => `${actor.nume || actor.email} vă solicită completarea ORD "${doc.nr_ordonant_pl || 'fără număr'}"`,
      },
      complete: {
        type: 'formulare_ord_completed',
        title: 'Ordonanțare de Plată — completată de Responsabil CAB',
        message: (actor, doc) => `${actor.nume || actor.email} a completat ORD "${doc.nr_ordonant_pl || 'fără număr'}"`,
      },
      returneaza: {
        type: 'formulare_ord_returnat',
        title: 'Ordonanțare de Plată — returnată ca neconformă',
        message: (actor, doc) => `${actor.nume || actor.email} a returnat ORD "${doc.nr_ordonant_pl || 'fără număr'}" cu observații`,
      },
    },
  },
};

// ── validare buget ORD (col.5 ≥ 0) — gated de cfg.budgetCheck === 'hard_col5' ─────
// Formula: c5 = c2(recepții) - c3(plăți anterioare) - c4(suma ordonanțată)
// Defense-in-depth: backend respinge chiar dacă frontend e bypass-at.
// Întoarce `{ status, body }` dacă există rânduri invalide, altfel `null`.
function validateOrdCol5(rows) {
  if (!Array.isArray(rows)) return null;
  const _num = v => {
    if (v === null || v === undefined || v === '') return 0;
    // getOR() (core.js) trimite valorile ca String(pMR(...)) — număr JS normalizat
    // (punct zecimal, fără separator de mii), ex: "1234.56" / "1500". NU format RO.
    const n = Number(String(v).trim().replace(/\s/g,''));
    return isNaN(n) ? 0 : n;
  };
  const bad = [];
  rows.forEach((r, i) => {
    const c2 = _num(r.receptii);
    const c3 = _num(r.plati_anterioare);
    const c4 = _num(r.suma_ordonantata_plata);
    const c5 = c2 - c3 - c4;
    if (c5 < -0.001) bad.push({ idx: i + 1, c5: c5.toFixed(2) });
  });
  if (bad.length) {
    return { status: 422, body: {
      error: 'receptii_neplatite_negative',
      message: 'Coloana 5 (Recepții neplătite) trebuie să fie ≥ 0 pe fiecare rând. Suma ordonanțată depășește disponibilul.',
      rows: bad,
    } };
  }
  return null;
}

// ── plafon hard: suma ordonanțată cumulată în anul de exercițiu ≤ CREDITELE BUGETARE (col.10) ─
// (v3.9.557 FIX B → v3.9.558 buget multi-anual → fix 12, v3.9.582) Regula de business
// (confirmată de owner): ordonanțarea/plata se poate face DOAR în limita CREDITELOR BUGETARE
// ale anului curent = SUMĂ peste `rows_ctrl` din `sum_rezv_crdt_bug_act` (col.10 „10=8+9",
// Secțiunea B CAB) al DF-ului legat (revizia activă, via ord.df_id), NU în limita benzii
// `rows_plati` (aceea rămâne baza CARDULUI), NU a angajamentului total (rows_val.valt_actualiz),
// NU a creditelor de angajament (col.7). Plafonul col.10 se aplică INDIFERENT de bifa
// „Stingere" (când Stingere e bifat banda `rows_plati` an curent = 0, dar col.10 rămâne).
// Depășirea = blocaj hard 422, simetric cu col.5.
//
// SE SCAD ORDONANȚĂRILE ANTERIOARE, NU PLĂȚILE (distincție critică, owner): cumulul =
// suma ORD-ului CURENT (data.rows noi — evită dubla numărare) PLUS suma ORDONANȚATĂ a
// ciclurilor arhivate (alop_ord_cicluri → JOIN ord_id → SUM(formulare_ord.rows.suma_ordonantata_plata),
// fiindcă ciclul NU stochează direct suma ordonanțată), FILTRATE pe anul de exercițiu.
//
// AN DE EXERCIȚIU: `EXTRACT(YEAR FROM NOW())`. CUMUL PER AN: o ordonanțare făcută în 2026
// consumă bugetul 2026, nu pe cel din 2027 — `an_exercitiu` (mig. 086) cu fallback derivat
// din `plata_data` apoi `created_at` pentru ciclurile istorice.
//
// ── helper PARITATE (read-only) — context de buget pentru un DF legat ────────────
// SURSĂ UNICĂ de adevăr pentru plafonul ORD: o folosesc ȘI validateOrdBugetAnCurent
// (decizia hard la finalizare/submit) ȘI rutele GET care alimentează atenționarea inline
// din UI (P1 + P2). Frontend-ul primește plafonul rezolvat ca `bugetAnCurent` (col.10) +
// `cicluriArhivate` (ordonanțat arhivat) per an de exercițiu.
//
// Întoarce `{ anExercitiu, bugetAnCurent, cicluriArhivate }`, sau `null` dacă nu există
// `dfId` ori DF-ul nu există (nimic de plafonat).
export async function computeOrdBudgetContext({ dfId, orgId }) {
  if (!dfId) return null;
  const anExercitiu = new Date().getFullYear();
  const { rows } = await pool.query(
    `SELECT
       df.rows_ctrl,
       COALESCE((
         SELECT SUM(co.s)
         FROM alop_ord_cicluri c
         JOIN alop_instances a ON a.id = c.alop_id
         CROSS JOIN LATERAL (
           SELECT COALESCE(SUM((r->>'suma_ordonantata_plata')::numeric),0) AS s
           FROM formulare_ord fo
           LEFT JOIN jsonb_array_elements(COALESCE(fo.rows,'[]'::jsonb)) r ON true
           WHERE fo.id = c.ord_id
         ) co
         WHERE a.df_id = df.id AND a.org_id = $2 AND a.cancelled_at IS NULL
           AND COALESCE(
                 c.an_exercitiu,
                 EXTRACT(YEAR FROM c.plata_data)::int,
                 EXTRACT(YEAR FROM c.created_at)::int
               ) = $3
       ), 0) AS cicluri_arhivate
     FROM formulare_df df
     WHERE df.id = $1`,
    [dfId, orgId, anExercitiu]
  );
  if (!rows.length) return null; // DF inexistent — nimic de verificat

  const bugetAnCurent = crediteBugetareAnCurent(rows[0].rows_ctrl) || 0;
  const cicluriArhivate = parseFloat(rows[0].cicluri_arhivate || 0);
  return { anExercitiu, bugetAnCurent, cicluriArhivate };
}

// Întoarce `{ status, body }` la depășire, altfel `null`. Skip (null) dacă ORD-ul nu are
// `df_id` — fără DF legat nu există buget de verificat.
async function validateOrdBugetAnCurent({ ordDoc, newRows, orgId }) {
  if (!ordDoc || !ordDoc.df_id) return null;
  const _num = v => {
    if (v === null || v === undefined || v === '') return 0;
    const n = Number(String(v).trim().replace(/\s/g, ''));
    return isNaN(n) ? 0 : n;
  };
  const ctx = await computeOrdBudgetContext({ dfId: ordDoc.df_id, orgId });
  if (!ctx) return null; // DF inexistent — nimic de verificat
  const { anExercitiu, bugetAnCurent, cicluriArhivate } = ctx;
  const ordCurentNou = (Array.isArray(newRows) ? newRows : [])
    .reduce((s, r) => s + _num(r && r.suma_ordonantata_plata), 0);
  const ordonantatCumulat = ordCurentNou + cicluriArhivate;

  if (ordonantatCumulat > bugetAnCurent + 0.001) {
    return { status: 422, body: {
      error: 'buget_an_curent_depasit',
      message: `Suma ordonanțată în anul de exercițiu ${anExercitiu} (${ordonantatCumulat.toFixed(2)} RON) depășește creditele bugetare ale anului ${anExercitiu} (${bugetAnCurent.toFixed(2)} RON).`,
      anExercitiu,
      bugetAnCurent,
      ordonantat: ordonantatCumulat,
    } };
  }
  return null;
}

// ─────────────────────────────────────────────────────────────────────────────
// LIFECYCLE
// ─────────────────────────────────────────────────────────────────────────────

/** P1 trimite documentul la P2 (submit). */
export async function submitFormular({ type, id, actor, body }) {
  const cfg = FORMULAR_TYPES[type];
  try {
    const { assigned_to } = body || {};
    if (!assigned_to) return { status: 400, body: { error: 'assigned_to obligatoriu' } };

    const { rows: existing } = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return { status: 404, body: { error: 'not_found' } };
    const doc = existing[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: false });
      if (!authz.allowed) return { status: 403, body: { error: authz.reason } };
    }
    if (!cfg.submitStatuses.includes(doc.status))
      return { status: 409, body: { error: 'document_not_draft', status: doc.status } };

    // GARDĂ Cod SSI (DF): nu trimite la P2 un DF cu cod inexistent în Clasa 8 (validăm
    // rândurile DEJA salvate, doc.*). Gated de cfg.codSsiValidate (DF=true, ORD=false).
    if (cfg.codSsiValidate) {
      const block = await codSsiBlockResponse(pool, actor.orgId, doc);
      if (block) return block;
    }

    // GARDĂ BUGET LA P1 (Varianta A, owner): depășirea plafonului de buget blochează HARD
    // trimiterea la P2. Rulează ÎNAINTE de UPDATE-ul de status, pe rândurile DEJA salvate
    // (autosave): `doc.rows`, NU body. Gated de cfg.budgetCheck (DF='none' → sare; ORD='hard_col5').
    //
    // ⚠️ DOAR plafonul de buget la P1 — NU `validateOrdCol5`. Motiv (owner + cod): col.5 =
    // receptii(col.2) − plati_anterioare(col.3) − suma_ordonantata(col.4); `receptii` e completată
    // de P2, nu de P1. La P1 `receptii=0` ⇒ c5 ar deveni negativ de îndată ce P1 pune o sumă și ar
    // bloca FALS trimiterea. col.5 rămâne STRICT la P2 (garda din completeFormular, neschimbată).
    if (cfg.budgetCheck === 'hard_col5') {
      const overBudget = await validateOrdBugetAnCurent({ ordDoc: doc, newRows: doc.rows, orgId: actor.orgId });
      if (overBudget) return overBudget;
    }

    // Verifică că P2 e din același org
    const { rows: p2rows } = await pool.query(
      'SELECT id, email, nume FROM users WHERE id=$1 AND org_id=$2', [assigned_to, actor.orgId]
    );
    if (!p2rows.length) return { status: 400, body: { error: 'utilizator_invalid' } };
    const p2 = p2rows[0];

    const { rows: updated } = await pool.query(`
      UPDATE ${cfg.table}
      SET status='pending_p2', assigned_to=$1, submitted_at=NOW(), updated_at=NOW(), motiv_returnare=NULL, updated_by=$4
      WHERE id=$2 AND org_id=$3
      RETURNING *
    `, [assigned_to, id, actor.orgId, actor.userId]);

    await sendNotif(assigned_to, cfg.notif.submit.type, cfg.notif.submit.title,
      cfg.notif.submit.message(actor, doc), { form_type: type, form_id: id });

    logger.info({ id, p2: p2.email, actor: actor.email }, `formulare-${type} trimis la P2`);
    await recordFormularAudit({ orgId: actor.orgId, formType: type, formId: id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'trimis_p2',
      fromStatus: doc.status, toStatus: 'pending_p2', meta: { assigned_to } });
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, cfg.capsFt);
    return { status: 200, body: { ok: true, document: updated[0], assigned_to: p2 } };
  } catch (e) {
    logger.error({ err: e }, `formulare-${type} submit error`);
    return { status: 500, body: { error: 'server_error' } };
  }
}

/** P2 finalizează secțiunea B (complete). */
export async function completeFormular({ type, id, actor, body }) {
  const cfg = FORMULAR_TYPES[type];
  try {
    const { rows: existing } = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return { status: 404, body: { error: 'not_found' } };
    const doc = existing[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true });
      // P2-side: admin / assigned (direct sau ca rol) / p2_comp.
      // Verificarea directă assigned_to acoperă cazul în care actorul e simultan
      // creator ȘI assigned_to (helper-ul prioritizează rolul 'creator').
      const isP2Side = authz.allowed
        && (['admin','assigned','p2_comp'].includes(authz.role) || doc.assigned_to === actor.userId);
      if (!isP2Side) return { status: 403, body: { error: 'forbidden' } };
    }
    if (doc.status !== 'pending_p2')
      return { status: 409, body: { error: 'status_invalid', status: doc.status } };

    const data = pick(body || {}, cfg.p2Fields);

    // Coduri de angajament canonice cu MAJUSCULE (repară potrivirea OPME —
    // services/angajament-normalize.mjs). DF scrie `rows_ctrl` (P2), ORD scrie `rows` (P2);
    // ORD.rows e câmpul efectiv potrivit de opme-matcher.mjs:127.
    if ('rows_ctrl' in data) data.rows_ctrl = normalizeAngajamentRows(data.rows_ctrl);
    if ('rows'      in data) data.rows      = normalizeAngajamentRows(data.rows);

    // GARDĂ Cod SSI (DF): finalizarea P2 e RESPINSĂ dacă rămâne un cod inexistent în Clasa 8.
    // Validăm starea EFECTIVĂ: rows_ctrl din body (editarea P2) + rows_val/rows_plati persistate
    // (P1). Gated de cfg.codSsiValidate. Escape pentru docul „cărămidă": P2 poate returna la P1.
    if (cfg.codSsiValidate) {
      const eff = {
        rows_val:   doc.rows_val,
        rows_plati: doc.rows_plati,
        rows_ctrl:  ('rows_ctrl' in data) ? data.rows_ctrl : doc.rows_ctrl,
      };
      const block = await codSsiBlockResponse(pool, actor.orgId, eff);
      if (block) return block;
    }

    // ASIMETRIE buget: ORD validează hard col.5 (422); DF nu (soft-warning e DOAR frontend).
    // Ordinea verificărilor (documentată): col.5 ≥ 0 ÎNTÂI (per rând), apoi plafonul
    // pe bugetul anului curent (FIX B, v3.9.557). Cele două sunt validări SEPARATE.
    if (cfg.budgetCheck === 'hard_col5') {
      const bad = validateOrdCol5(data.rows);
      if (bad) return bad;
      const overBudget = await validateOrdBugetAnCurent({ ordDoc: doc, newRows: data.rows, orgId: actor.orgId });
      if (overBudget) return overBudget;
    }

    const { sets, vals } = buildUpdate(data, cfg.p2Fields, 1);
    sets.push(`status='completed'`, `completed_at=NOW()`, `updated_at=NOW()`);
    sets.push(`updated_by=$${vals.length + 1}`);
    vals.push(actor.userId);
    vals.push(id, actor.orgId);

    const { rows: updated } = await pool.query(`
      UPDATE ${cfg.table} SET ${sets.join(', ')}
      WHERE id=$${vals.length - 1} AND org_id=$${vals.length}
      RETURNING *
    `, vals);

    // ASIMETRIE: DF actualizează ALOP legat (draft → angajare, non-fatal); ORD nu atinge ALOP.
    let linkedAlopId = null;
    if (cfg.alopOnComplete === 'df_angajare') {
      try {
        const { rows: alopRows } = await pool.query(
          `UPDATE alop_instances
           SET df_completed_at=NOW(), status=CASE WHEN status='draft' THEN 'angajare' ELSE status END, updated_at=NOW(), updated_by=$3
           WHERE df_id=$1 AND org_id=$2 AND status IN ('draft','angajare')
           RETURNING id`,
          [id, actor.orgId, actor.userId]
        );
        if (alopRows.length) linkedAlopId = alopRows[0].id;
      } catch (e) {
        logger.warn({ err: e }, 'alop_instances update failed after P2 complete');
      }
    }

    await sendNotif(doc.created_by, cfg.notif.complete.type, cfg.notif.complete.title,
      cfg.notif.complete.message(actor, doc), { form_type: type, form_id: id });

    logger.info({ id, actor: actor.email }, `formulare-${type} completat de P2`);
    await recordFormularAudit({ orgId: actor.orgId, formType: type, formId: id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'completat',
      fromStatus: doc.status, toStatus: 'completed' });
    if (linkedAlopId) {
      await recordFormularAudit({ orgId: actor.orgId, formType: type, formId: id,
        actorId: actor.userId, actorEmail: actor.email, eventType: 'legat_alop',
        meta: { alop_id: linkedAlopId } });
    }
    updated[0].capabilities = computeDocCapabilities(updated[0], actor, cfg.capsFt);
    return { status: 200, body: { ok: true, document: updated[0] } };
  } catch (e) {
    logger.error({ err: e }, `formulare-${type} complete error`);
    return { status: 500, body: { error: 'server_error' } };
  }
}

/** P2 returnează documentul ca neconform (returneaza). */
export async function returnFormular({ type, id, actor, body }) {
  const cfg = FORMULAR_TYPES[type];
  try {
    const { motiv } = body || {};
    if (!motiv || !motiv.trim()) return { status: 400, body: { error: 'motiv_obligatoriu' } };
    const { rows } = await pool.query(
      `SELECT * FROM ${cfg.table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!rows.length) return { status: 404, body: { error: 'not_found' } };
    const doc = rows[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: true });
      // P2-side: admin / assigned (direct sau ca rol) / p2_comp.
      const isP2Side = authz.allowed
        && (['admin','assigned','p2_comp'].includes(authz.role) || doc.assigned_to === actor.userId);
      if (!isP2Side) return { status: 403, body: { error: 'forbidden' } };
    }
    if (doc.status !== 'pending_p2')
      return { status: 409, body: { error: 'status_invalid', status: doc.status } };
    const { rows: upd } = await pool.query(
      `UPDATE ${cfg.table} SET status='returnat', motiv_returnare=$1, updated_at=NOW(), updated_by=$3 WHERE id=$2 RETURNING *`,
      [motiv.trim(), id, actor.userId]
    );
    await sendNotif(doc.created_by, cfg.notif.returneaza.type, cfg.notif.returneaza.title,
      cfg.notif.returneaza.message(actor, doc), { form_type: type, form_id: id });
    logger.info({ id, actor: actor.email }, `formulare-${type} returnat de P2`);
    await recordFormularAudit({ orgId: actor.orgId, formType: type, formId: id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'returnat',
      fromStatus: doc.status, toStatus: 'returnat', meta: { motiv: motiv.trim() } });
    const out = upd[0];
    out.capabilities = computeDocCapabilities(out, actor, cfg.capsFt);
    return { status: 200, body: { ok: true, document: out } };
  } catch (e) {
    logger.error({ err: e }, `formulare-${type} returneaza error`);
    return { status: 500, body: { error: 'server_error' } };
  }
}

/** P1 leagă documentul completat de fluxul de semnare (link-flow). */
export async function linkFlowFormular({ type, id, actor, body }) {
  const cfg = FORMULAR_TYPES[type];
  try {
    const { flow_id } = body || {};
    if (!flow_id) return { status: 400, body: { error: 'flow_id obligatoriu' } };

    const { rows: existing } = await pool.query(
      `SELECT ${cfg.linkFlowSelectCols} FROM ${cfg.table} WHERE id=$1 AND org_id=$2 AND deleted_at IS NULL`,
      [id, actor.orgId]
    );
    if (!existing.length) return { status: 404, body: { error: 'not_found' } };
    const doc = existing[0];
    {
      const actorComp = await loadActorComp(pool, actor.userId);
      const authz = await canEditFormular(pool, actor, doc, actorComp, { assignedCounts: false });
      if (!authz.allowed) return { status: 403, body: { error: authz.reason } };
    }
    if (doc.status !== 'completed')
      return { status: 409, body: { error: 'document_not_completed' } };

    // GARDĂ Cod SSI (DF): trimiterea pe flux e RESPINSĂ dacă DF-ul poartă un cod inexistent
    // în Clasa 8 (rândurile persistate — DF link-flow SELECT-ează '*'). Gated de cfg.codSsiValidate.
    if (cfg.codSsiValidate) {
      const block = await codSsiBlockResponse(pool, actor.orgId, doc);
      if (block) return block;
    }

    // Guard cauză-rădăcină: nu permite relansarea pe un AL DOILEA flux cât timp documentul
    // are deja un flux de semnare NON-terminal (nici completed, nici cancelled). Altfel
    // {df,ord}_flow_id din ALOP rămâne agățat de fluxul vechi (zombi) → auto-tranziția
    // ALOP nu se mai declanșează.
    // fix 10: EXCLUDE fluxul CURENT (`doc.flow_id === flow_id`). `crud.mjs` pre-setează
    // `formulare_{df,ord}.flow_id` la creare (din `meta.dfId/ordId`), ÎNAINTE de link-flow.
    // Fără excluderea asta, guard-ul 409-uia pe PROPRIUL flux tocmai legat → copierea (542)
    // era cod mort pe ORICE lansare DF/ORD standalone. Guard-ul rămâne activ DOAR pe un flux
    // DIFERIT activ (zombi real).
    if (doc.flow_id && doc.flow_id !== flow_id) {
      const { rows: activeFlow } = await pool.query(
        `SELECT 1 FROM flows
          WHERE id = $1
            AND (data->>'completed') IS DISTINCT FROM 'true'
            AND (data->>'status') <> 'cancelled'`,
        [doc.flow_id]
      );
      if (activeFlow.length) {
        return { status: 409, body: { error: cfg.alreadyOnFlowError, message: cfg.alreadyOnFlowMessage } };
      }
    }

    // ASIMETRIE: DF setează și status='transmis_flux'; ORD doar flow_id.
    const statusSet = cfg.linkFlowSetsStatus ? `, status='${cfg.linkFlowSetsStatus}'` : '';
    await pool.query(
      `UPDATE ${cfg.table} SET flow_id=$1${statusSet}, updated_at=NOW(), updated_by=$4 WHERE id=$2 AND org_id=$3`,
      [flow_id, id, actor.orgId, actor.userId]
    );
    // Sincronizează {df,ord}_flow_id în ALOP (non-fatal)
    try {
      await pool.query(
        `UPDATE alop_instances SET ${cfg.alopFlowField}=$1, updated_at=NOW(), updated_by=$4
         WHERE ${cfg.alopMatchCol}=$2 AND org_id=$3 AND cancelled_at IS NULL`,
        [flow_id, id, actor.orgId, actor.userId]
      );
    } catch (e) {
      logger.warn({ err: e }, `alop_instances ${cfg.alopFlowField} update failed`);
    }
    // fix 7: copierea atașamentelor formular→flux se declanșează AICI — la punctul DURABIL
    // de linkare (sursa de adevăr DF/ORD), NU din `meta.dfId/ordId` efemer în crud.mjs (care
    // lipsește pe calea de link dedicat → copierea nu rula niciodată pe ALOP). `type`/`id`/`flow_id`
    // sunt deja locale → acoperă ȘI DF ȘI ORD dintr-un singur punct. Idempotent (dedup flow_id+
    // filename). Non-fatal: o eroare la copiere NU rupe linkarea (semnarea e prioritară).
    let formAttachmentsCopied = 0;
    try {
      formAttachmentsCopied = await copyFormularAttachmentsToFlow(pool, { flowId: flow_id, formType: type, formId: id });
    } catch (e) {
      logger.warn({ err: e, type, id, flow_id }, 'copiere atașamente formular→flux non-fatal');
    }
    await recordFormularAudit({ orgId: actor.orgId, formType: type, formId: id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'transmis_flux',
      fromStatus: doc.status,
      ...(cfg.linkFlowSetsStatus ? { toStatus: cfg.linkFlowSetsStatus } : {}),
      meta: { flow_id } });
    return { status: 200, body: { ok: true, formAttachmentsCopied } };
  } catch (e) {
    logger.error({ err: e }, `formulare-${type} link-flow error`);
    return { status: 500, body: { error: 'server_error' } };
  }
}

// ── relink ALOP la ștergere (type-specific, non-fatal) ───────────────────────────

// DF: R0 → eliberează; R1+ → restore parent aprobat (mirror după signing.mjs refuse).
async function relinkAlopOnDfDelete(doc, id, actor) {
  try {
    if ((doc.revizie_nr || 0) === 0 || !doc.parent_df_id) {
      await pool.query(
        `UPDATE alop_instances
           SET df_id=NULL, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$2
         WHERE df_id=$1 AND cancelled_at IS NULL`,
        [id, actor.userId]
      );
    } else {
      const { rows: parentRows } = await pool.query(
        `SELECT id, flow_id, status FROM formulare_df WHERE id=$1 AND deleted_at IS NULL LIMIT 1`,
        [doc.parent_df_id]
      );
      if (parentRows.length && parentRows[0].status === 'aprobat' && parentRows[0].flow_id) {
        await pool.query(
          `UPDATE alop_instances
             SET df_id=$1, df_flow_id=$2, df_completed_at=NOW(), updated_at=NOW(), updated_by=$4
           WHERE df_id=$3 AND cancelled_at IS NULL`,
          [parentRows[0].id, parentRows[0].flow_id, id, actor.userId]
        );
      } else {
        await pool.query(
          `UPDATE alop_instances
             SET df_id=NULL, df_flow_id=NULL, df_completed_at=NULL, updated_at=NOW(), updated_by=$2
           WHERE df_id=$1 AND cancelled_at IS NULL`,
          [id, actor.userId]
        );
      }
    }
  } catch (relinkErr) {
    logger.error({ err: relinkErr, dfId: id }, 'sterge df: ALOP relink failed (non-fatal)');
  }
}

// ORD: eliberează ord_id → butonul "Completează Ordonanțare" reapare.
async function relinkAlopOnOrdDelete(id, actor) {
  try {
    await pool.query(
      `UPDATE alop_instances
         SET ord_id=NULL, ord_flow_id=NULL, ord_completed_at=NULL, updated_at=NOW(), updated_by=$2
       WHERE ord_id=$1 AND cancelled_at IS NULL`,
      [id, actor.userId]
    );
  } catch (relinkErr) {
    logger.error({ err: relinkErr, ordId: id }, 'sterge ord: ALOP relink failed (non-fatal)');
  }
}

/** Ștergere (soft-delete) — POST /sterge. */
export async function stergeFormular({ type, id, actor }) {
  const cfg = FORMULAR_TYPES[type];
  try {
    const { rows } = await pool.query(
      `SELECT ${cfg.stergeSelectCols} FROM ${cfg.table} WHERE id=$1 AND deleted_at IS NULL`,
      [id]
    );
    if (!rows.length) return { status: 404, body: { error: 'not_found' } };
    const doc = rows[0];
    if (!isPlatformAdmin(actor) && doc.org_id !== actor.orgId)
      return { status: 403, body: { error: 'forbidden' } };
    {
      const authz = canDestroyOnly(actor, doc);
      if (!authz.allowed) return { status: 403, body: { error: authz.reason } };
    }
    if (doc.flow_id)
      return { status: 409, body: { error: 'cannot_delete_on_flow', message: cfg.deleteOnFlowMessage } };

    // ASIMETRIE: DF blochează ștergerea dacă există o ORD legată ne-ștearsă.
    if (cfg.deleteHasOrdCheck) {
      const { rows: ordRows } = await pool.query(
        `SELECT id, nr_ordonant_pl FROM formulare_ord WHERE df_id=$1 AND deleted_at IS NULL LIMIT 1`,
        [id]
      );
      if (ordRows.length)
        return { status: 409, body: { error: 'cannot_delete_has_ord', message: `Nu se poate șterge DF-ul: există o Ordonanțare de Plată legată (${ordRows[0].nr_ordonant_pl || 'fără nr.'}). Ștergeți întâi ORD-ul.` } };
    }

    // Soft delete: atașamentele/capturile copiate pe această revizie (form_id=id) rămân
    // legate de rândul șters — invizibile prin filtrarea curentă (JOIN pe form_id, fără
    // deleted_at pe formulare_capturi). Lăsate intenționat orfane, pentru audit.
    await pool.query(
      `UPDATE ${cfg.table} SET deleted_at=NOW(), updated_at=NOW(), updated_by=$2 WHERE id=$1`,
      [id, actor.userId]
    );
    await recordFormularAudit({ orgId: doc.org_id, formType: type, formId: id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'sters', fromStatus: doc.status });

    // ASIMETRIE: relink ALOP — DF conștient de revizii, ORD simplu.
    if (cfg.relinkOnDelete === 'df_revision_aware') {
      await relinkAlopOnDfDelete(doc, id, actor);
    } else if (cfg.relinkOnDelete === 'ord_simple') {
      await relinkAlopOnOrdDelete(id, actor);
    }

    return { status: 200, body: { ok: true } };
  } catch (e) {
    logger.error({ err: e }, `sterge ${type} error`);
    return { status: 500, body: { error: 'server_error' } };
  }
}
