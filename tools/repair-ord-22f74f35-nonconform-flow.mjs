#!/usr/bin/env node
/**
 * Reparație one-off: ORD 41011 (Primăria Zărnești, DF 6744) a fost semnat de un
 * singur semnatar (ÎNTOCMIT = inițiator), fără să iasă din instituție. Fluxul e
 * finalizat (data.completed=true), dar nu e proces valid — reparăm ca eroare de
 * date, nu ca acțiune de business.
 *
 * Recon complet: RECON-ord-neconform-flux-finalizat.md
 * Confirmat prin Q1-Q7 (2026-07-23):
 *   - formulare_ord.status = 'completed', flow_id = 'PZ_AD33C81DFA'
 *   - alop_instances.status = 'plata', plata_confirmed_at IS NULL,
 *     plata_suma_efectiva IS NULL, suma_totala_platita = 0.00 → nicio plată reală
 *   - flows: data->>'completed' = 'true', 1 singur semnatar (ÎNTOCMIT = inițiator)
 *   - alop_ord_cicluri: 0 rânduri (niciun ciclu arhivat de protejat)
 *   - opme_lines: 0 rânduri legate (nimic de dezlegat)
 *   - poarta alop_status_guard: mod observare confirmat (0 violări, RAISE WARNING nu EXCEPTION)
 *
 * Rulează: node tools/repair-ord-22f74f35-nonconform-flux-finalizat.mjs           (dry-run, implicit)
 *          node tools/repair-ord-22f74f35-nonconform-flux-finalizat.mjs --apply   (execută în tranzacție)
 * Necesită: DATABASE_URL în .env (sau environment)
 */
