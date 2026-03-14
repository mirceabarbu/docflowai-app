#!/usr/bin/env node
/**
 * DocFlowAI — CLI Outreach Campaign Sender
 *
 * Utilizare:
 *   node tools/send-campaign.mjs --campaign <id> [--batch <n>] [--dry-run]
 *
 * Exemple:
 *   node tools/send-campaign.mjs --campaign 1 --dry-run
 *   node tools/send-campaign.mjs --campaign 1 --batch 50
 *   node tools/send-campaign.mjs --campaign 1 --batch 100
 *
 * Opțiuni:
 *   --campaign <id>   ID-ul campaniei (obligatoriu)
 *   --batch <n>       Numărul de emailuri de trimis (default: 50, max: 100)
 *   --dry-run         Afișează destinatarii fără a trimite efectiv
 *   --list            Listează toate campaniile disponibile
 *   --help            Afișează acest mesaj
 *
 * ENV required: DATABASE_URL, RESEND_API_KEY
 * ENV optional: OUTREACH_PDF_PATH, OUTREACH_FROM, APP_URL, OUTREACH_DAILY_LIMIT
 */

import pg      from 'pg';
import fs      from 'fs';
import path    from 'path';
import { Resend } from 'resend';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Env ───────────────────────────────────────────────────────────────────
const DATABASE_URL      = process.env.DATABASE_URL;
const RESEND_API_KEY    = process.env.RESEND_API_KEY;
const FROM_EMAIL        = process.env.OUTREACH_FROM || 'DocFlowAI <contact@docflowai.ro>';
const PDF_PATH          = process.env.OUTREACH_PDF_PATH || path.join(__dirname, 'DocFlowAI_Prezentare.pdf');
const APP_URL           = process.env.APP_URL || '';
const DAILY_LIMIT       = parseInt(process.env.OUTREACH_DAILY_LIMIT || '100');

if (!DATABASE_URL) { console.error('❌ DATABASE_URL nu este setat.'); process.exit(1); }

// ── Args ──────────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const getArg = (flag) => {
  const i = args.indexOf(flag);
  return i !== -1 ? args[i + 1] : null;
};
const hasFlag = (flag) => args.includes(flag);

if (hasFlag('--help') || args.length === 0) {
  console.log(`
DocFlowAI Outreach CLI
──────────────────────
  node tools/send-campaign.mjs --campaign <id> [--batch <n>] [--dry-run]
  node tools/send-campaign.mjs --list

Opțiuni:
  --campaign <id>    ID campanie (obligatoriu pentru trimitere)
  --batch <n>        Emailuri de trimis acum (default 50, max 100)
  --dry-run          Simulare fără trimitere efectivă
  --list             Afișează toate campaniile

ENV: DATABASE_URL, RESEND_API_KEY, OUTREACH_PDF_PATH, OUTREACH_FROM, APP_URL
`);
  process.exit(0);
}

// ── DB ────────────────────────────────────────────────────────────────────
const pool = new pg.Pool({ connectionString: DATABASE_URL, ssl: { rejectUnauthorized: false } });

async function sentToday() {
  const { rows } = await pool.query(`
    SELECT COUNT(*) AS cnt FROM outreach_recipients
    WHERE status = 'sent' AND sent_at >= DATE_TRUNC('day', NOW() AT TIME ZONE 'UTC')
  `);
  return parseInt(rows[0].cnt);
}

function buildHtml(template, institutie, trackingId) {
  const pixel = APP_URL
    ? `<img src="${APP_URL}/admin/outreach/track/${trackingId}" width="1" height="1" style="display:none" alt=""/>`
    : '';
  return template.replace(/\{\{institutie\}\}/g, institutie) + pixel;
}

// ── LIST ──────────────────────────────────────────────────────────────────
if (hasFlag('--list')) {
  const { rows } = await pool.query(`
    SELECT c.id, c.name, c.subject, c.created_by, c.created_at,
      COUNT(r.id) FILTER (WHERE r.status='pending')              AS pending,
      COUNT(r.id) FILTER (WHERE r.status IN ('sent','opened'))   AS sent,
      COUNT(r.id) FILTER (WHERE r.status='opened')               AS opened,
      COUNT(r.id) FILTER (WHERE r.status='error')                AS errors
    FROM outreach_campaigns c
    LEFT JOIN outreach_recipients r ON r.campaign_id = c.id
    GROUP BY c.id ORDER BY c.id DESC
  `);
  if (!rows.length) { console.log('Nicio campanie găsită.'); process.exit(0); }
  console.log('\n📋 Campanii disponibile:\n');
  rows.forEach(c => {
    console.log(`  [${c.id}] ${c.name}`);
    console.log(`       Subiect: ${c.subject}`);
    console.log(`       Creat de: ${c.created_by} · ${new Date(c.created_at).toLocaleDateString('ro-RO')}`);
    console.log(`       Pending: ${c.pending}  Trimiși: ${c.sent}  Deschis: ${c.opened}  Erori: ${c.errors}`);
    console.log('');
  });
  await pool.end(); process.exit(0);
}

