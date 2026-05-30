/**
 * Admin routes — maintenance & utility endpoints.
 * (onboarding, vacuum, drive verify, wa-test, smtp-test, health)
 * DocFlowAI — server/routes/admin/maintenance.mjs
 */

import { Router } from 'express';
import { readFileSync } from 'fs';
import { csrfMiddleware } from '../../middleware/csrf.mjs';
import { requireAuth, hashPassword, generatePassword } from '../../middleware/auth.mjs';
import { pool, DB_READY, DB_LAST_ERROR, requireDb, invalidateOrgUserCache } from '../../db/index.mjs';
import { logger } from '../../middleware/logger.mjs';
import { verifyDrive } from '../../drive.mjs';
import { verifyWhatsApp, sendWaSignRequest } from '../../whatsapp.mjs';
import { sendSignerEmail, verifySmtp } from '../../mailer.mjs';
import { emailCredentials } from '../../emailTemplates.mjs';
import { isAdminOrOrgAdmin, getAppUrl } from './_helpers.mjs';

// Versiune citită din package.json (single source of truth)
const _pkg = JSON.parse(readFileSync(new URL('../../../package.json', import.meta.url)));
const APP_VERSION = _pkg.version;

// WebSocket clients counter — injectat din index.mjs după startup
let _wsClientsSize = () => 0;
export function injectWsSize(fn) { _wsClientsSize = fn; }

const router = Router();

// ── POST /admin/onboarding — Wizard creare instituție nouă ──────────────────
// Crează în un singur pas: organizație nouă + utilizator org_admin + trimite credențiale
// Disponibil doar pentru super-admin
router.post('/admin/onboarding', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden', message: 'Doar super-adminul poate crea instituții noi.' });

  const { org_name, admin_email, admin_name, admin_functie, admin_phone, cif } = req.body || {};

  if (!org_name || !String(org_name).trim())
    return res.status(400).json({ error: 'org_name_required' });
  if (!admin_email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(admin_email))
    return res.status(400).json({ error: 'admin_email_invalid' });
  if (!admin_name || !String(admin_name).trim())
    return res.status(400).json({ error: 'admin_name_required' });

  const orgName    = String(org_name).trim();
  const adminEmail = admin_email.trim().toLowerCase();
  const adminName  = String(admin_name).trim();
  const adminFunctie = (admin_functie || 'Administrator Instituție').trim();
  const adminPhone = (admin_phone || '').trim();
  const orgCif = cif ? String(cif).replace(/\D/g, '').substring(0, 10) || null : null;

  try {
    // 1. Verificam ca emailul nu exista deja
    const { rows: existingUser } = await pool.query(
      'SELECT id FROM users WHERE lower(email)=$1', [adminEmail]
    );
    if (existingUser.length > 0)
      return res.status(409).json({ error: 'email_exists', message: `Utilizatorul ${adminEmail} există deja.` });

    // 2. Cream sau gasim organizatia
    const { rows: existingOrg } = await pool.query(
      'SELECT id FROM organizations WHERE lower(name)=lower($1)', [orgName]
    );
    let orgId;
    if (existingOrg.length > 0) {
      orgId = existingOrg[0].id;
      logger.info({ orgName, orgId }, 'Onboarding: org existenta refolosita');
    } else {
      const { rows: newOrg } = await pool.query(
        'INSERT INTO organizations (name, cif) VALUES ($1, $2) RETURNING id', [orgName, orgCif]
      );
      orgId = newOrg[0].id;
      logger.info({ orgName, orgId, orgCif }, 'Onboarding: org noua creata');
    }

    // 3. Cream utilizatorul org_admin cu parola temporara
    const tempPassword = generatePassword();
    const passwordHash = await hashPassword(tempPassword);
    const { rows: newUser } = await pool.query(
      `INSERT INTO users (email, password_hash, nume, functie, institutie, role, org_id,
        notif_inapp, notif_email, force_password_change, created_at)
       VALUES ($1,$2,$3,$4,$5,'org_admin',$6,true,true,true,NOW())
       RETURNING id, email, nume`,
      [adminEmail, passwordHash, adminName, adminFunctie, orgName, orgId]
    );
    const userId = newUser[0].id;

    // 4. Trimitem email cu credentiale
    const appUrl = getAppUrl(req);
    try {
      await sendSignerEmail({
        to: adminEmail,
        ...emailCredentials({ appUrl, numeUser: adminName, email: adminEmail, newPwd: tempPassword }),
      });
      logger.info({ adminEmail, orgName }, 'Onboarding: credentiale trimise');
    } catch(mailErr) {
      logger.warn({ err: mailErr, adminEmail }, 'Onboarding: email credentiale esuat (non-fatal)');
    }

    res.json({
      ok: true,
      orgId,
      orgName,
      userId,
      adminEmail,
      tempPassword, // returnat catre super-admin ca fallback
      message: `Instituția „${orgName}" a fost creată. Credențialele au fost trimise la ${adminEmail}.`,
    });
  } catch(e) {
    logger.error({ err: e }, 'Onboarding error');
    res.status(500).json({ error: 'server_error' });
  }
});

