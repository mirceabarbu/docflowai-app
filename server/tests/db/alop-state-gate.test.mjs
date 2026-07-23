/**
 * #95 — Poarta de stări ALOP în Postgres (FAZA 1, MOD OBSERVARE).
 * Exercită trigger-ele REALE pe Postgres real (migrațiile inline 093/094):
 *   - CHECK `alop_status_valid` pe status
 *   - trigger de audit `trg_alop_status_audit` (AFTER UPDATE) → alop_status_log
 *   - trigger de validare `trg_alop_status_guard` (BEFORE UPDATE, observare) → violation=TRUE
 *
 * ⛔ NU redeclara matricea în JS. Testele lovesc trigger-ul real; matricea trăiește DOAR în SQL
 * (migrarea 094). Faza 1 NU blochează — testul-cheie (#3) dovedește că o tranziție invalidă
 * REUȘEȘTE și doar se loghează.
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

  // 1 — CHECK constraint
  it('CHECK: UPDATE la status inexistent → eroare de constrângere', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    await expect(
      pool.query("UPDATE alop_instances SET status='inexistent' WHERE id=$1", [id])
    ).rejects.toThrow(/alop_status_valid|check constraint/i);
    expect((await getAlop(id)).status).toBe('draft');
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

  // 3 — TESTUL-CHEIE: tranziție invalidă REUȘEȘTE (faza 1 nu blochează) + violation=TRUE
  it('tranziție invalidă draft → completed: REUȘEȘTE + 1 rând violation=TRUE (+1 audit)', async () => {
    const id = await seedAlop({ orgId: 1, createdBy: 1, status: 'draft' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['completed', id]);
    // Faza 1 NU blochează — tranziția s-a aplicat.
    expect((await getAlop(id)).status).toBe('completed');
    const rows = await logFor(id);
    // Dublă înregistrare intenționată: guard (violation=TRUE, BEFORE) + audit (violation=FALSE, AFTER).
    const viol = rows.filter(r => r.violation === true);
    const audit = rows.filter(r => r.violation === false);
    expect(viol.length).toBe(1);
    expect(audit.length).toBe(1);
    expect(viol[0].from_status).toBe('draft');
    expect(viol[0].to_status).toBe('completed');
  });

  // 3b — #113a: plata → ordonantare NU mai e violare (adăugată în matrice de migrația 103),
  // dar plata → draft (tranziție inventată) ÎNCĂ e violare. Dovedește că 103 a extins matricea
  // EXACT cu o singură intrare, fără să slăbească restul porții.
  it('#113a: plata → ordonantare NU scrie violation; plata → draft ÎNCĂ scrie violation', async () => {
    const idOk = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['ordonantare', idOk]);
    expect((await getAlop(idOk)).status).toBe('ordonantare');
    const okRows = await logFor(idOk);
    // Doar auditul (violation=FALSE), zero violări.
    expect(okRows.filter(r => r.violation === true).length).toBe(0);
    expect(okRows.filter(r => r.violation === false).length).toBe(1);

    const idBad = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    await pool.query('UPDATE alop_instances SET status=$1, updated_by=1 WHERE id=$2', ['draft', idBad]);
    const badRows = await logFor(idBad);
    expect(badRows.filter(r => r.violation === true).length).toBe(1);
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