import pg from 'pg';
import { readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const envPath = resolve(dirname(fileURLToPath(import.meta.url)), '../.env');
try {
  const lines = readFileSync(envPath, 'utf8').split('\n');
  for (const line of lines) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch (_) { /* .env absent */ }

const url = process.env.DATABASE_URL;
if (!url) { console.error('❌ DATABASE_URL lipsă.'); process.exit(1); }

const APPLY = process.argv.includes('--apply');

const ORD_ID = '22f74f35-cae6-4e60-8bc3-ba111f49ec86';
const FLOW_ID = 'PZ_AD33C81DFA';
const ADMIN_ACTOR_ID = 1; // admin@docflowai.ro
const ADMIN_ACTOR_EMAIL = 'admin@docflowai.ro';

const pool = new pg.Pool({ connectionString: url, ssl: { rejectUnauthorized: false } });

async function verifyPreconditions(client) {
  const { rows: [ord] } = await client.query(
    `SELECT id, status, flow_id, org_id FROM formulare_ord WHERE id = $1 FOR UPDATE`,
    [ORD_ID]
  );
  if (!ord) throw new Error('ORD inexistent — abandonez.');
  if (ord.flow_id !== FLOW_ID) throw new Error(`ORD.flow_id neașteptat: ${ord.flow_id} (așteptat ${FLOW_ID})`);

  const { rows: [alop] } = await client.query(
    `SELECT id, status, ord_flow_id, ord_completed_at, plata_confirmed_at,
            plata_suma_efectiva, suma_totala_platita, cancelled_at
     FROM alop_instances WHERE ord_id = $1 FOR UPDATE`,
    [ORD_ID]
  );
  if (!alop) throw new Error('ALOP inexistent — abandonez.');
  if (alop.cancelled_at) throw new Error('ALOP deja anulat — abandonez, nu are sens reparația.');
  if (alop.plata_confirmed_at) throw new Error('plata_confirmed_at NENUL — plată confirmată, NU rula reparația de date, e corecție financiară.');
  const sumaEfectiva = Number(alop.plata_suma_efectiva || 0);
  const sumaTotala = Number(alop.suma_totala_platita || 0);
  if (sumaEfectiva > 0 || sumaTotala > 0) throw new Error('Sume de plată nenule — abandonez, discutăm altfel.');
  if (alop.status !== 'plata') throw new Error(`alop_instances.status neașteptat: ${alop.status} (așteptat 'plata')`);

  const { rows: [flow] } = await client.query(
    `SELECT id, deleted_at, data->>'completed' AS data_completed,
            jsonb_array_length(COALESCE(data->'signers','[]'::jsonb)) AS nr_semnatari
     FROM flows WHERE id = $1 FOR UPDATE`,
    [FLOW_ID]
  );
  if (!flow) throw new Error('Flux inexistent — abandonez.');
  if (flow.deleted_at) throw new Error('Flux deja soft-șters — nimic de reparat.');
  if (flow.data_completed !== 'true') throw new Error('Flux neterminat — abandonez, nu se potrivește diagnosticului.');
  if (Number(flow.nr_semnatari) !== 1) throw new Error(`nr_semnatari neașteptat: ${flow.nr_semnatari} (așteptat 1)`);

  const { rows: cicluri } = await client.query(
    `SELECT id FROM alop_ord_cicluri WHERE alop_id = $1`, [alop.id]
  );
  if (cicluri.length > 0) throw new Error('Există cicluri ORD arhivate — abandonez, nu ating istoricul.');

  const { rows: opme } = await client.query(
    `SELECT id FROM opme_lines WHERE matched_alop_id = $1`, [alop.id]
  );
  if (opme.length > 0) throw new Error('Există linii OPME legate — abandonez, trebuie dezlegate explicit întâi.');

  return { ord, alop, flow };
}

try {
  console.log(`🔌 Conectare (${APPLY ? 'APPLY' : 'DRY-RUN'})...`);
  const client = await pool.connect();
  try {
    await client.query('BEGIN');

    const { ord, alop } = await verifyPreconditions(client);
    console.log('✅ Precondiții verificate:');
    console.log(`   ORD  ${ord.id}  status=${ord.status}  flow_id=${ord.flow_id}`);
    console.log(`   ALOP ${alop.id}  status=${alop.status}  ord_flow_id=${alop.ord_flow_id}`);

    if (!APPLY) {
      console.log('\n🔎 DRY-RUN — nimic scris. Rulează cu --apply pentru execuție.');
      await client.query('ROLLBACK');
      process.exit(0);
    }

    await client.query(
      `UPDATE flows SET deleted_at = NOW(), deleted_by = $2 WHERE id = $1`,
      [FLOW_ID, ADMIN_ACTOR_EMAIL]
    );

    await client.query(
      `UPDATE formulare_ord SET flow_id = NULL, updated_by = $2, updated_at = NOW() WHERE id = $1`,
      [ORD_ID, ADMIN_ACTOR_ID]
    );

    const { rows: [alopAfter] } = await client.query(
      `UPDATE alop_instances
       SET ord_flow_id = NULL,
           ord_completed_at = NULL,
           status = 'ordonantare',
           updated_by = $2,
           updated_at = NOW()
       WHERE id = $1
       RETURNING id, status, ord_flow_id, ord_completed_at`,
      [alop.id, ADMIN_ACTOR_ID]
    );

    await client.query(
      `INSERT INTO audit_log (flow_id, org_id, event_type, actor_email, payload)
       VALUES ($1, $2, $3, $4, $5)`,
      [
        FLOW_ID,
        ord.org_id,
        'FLOW_ADMIN_DATA_REPAIR',
        ADMIN_ACTOR_EMAIL,
        JSON.stringify({
          reason: 'ORD semnat doar de inițiator (single-signer), document nu a ieșit din instituție — reparație de date, nu corecție financiară',
          ordId: ORD_ID,
          alopId: alop.id,
          recon: 'RECON-ord-neconform-flux-finalizat.md',
        }),
      ]
    );

    console.log('\n✅ Aplicat:');
    console.log(`   flows.deleted_at = NOW()  (flow ${FLOW_ID})`);
    console.log(`   formulare_ord.flow_id = NULL  (ord ${ORD_ID})`);
    console.log(`   alop_instances → status=${alopAfter.status}, ord_flow_id=${alopAfter.ord_flow_id}, ord_completed_at=${alopAfter.ord_completed_at}`);
    console.log('   audit_log: FLOW_ADMIN_DATA_REPAIR scris');
    console.log('\n⚠️  Notă: trigger-ul alop_status_guard va loga o violare (plata→ordonantare nu e în matrice) în alop_status_log — AȘTEPTAT, poarta e în mod observare.');

    await client.query('COMMIT');
    console.log('\n✅ COMMIT reușit.');
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
} catch (e) {
  console.error('❌ Eroare (ROLLBACK aplicat):', e.message || e.code || String(e));
  process.exit(1);
} finally {
  await pool.end();
}