router.get('/admin/db/diagnostics', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const [topTablesR, flowsColumnsR, flowsSizeR, flowsPdfsR, auditLogR] = await Promise.all([
      pool.query(`
        SELECT relname, pg_size_pretty(pg_total_relation_size(oid)) AS size,
               pg_total_relation_size(oid) AS bytes
        FROM pg_class WHERE relkind='r'
        ORDER BY bytes DESC LIMIT 15
      `),
      pool.query(`
        SELECT column_name, data_type
        FROM information_schema.columns
        WHERE table_name='flows'
          AND data_type IN ('text','bytea')
      `),
      pool.query(`
        SELECT pg_size_pretty(pg_total_relation_size('flows')) AS table_size,
               COUNT(*) AS row_count,
               pg_size_pretty(pg_total_relation_size('flows') / GREATEST(COUNT(*),1)) AS avg_row_size
        FROM flows
      `),
      pool.query(`
        SELECT pg_size_pretty(pg_total_relation_size('flows_pdfs')) AS table_size,
               COUNT(*) AS row_count,
               pg_size_pretty(pg_total_relation_size('flows_pdfs') / GREATEST(COUNT(*),1)) AS avg_row_size
        FROM flows_pdfs
      `).catch(() => ({ rows: [{ table_size: 'N/A', row_count: 0, avg_row_size: 'N/A' }] })),
      pool.query(`
        SELECT pg_size_pretty(pg_total_relation_size('audit_log')) AS table_size,
               COUNT(*) AS row_count
        FROM audit_log
      `).catch(() => ({ rows: [{ table_size: 'N/A', row_count: 0 }] })),
    ]);
    res.json({
      topTables: topTablesR.rows,
      flowsTextByteaColumns: flowsColumnsR.rows,
      flowsSize: flowsSizeR.rows[0],
      flowsPdfsSize: flowsPdfsR.rows[0],
      auditLogSize: auditLogR.rows[0],
    });
  } catch(e) {
    logger.error({ err: e }, 'DB diagnostics error');
    res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

async function runVacuumFull() {
  const client = await pool.connect();
  try {
    await client.query("SET statement_timeout = '15min'");
    await client.query('VACUUM FULL flows_pdfs');
    await client.query('VACUUM FULL flow_attachments');
    await client.query('VACUUM ANALYZE flows');
  } finally {
    client.release();
  }
}

router.post('/admin/db/vacuum', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const beforeR = await pool.query(`
      SELECT
        pg_database_size(current_database()) AS db_bytes,
        pg_total_relation_size('flows_pdfs') AS pdfs_bytes,
        pg_total_relation_size('flow_attachments') AS att_bytes
    `);
    // VACUUM FULL ia ACCESS EXCLUSIVE LOCK temporar — singurul mod de a returna spațiul la OS.
    // Rulează pe client dedicat cu statement_timeout extins (vezi runVacuumFull).
    await runVacuumFull();
    const afterR = await pool.query(`
      SELECT
        pg_database_size(current_database()) AS db_bytes,
        pg_total_relation_size('flows_pdfs') AS pdfs_bytes,
        pg_total_relation_size('flow_attachments') AS att_bytes
    `);
    const before = beforeR.rows[0], after = afterR.rows[0];
    const fmtMB = (b) => (Number(b) / 1024 / 1024).toFixed(2) + ' MB';
    const freedMB = (Number(before.db_bytes) - Number(after.db_bytes)) / 1024 / 1024;
    logger.info({
      actor: actor.email,
      dbBefore: before.db_bytes,
      dbAfter: after.db_bytes,
      freedMB,
    }, 'VACUUM FULL flows_pdfs + flow_attachments + ANALYZE flows executat');
    return res.json({
      ok: true,
      message: 'VACUUM FULL flows_pdfs + flow_attachments + ANALYZE flows executat.',
      dbSizeBefore:    fmtMB(before.db_bytes),
      dbSizeAfter:     fmtMB(after.db_bytes),
      freedMB:         freedMB.toFixed(2),
      pdfsTableBefore: fmtMB(before.pdfs_bytes),
      pdfsTableAfter:  fmtMB(after.pdfs_bytes),
      attTableBefore:  fmtMB(before.att_bytes),
      attTableAfter:   fmtMB(after.att_bytes),
    });
  } catch(e) {
    logger.error({ err: e }, 'vacuum error');
    return res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

router.post('/admin/db/cleanup-orphans', csrfMiddleware, async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  try {
    const beforeR = await pool.query(`
      SELECT
        pg_database_size(current_database()) AS db_bytes,
        (SELECT pg_total_relation_size('flows_pdfs')) AS pdfs_bytes,
        (SELECT pg_total_relation_size('flow_attachments')) AS att_bytes,
        (SELECT COUNT(*) FROM flows_pdfs WHERE flow_id IN (SELECT id FROM flows WHERE deleted_at IS NOT NULL)) AS orphan_pdfs,
        (SELECT COUNT(*) FROM flow_attachments WHERE flow_id IN (SELECT id FROM flows WHERE deleted_at IS NOT NULL)) AS orphan_atts,
        (SELECT COUNT(*) FROM flow_attachments WHERE drive_file_id IS NOT NULL AND data IS NOT NULL) AS archived_atts_with_data
    `);
    const before = beforeR.rows[0];

    const delPdfs = await pool.query(`
      DELETE FROM flows_pdfs
       WHERE flow_id IN (SELECT id FROM flows WHERE deleted_at IS NOT NULL)
    `);

    const delAtts = await pool.query(`
      DELETE FROM flow_attachments
       WHERE flow_id IN (SELECT id FROM flows WHERE deleted_at IS NOT NULL)
    `);

    // Nullify BYTEA pentru atașamente ARHIVATE în Drive (drive_file_id setat).
    // Download-ul are fallback streamFromDrive (vezi attachments.mjs).
    // Trebuie să ruleze ÎNAINTE de VACUUM FULL ca spațiul eliberat să fie returnat la OS.
    const nullifyArchived = await pool.query(`
      UPDATE flow_attachments
         SET data = NULL
       WHERE drive_file_id IS NOT NULL
         AND data IS NOT NULL
    `);

    // VACUUM FULL ia ACCESS EXCLUSIVE LOCK temporar — singurul mod de a returna spațiul la OS.
    // Rulează pe client dedicat cu statement_timeout extins (vezi runVacuumFull).
    await runVacuumFull();

    const afterR = await pool.query(`
      SELECT
        pg_database_size(current_database()) AS db_bytes,
        (SELECT pg_total_relation_size('flows_pdfs')) AS pdfs_bytes,
        (SELECT pg_total_relation_size('flow_attachments')) AS att_bytes
    `);
    const after = afterR.rows[0];

    const fmtMB = (b) => (Number(b) / 1024 / 1024).toFixed(2) + ' MB';
    const fmtBytes = (b) => Number(b);

    logger.info({
      actor: actor.email,
      pdfsDeleted: delPdfs.rowCount,
      attsDeleted: delAtts.rowCount,
      archivedAttsNullified: nullifyArchived.rowCount,
      dbBefore: before.db_bytes,
      dbAfter: after.db_bytes,
    }, 'cleanup-orphans executat (extins cu nullify atașamente arhivate)');

    return res.json({
      ok: true,
      pdfsDeleted:           delPdfs.rowCount,
      attachmentsDeleted:    delAtts.rowCount,
      attachmentsNullified:  nullifyArchived.rowCount,
      orphanPdfsFound:       parseInt(before.orphan_pdfs),
      orphanAttsFound:       parseInt(before.orphan_atts),
      archivedAttsNullified: parseInt(before.archived_atts_with_data),
      dbSizeBefore:          fmtMB(before.db_bytes),
      dbSizeAfter:           fmtMB(after.db_bytes),
      freedMB:               (fmtBytes(before.db_bytes) - fmtBytes(after.db_bytes)) / 1024 / 1024,
      pdfsTableBefore:       fmtMB(before.pdfs_bytes),
      pdfsTableAfter:        fmtMB(after.pdfs_bytes),
    });
  } catch(e) {
    logger.error({ err: e }, 'cleanup-orphans error');
    return res.status(500).json({ error: 'server_error', detail: e.message });
  }
});

router.get('/admin/drive/verify', async (req, res) => {
  if (requireDb(res)) return;
  const actor = requireAuth(req, res); if (!actor) return;
  if (!isAdminOrOrgAdmin(actor)) return res.status(403).json({ error: 'forbidden' });
  try { res.json(await verifyDrive()); } catch(e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

// ── Utility endpoints ──────────────────────────────────────────────────────
router.get('/wa-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  res.status((await verifyWhatsApp()).ok ? 200 : 500).json(await verifyWhatsApp());
});

router.post('/wa-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { to } = req.body || {};
  if (!to) return res.status(400).json({ error: 'to (phone) missing' });
  const r = await sendWaSignRequest({ phone: to, signerName: 'Test', docName: 'Document test DocFlowAI' });
  res.status(r.ok ? 200 : 500).json(r);
});

router.get('/smtp-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const r = await verifySmtp(); res.status(r.ok ? 200 : 500).json(r);
});

router.post('/smtp-test', async (req, res) => {
  const actor = requireAuth(req, res); if (!actor) return;
  if (actor.role !== 'admin') return res.status(403).json({ error: 'forbidden' });
  const { to } = req.body || {}; if (!to) return res.status(400).json({ error: 'to missing' });
  try {
    const v = await verifySmtp(); if (!v.ok) return res.status(500).json({ error: 'smtp_not_ready', detail: v });
    await sendSignerEmail({ to, subject: 'Test SMTP DocFlowAI', html: '<p>SMTP funcționează! ✅</p>' });
    res.json({ ok: true, to });
  } catch(e) { res.status(500).json({ ok: false, error: 'server_error' }); }
});

router.get('/health', async (req, res) => {
  const base = { ok: true, service: 'DocFlowAI', version: APP_VERSION, dbReady: DB_READY, dbLastError: DB_LAST_ERROR, wsClients: _wsClientsSize(), ts: new Date().toISOString() };
  if (!pool || !DB_READY) return res.json(base);
  try {
    const [flowsR, usersR, notifsR, archR] = await Promise.all([
      pool.query('SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL'), pool.query('SELECT COUNT(*) FROM users'),
      pool.query('SELECT COUNT(*) FROM notifications WHERE read=FALSE'),
      pool.query("SELECT COUNT(*) FROM flows WHERE deleted_at IS NULL AND data->>'storage'='drive'"),
    ]);
    const sizeR = await pool.query('SELECT pg_size_pretty(pg_database_size(current_database())) AS db_size, pg_database_size(current_database()) AS db_bytes');
    return res.json({ ...base, stats: { flows: parseInt(flowsR.rows[0].count), flowsArchived: parseInt(archR.rows[0].count), users: parseInt(usersR.rows[0].count), unreadNotifications: parseInt(notifsR.rows[0].count), dbSize: sizeR.rows[0].db_size, dbBytes: parseInt(sizeR.rows[0].db_bytes) } });
  } catch(e) { return res.json({ ...base, statsError: e.message }); }
});

export default router;
