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
import { logger } from '../middleware/logger.mjs';
import { recordFormularAudit } from '../db/queries/formulare-audit.mjs';
import { computeDocCapabilities } from './formular-capabilities.mjs';
import { loadActorComp, canEditFormular, canDestroyOnly } from './authz-formular.mjs';

// ── helpers partajate (și de rutele create/PUT/capturi din server/routes/formulare/) ─────

/** Trimite notificare in-app corect (user_email + data JSONB) */
export async function sendNotif(userId, type, title, message, data) {
  try {
    const { rows } = await pool.query('SELECT email FROM users WHERE id=$1', [userId]);
    if (!rows.length) return;
    await pool.query(
      `INSERT INTO notifications (user_email, type, title, message, data)
       VALUES ($1, $2, $3, $4, $5)`,
      [rows[0].email.toLowerCase(), type, title, message, JSON.stringify(data)]
    );
  } catch (_) { /* non-fatal */ }
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
];

/** Câmpuri DF sectiunea B (P2) */
export const DF_P2_FIELDS = [
  'ckbx_secta_inreg_ctrl_ang','ckbx_fara_inreg_ctrl_ang','sum_fara_inreg_ctrl_crdbug',
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

    // ASIMETRIE buget: ORD validează hard col.5 (422); DF nu (soft-warning e DOAR frontend).
    if (cfg.budgetCheck === 'hard_col5') {
      const bad = validateOrdCol5(data.rows);
      if (bad) return bad;
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

    // Guard cauză-rădăcină: nu permite relansarea pe un AL DOILEA flux cât timp documentul
    // are deja un flux de semnare NON-terminal (nici completed, nici cancelled). Altfel
    // {df,ord}_flow_id din ALOP rămâne agățat de fluxul vechi (zombi) → auto-tranziția
    // ALOP nu se mai declanșează.
    if (doc.flow_id) {
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
    await recordFormularAudit({ orgId: actor.orgId, formType: type, formId: id,
      actorId: actor.userId, actorEmail: actor.email, eventType: 'transmis_flux',
      fromStatus: doc.status,
      ...(cfg.linkFlowSetsStatus ? { toStatus: cfg.linkFlowSetsStatus } : {}),
      meta: { flow_id } });
    return { status: 200, body: { ok: true } };
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
    if (actor.role !== 'admin' && doc.org_id !== actor.orgId)
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
