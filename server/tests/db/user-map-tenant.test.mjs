/**
 * SEC-101 (TENANT-01) — getUserMapForOrg pe Postgres real.
 *
 * Dovedește pe schema fresh:
 *   5. izolare pe org (harta org A NU conține emailuri din org B)
 *   6. `deleted_at IS NULL` (userul soft-șters lipsește din hartă)
 *   7. email reutilizat ⇒ harta preia rândul ACTIV, nu cel șters (bug-ul nr. 2)
 *
 * Importă funcția REALĂ din db/index.mjs (pool real; NU e mock-uit în testele DB).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool, seedOrgUser } from '../helpers/db-real.mjs';
import { getUserMapForOrg, invalidateOrgUserCache } from '../../db/index.mjs';

const d = describe.skipIf(!hasTestDb());

d('SEC-101 — getUserMapForOrg (Postgres real)', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    invalidateOrgUserCache(0);   // cache TTL 60s + id-uri SERIAL resetate ⇒ golește între teste
  });
  afterAll(() => pool.end());

  it('5. izolare pe org — harta org A conține DOAR emailul din A', async () => {
    const { orgId: orgA } = await seedOrgUser({ orgName: 'Org A SEC101', email: 'a@sec101.ro', role: 'user' });
    await seedOrgUser({ orgName: 'Org B SEC101', email: 'b@sec101.ro', role: 'user' });

    const map = await getUserMapForOrg(orgA);
    expect(map['a@sec101.ro']).toBeTruthy();
    expect(map['b@sec101.ro']).toBeUndefined();
  });

  it('6. user soft-șters ⇒ absent din hartă', async () => {
    const { orgId: orgA } = await seedOrgUser({ orgName: 'Org A SEC101', email: 'a@sec101.ro', role: 'user' });
    await pool.query(`UPDATE users SET deleted_at = NOW() WHERE lower(email) = 'a@sec101.ro'`);

    const map = await getUserMapForOrg(orgA);
    expect(map['a@sec101.ro']).toBeUndefined();
  });

  it('7. email reutilizat ⇒ harta preia rândul ACTIV (funcția „NOU"), nu cel șters', async () => {
    const { orgId: orgA } = await seedOrgUser({ orgName: 'Org A SEC101', email: 'seed@sec101.ro', role: 'user' });

    // vechi, soft-șters, cu functie 'VECHI'
    await pool.query(
      `INSERT INTO users (email, password_hash, nume, role, functie, org_id, deleted_at)
       VALUES ('x@y.ro', 'x', 'Vechi', 'user', 'VECHI', $1, NOW())`,
      [orgA]
    );
    // nou, activ, ACELAȘI email, cu functie 'NOU'
    await pool.query(
      `INSERT INTO users (email, password_hash, nume, role, functie, org_id)
       VALUES ('x@y.ro', 'x', 'Nou', 'user', 'NOU', $1)`,
      [orgA]
    );

    const map = await getUserMapForOrg(orgA);
    expect(map['x@y.ro']).toBeTruthy();
    expect(map['x@y.ro'].functie).toBe('NOU');
  });
});
