/**
 * #95 — Poarta de stări ALOP în Postgres. ⚠️ ACTUALIZAT LA #138: poarta a fost FLIPATĂ din
 * modul observare în modul BLOCARE (migrarea 109, RAISE EXCEPTION). Asserțiile care descriau
 * faza 1 („tranziția invalidă REUȘEȘTE și doar se loghează") au fost înlocuite deliberat.
 *
 * Exercită trigger-ele REALE pe Postgres real (migrațiile inline 093/094/103/109):
 *   - CHECK `alop_status_valid` pe status (poarta pe INSERT)
 *   - trigger de audit `trg_alop_status_audit` (AFTER UPDATE) → alop_status_log
 *   - trigger de validare `trg_alop_status_guard` (BEFORE UPDATE, BLOCANT) → RAISE EXCEPTION
 *
 * ⛔ NU redeclara matricea în JS. Testele lovesc trigger-ul real; matricea trăiește DOAR în SQL.
 * Acoperirea dedicată a modului blocare: `server/tests/db/alop-gate-enforcing.test.mjs`.
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser, seedAlop, getAlop } from '../helpers/db-real.mjs';

const d = describe.skipIf(!hasTestDb());

// alop_status_log NU are FK spre alop_instances (auditul supraviețuiește ștergerii) → truncateAll
// (CASCADE de la alop_instances) NU-l atinge; îl curățăm explicit.
async function clearLog() { await pool.query('TRUNCATE alop_status_log RESTART IDENTITY'); }
async function logFor(id) {
  const { rows } = await pool.query('SELECT * FROM alop_status_log WHERE alop_id=$1 ORDER BY id', [id]);
  return rows;
}

// Matricea reală (ALOP-STATE-MATRIX.md). Sursă de adevăr = SQL; aici DOAR pentru a genera cazuri
// de test, NU pentru a valida logica (validarea o face trigger-ul).
const VALID = [
  ['draft', 'angajare'], ['draft', 'lichidare'], ['draft', 'cancelled'],
  ['angajare', 'lichidare'], ['angajare', 'plata'], ['angajare', 'cancelled'],
  ['lichidare', 'ordonantare'], ['lichidare', 'cancelled'],
  ['ordonantare', 'plata'], ['ordonantare', 'cancelled'],
  ['plata', 'completed'], ['plata', 'cancelled'],
  ['plata', 'ordonantare'], // #113a — admin-cancel pe ORD (migrația 103)
  ['completed', 'lichidare'],
]; // 14 tranziții valide (13 + plata→ordonantare)

d('#95 — poarta de stări ALOP (trigger real pe Postgres)', () => {
  beforeAll(migrate);
  beforeEach(async () => { await truncateAll(); await clearLog(); await seedOrgUser({ role: 'user' }); });
  afterAll(() => pool.end());

  // 1 — status inexistent: respins pe AMBELE căi, dar de gărzi DIFERITE.
  // ⚠️ Schimbare de ordine adusă de #138 (migrarea 109): trigger-ul BEFORE UPDATE rulează
  // ÎNAINTEA evaluării CHECK-urilor. Cât timp guard-ul doar avertiza (faza 1), UPDATE-ul
  // ajungea la CHECK `alop_status_valid`; acum guard-ul aruncă primul, deci mesajul e al lui.
  // NU e o slăbire — respingerea rămâne, doar sursa erorii diferă. CHECK-ul rămâne poarta
  // pentru INSERT, pe care trigger-ul (BEFORE UPDATE) nu-l acoperă deloc — asertat mai jos.
  it('UPDATE la status inexistent → respins de poartă (guard, înaintea CHECK-ului)', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    await expect(
      pool.query("UPDATE alop_instances SET status='inexistent' WHERE id=$1", [id])
    ).rejects.toThrow(/ALOP transition violation: draft -> inexistent/);
    expect((await getAlop(id)).status).toBe('draft');
  });
  it('CHECK alop_status_valid rămâne poarta pe INSERT (trigger-ul e doar BEFORE UPDATE)', async () => {
    await expect(
      pool.query(
        `INSERT INTO alop_instances (org_id, created_by, status, titlu) VALUES (1, 1, 'inexistent', 'X')`
      )
    ).rejects.toThrow(/alop_status_valid|check constraint/i);
  });

  // 2 — fiecare tranziție validă → reușește + exact 1 rând violation=FALSE
  it.each(VALID)('tranziție validă %s → %s: 1 rând audit (violation=FALSE), fără violare', async (from, to) => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: from });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', [to, id]);
    expect((await getAlop(id)).status).toBe(to);
    const rows = await logFor(id);
    expect(rows.length).toBe(1);
    expect(rows[0].violation).toBe(false);
    expect(rows[0].from_status).toBe(from);
    expect(rows[0].to_status).toBe(to);
    expect(rows[0].changed_by).toBe(1);
  });

  // 3 — TESTUL-CHEIE, ACTUALIZAT LA #138: după flipul porții (migrarea 109) o tranziție
  // invalidă NU mai „reușește + se loghează" — ARUNCĂ, iar tranzacția se abortează, deci
  // nici rândul de violare (guard, BEFORE) nici cel de audit (093, AFTER) nu se mai scriu.
  // Vechea asserție (observare: REUȘEȘTE + violation=TRUE) descria faza 1 și a fost înlocuită
  // deliberat, nu „reparată". Acoperire extinsă: server/tests/db/alop-gate-enforcing.test.mjs.
  it('#138: tranziție invalidă draft → completed ARUNCĂ, rândul rămâne draft, log gol', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    await expect(
      pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['completed', id])
    ).rejects.toThrow(/ALOP transition violation: draft -> completed/);
    expect((await getAlop(id)).status).toBe('draft');
    expect(await logFor(id)).toEqual([]);
  });

  // 3b — #113a: plata → ordonantare e în matrice (migrația 103) ⇒ TRECE; plata → draft
  // (tranziție inventată) e respinsă. Dovedește că 103 a extins matricea EXACT cu o singură
  // intrare, iar 109 (#138) a transformat restul porții din avertisment în blocaj real.
  it('#113a: plata → ordonantare TRECE; plata → draft e RESPINSĂ (poartă activă)', async () => {
    const idOk = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['ordonantare', idOk]);
    expect((await getAlop(idOk)).status).toBe('ordonantare');
    const okRows = await logFor(idOk);
    // Doar auditul (violation=FALSE), zero violări.
    expect(okRows.filter(r => r.violation === true).length).toBe(0);
    expect(okRows.filter(r => r.violation === false).length).toBe(1);

    const idBad = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    await expect(
      pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['draft', idBad])
    ).rejects.toThrow(/ALOP transition violation/);
    expect((await getAlop(idBad)).status).toBe('plata');
  });

  // 4 — self-loop → zero rânduri
  it('self-loop angajare → angajare: zero rânduri în log', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare' });
    await pool.query("UPDATE alop_instances SET status='angajare' WHERE id=$1", [id]);
    expect((await logFor(id)).length).toBe(0);
  });

  // 5 — update fără schimbare de status → zero rânduri
  it('update fără schimbare de status (doar titlu) → zero rânduri în log', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: 'A' });
    await pool.query("UPDATE alop_instances SET titlu='B' WHERE id=$1", [id]);
    expect((await logFor(id)).length).toBe(0);
  });

  // 6 — changed_by din updated_by (setat vs NULL = cale de semnare)
  it('changed_by: populat din updated_by când e setat', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['angajare', id]);
    expect((await logFor(id))[0].changed_by).toBe(1);
  });
  it('changed_by: NULL pe calea automată (updated_by neschimbat)', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' }); // updated_by NULL din seed
    await pool.query("UPDATE alop_instances SET status='angajare' WHERE id=$1", [id]);
    expect((await logFor(id))[0].changed_by).toBeNull();
  });

  // 7 — bulk pe 3 rânduri → 3 rânduri în log (FOR EACH ROW)
  it('bulk UPDATE pe 3 rânduri → 3 rânduri în log', async () => {
    for (let i = 0; i < 3; i++) await seedAlop({ orgId: 1, createdBy: 1, status: 'angajare', titlu: `A${i}` });
    await pool.query("UPDATE alop_instances SET status='lichidare' WHERE org_id=1 AND status='angajare'");
    const { rows } = await pool.query(
      "SELECT COUNT(*)::int c FROM alop_status_log WHERE from_status='angajare' AND to_status='lichidare'"
    );
    expect(rows[0].c).toBe(3);
  });

  // 8 — atomicitate: UPDATE + ROLLBACK → zero rânduri (ce writeAuditEvent nu poate garanta)
  it('atomicitate: UPDATE + ROLLBACK → zero rânduri în log', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("UPDATE alop_instances SET status='angajare' WHERE id=$1", [id]);
      await client.query('ROLLBACK');
    } finally { client.release(); }
    expect((await logFor(id)).length).toBe(0);
    expect((await getAlop(id)).status).toBe('draft');
  });
});