// ── SEND ──────────────────────────────────────────────────────────────────
const campaignId = parseInt(getArg('--campaign'));
if (!campaignId) { console.error('❌ --campaign <id> este obligatoriu.'); process.exit(1); }

const batchSize  = Math.min(parseInt(getArg('--batch') || '50'), 100);
const isDryRun   = hasFlag('--dry-run');

if (!isDryRun && !RESEND_API_KEY) {
  console.error('❌ RESEND_API_KEY nu este setat. Rulează cu --dry-run sau setează cheia.');
  process.exit(1);
}

// Campanie
const { rows: camps } = await pool.query('SELECT * FROM outreach_campaigns WHERE id=$1', [campaignId]);
if (!camps.length) { console.error(`❌ Campania cu ID ${campaignId} nu există.`); process.exit(1); }
const campaign = camps[0];
console.log(`\n📧 Campanie: ${campaign.name}`);
console.log(`   Subiect:  ${campaign.subject}`);

// Rate limit
const alreadySent = await sentToday();
const remaining   = DAILY_LIMIT - alreadySent;
console.log(`\n📊 Limită zilnică: ${alreadySent}/${DAILY_LIMIT} folosite · Disponibile: ${remaining}`);

if (!isDryRun && remaining <= 0) {
  console.error(`❌ Limita zilnică de ${DAILY_LIMIT} emailuri a fost atinsă. Reîncearcă mâine.`);
  await pool.end(); process.exit(1);
}

const toSend = isDryRun ? batchSize : Math.min(batchSize, remaining);

// Destinatari pending
const { rows: pending } = await pool.query(`
  SELECT id, email, institutie, tracking_id FROM outreach_recipients
  WHERE campaign_id = $1 AND status = 'pending'
  ORDER BY id ASC LIMIT $2
`, [campaignId, toSend]);

if (!pending.length) {
  console.log('\n✅ Nu există destinatari în așteptare pentru această campanie.');
  await pool.end(); process.exit(0);
}

console.log(`\n${isDryRun ? '🔍 DRY RUN — ' : ''}Destinatari de procesat: ${pending.length}\n`);

if (isDryRun) {
  pending.forEach((r, i) => console.log(`  ${i + 1}. ${r.email} · ${r.institutie || '(fără instituție)'}`));
  console.log('\n✅ Dry run complet. Rulează fără --dry-run pentru a trimite efectiv.');
  await pool.end(); process.exit(0);
}

// PDF atașament (opțional)
let attachment = null;
if (fs.existsSync(PDF_PATH)) {
  attachment = { filename: 'DocFlowAI_Prezentare.pdf', content: fs.readFileSync(PDF_PATH) };
  console.log(`📎 PDF atașat: ${PDF_PATH}`);
} else {
  console.log(`ℹ️  PDF negăsit la ${PDF_PATH} — se trimite fără atașament.`);
}

const resend = new Resend(RESEND_API_KEY);
let sentCount = 0, errorCount = 0;

for (const recip of pending) {
  const html = buildHtml(campaign.html_body, recip.institutie, recip.tracking_id);
  try {
    await resend.emails.send({
      from: FROM_EMAIL,
      to: recip.email,
      subject: campaign.subject,
      html,
      ...(attachment ? { attachments: [attachment] } : {}),
    });
    await pool.query(
      `UPDATE outreach_recipients SET status='sent', sent_at=NOW() WHERE id=$1`, [recip.id]
    );
    sentCount++;
    console.log(`  ✅ ${recip.email}`);
  } catch(e) {
    const errMsg = e?.message || String(e);
    await pool.query(
      `UPDATE outreach_recipients SET status='error', error_msg=$1 WHERE id=$2`,
      [errMsg.substring(0, 500), recip.id]
    );
    errorCount++;
    console.log(`  ❌ ${recip.email} — ${errMsg}`);
  }
}

console.log(`\n📊 Rezultat: ${sentCount} trimise · ${errorCount} erori`);
console.log(`   Limită zilnică: ${alreadySent + sentCount}/${DAILY_LIMIT} folosite`);

await pool.end();
process.exit(errorCount > 0 ? 1 : 0);
