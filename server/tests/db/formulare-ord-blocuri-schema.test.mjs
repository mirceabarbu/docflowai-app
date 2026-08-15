/**
 * #128b — fundația ORD multi-bloc (migrația inline 105_formulare_ord_blocuri).
 * Apără decizia „fără backfill": coloana `blocuri` există, e jsonb, e nullable, și un
 * INSERT minimal (via seedOrd, care nu trimite `blocuri`) o lasă NULL.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { hasTestDb, migrate, pool, seedOrgUser, seedOrd } from '../helpers/db-real.mjs';

const d = describe.skipIf(!hasTestDb());

d('formulare_ord.blocuri — schemă (fresh-provision, fără backfill)', () => {
  beforeAll(migrate);

  it('coloana blocuri există, tip jsonb, nullable', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable FROM information_schema.columns
        WHERE table_schema='public' AND table_name='formulare_ord' AND column_name='blocuri'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('jsonb');
    expect(rows[0].is_nullable).toBe('YES');
  });

  it('INSERT minimal (seedOrd, fără blocuri) rămâne NULL pe coloana blocuri', async () => {
    const { orgId, userId } = await seedOrgUser({ orgName: 'Org Blocuri Test', email: 'p1-blocuri@x.ro' });
    const ordId = await seedOrd({ orgId, createdBy: userId });
    const { rows } = await pool.query(
      `SELECT blocuri FROM formulare_ord WHERE id=$1`, [ordId]
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].blocuri).toBeNull();
  });
});
