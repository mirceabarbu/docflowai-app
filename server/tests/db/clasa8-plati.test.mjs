/**
 * test:db — #198: Clasa 8, coloana Plăți — proporția care nu se închide + filtrele
 * care nu ajung la plăți.
 *
 * Defectul 1: `ord_totals` (numitorul regulii de trei) numără TOATE rândurile ORD;
 * `ord_rows_ssi` (numărătorul) numără doar rândurile cu `cod_SSI` completat și sumă
 * pozitivă. Un ORD cu fie și un singur rând fără cod face ca suma proporțiilor să
 * iasă sub 1 ⇒ plata repartizată e mai mică decât `plata_suma_efectiva` — pierdere
 * tăcută. Aceeași formă ca bugul OPME din 04.08.
 *
 * Defectul 2: `ordCompFilter`/`ordQFilter` se aplică la `angajamente`/`ordonantari`,
 * dar la niciun CTE de plăți — filtrarea pe compartiment/text lasă Plăți totală în
 * timp ce primele trei coloane scad.
 *
 * Scris ÎNAINTE de corecție — cazurile 1 și 5 pică pe codul vechi.
 *
 * Rulează pe Postgres 17 efemer (vezi CLAUDE.md §test:db).
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedAlop, seedOrd } from '../helpers/db-real.mjs';
import { getClasa8Aggregate } from '../../services/clasa8.mjs';

const d = describe.skipIf(!hasTestDb());

const SSI  = '810101';
const SSI2 = '810102';

const itemFor = (result, cod) => result.items.find(x => x.cod_ssi === cod);

// Confirmă plata pe ciclul CURENT (alop_instances) — seedAlop nu expune
// plata_confirmed_at, deci se completează separat.
async function confirmPlataCurent(alopId, ordId, plataSuma) {
  await pool.query(
    `UPDATE alop_instances SET ord_id=$2, plata_suma_efectiva=$3, plata_confirmed_at=NOW() WHERE id=$1`,
    [alopId, ordId, plataSuma]
  );
}

// Arhivează un ciclu plătit în alop_ord_cicluri (a doua sursă din plati_sources).
async function seedCicluPlatit({ alopId, orgId, ordId, plataSuma, cicluNr = 1 }) {
  await pool.query(
    `INSERT INTO alop_ord_cicluri (alop_id, org_id, ciclu_nr, ord_id, plata_confirmed_at, plata_suma_efectiva, status)
     VALUES ($1,$2,$3,$4,NOW(),$5,'platit')`,
    [alopId, orgId, cicluNr, ordId, plataSuma]
  );
}

async function setOrdMeta(ordId, { compartiment, beneficiar } = {}) {
  if (compartiment !== undefined) {
    await pool.query(`UPDATE formulare_ord SET compartiment_specialitate=$2 WHERE id=$1`, [ordId, compartiment]);
  }
  if (beneficiar !== undefined) {
    await pool.query(`UPDATE formulare_ord SET beneficiar=$2 WHERE id=$1`, [ordId, beneficiar]);
  }
}

d('#198 — Clasa 8, coloana Plăți: proporția și filtrele', () => {
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user' }); // org 1, user 1
  });
  afterAll(() => pool.end());

  // ── 1. ⭐⭐ PROPORȚIA nu se închide când un rând ORD n-are cod_SSI ──────────
  it('1. ⭐⭐ ORD cu 2 rânduri codate (100+100) + 1 nefcodat (200), plată 300 ⇒ Plăți = 300, nu 150', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ord = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [
        { cod_SSI: SSI, suma_ordonantata_plata: '100' },
        { cod_SSI: SSI, suma_ordonantata_plata: '100' },
        { suma_ordonantata_plata: '200' }, // fără cod_SSI — cel care rupe proporția
      ],
    });
    await confirmPlataCurent(alop, ord, '300');

    const agg = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(agg, SSI);
    expect(item).toBeTruthy();
    expect(item.plati).toBe(300);
  });

  // ── 2. ⭐ INVARIANT: suma pe coduri = suma plătită ──────────────────────────
  it('2. ⭐ invariant general: SUM(plati pe toate codurile) = plata_suma_efectiva, indiferent de rânduri necodate', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ord = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [
        { cod_SSI: SSI,  suma_ordonantata_plata: '100' },
        { cod_SSI: SSI2, suma_ordonantata_plata: '100' },
        { suma_ordonantata_plata: '200' }, // fără cod_SSI
      ],
    });
    await confirmPlataCurent(alop, ord, '300');

    const agg = await getClasa8Aggregate(pool, 1, {});
    const suma = (itemFor(agg, SSI)?.plati || 0) + (itemFor(agg, SSI2)?.plati || 0);
    expect(suma).toBe(300);
  });

  // ── 3. ANTI-REGRESIE: cazul normal, toate rândurile codate ─────────────────
  it('3. anti-regresie: toate rândurile ORD au cod_SSI (200+300), plată 500 ⇒ 200 și 300, neschimbat', async () => {
    const alop = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ord = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [
        { cod_SSI: SSI,  suma_ordonantata_plata: '200' },
        { cod_SSI: SSI2, suma_ordonantata_plata: '300' },
      ],
    });
    await confirmPlataCurent(alop, ord, '500');

    const agg = await getClasa8Aggregate(pool, 1, {});
    expect(itemFor(agg, SSI).plati).toBe(200);
    expect(itemFor(agg, SSI2).plati).toBe(300);
  });

  // ── 4. ANTI-REGRESIE: două surse (ciclu arhivat + ciclu curent) se adună ───
  it('4. anti-regresie: un ciclu arhivat + ciclul curent, pe ORD-uri diferite, contribuie amândouă pe același cod', async () => {
    const alopArhivat = await seedAlop({ orgId: 1, createdBy: 1, status: 'completed' });
    const ordArhivat = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '100' }],
    });
    await seedCicluPlatit({ alopId: alopArhivat, orgId: 1, ordId: ordArhivat, plataSuma: '100' });

    const alopCurent = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordCurent = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '100' }],
    });
    await confirmPlataCurent(alopCurent, ordCurent, '200');

    const agg = await getClasa8Aggregate(pool, 1, {});
    expect(itemFor(agg, SSI).plati).toBe(300);
  });

  // ── 5. ⭐ FILTRUL DE COMPARTIMENT nu ajunge la plăți ────────────────────────
  it('5. ⭐ filtrul de compartiment: cu compartiment = al primului ORD, Plăți conține DOAR plata acestuia', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordA = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '100' }],
    });
    await setOrdMeta(ordA, { compartiment: 'Compartiment A' });
    await confirmPlataCurent(alopA, ordA, '100');

    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordB = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat', nrOrd: 'ORD-2026-002',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '200' }],
    });
    await setOrdMeta(ordB, { compartiment: 'Compartiment B' });
    await confirmPlataCurent(alopB, ordB, '200');

    const agg = await getClasa8Aggregate(pool, 1, { compartiment: 'Compartiment A' });
    const item = itemFor(agg, SSI);
    expect(item).toBeTruthy();
    expect(item.plati).toBe(100);
  });

  // ── 6. filtrul de text (q) nu ajunge la plăți ───────────────────────────────
  it('6. filtrul de text (q): cu q = beneficiarul primului ORD, Plăți conține DOAR plata acestuia', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordA = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '100' }],
    });
    await setOrdMeta(ordA, { beneficiar: 'SC Beneficiar Alfa SRL' });
    await confirmPlataCurent(alopA, ordA, '100');

    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordB = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat', nrOrd: 'ORD-2026-002',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '200' }],
    });
    await setOrdMeta(ordB, { beneficiar: 'SC Beneficiar Beta SRL' });
    await confirmPlataCurent(alopB, ordB, '200');

    const agg = await getClasa8Aggregate(pool, 1, { q: 'Alfa' });
    const item = itemFor(agg, SSI);
    expect(item).toBeTruthy();
    expect(item.plati).toBe(100);
  });

  // ── 7. ANTI-REGRESIE: fără filtru, ambele ORD-uri contribuie ────────────────
  it('7. anti-regresie: fără niciun filtru, ambele ORD-uri contribuie la Plăți', async () => {
    const alopA = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordA = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '100' }],
    });
    await setOrdMeta(ordA, { compartiment: 'Compartiment A', beneficiar: 'SC Beneficiar Alfa SRL' });
    await confirmPlataCurent(alopA, ordA, '100');

    const alopB = await seedAlop({ orgId: 1, createdBy: 1, status: 'plata' });
    const ordB = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat', nrOrd: 'ORD-2026-002',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '200' }],
    });
    await setOrdMeta(ordB, { compartiment: 'Compartiment B', beneficiar: 'SC Beneficiar Beta SRL' });
    await confirmPlataCurent(alopB, ordB, '200');

    const agg = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(agg, SSI);
    expect(item).toBeTruthy();
    expect(item.plati).toBe(300);
  });

  // ── 8. DOCUMENTEAZĂ (nu repară): ciclu arhivat al unui dosar ANULAT ────────
  it('8. documentează comportamentul actual: ciclu arhivat al unui dosar cu cancelled_at setat TOT contribuie la Plăți', async () => {
    const alopAnulat = await seedAlop({
      orgId: 1, createdBy: 1, status: 'completed', cancelledAt: new Date(),
    });
    const ord = await seedOrd({
      orgId: 1, createdBy: 1, status: 'aprobat',
      rows: [{ cod_SSI: SSI, suma_ordonantata_plata: '100' }],
    });
    await seedCicluPlatit({ alopId: alopAnulat, orgId: 1, ordId: ord, plataSuma: '100' });

    const agg = await getClasa8Aggregate(pool, 1, {});
    const item = itemFor(agg, SSI);
    // Comportament ACTUAL (necorectat în acest lot): plati_sources (ramura
    // alop_ord_cicluri) nu verifică cancelled_at al ALOP-ului părinte ⇒ ciclul
    // arhivat al unui dosar anulat continuă să contribuie la Plăți.
    expect(item).toBeTruthy();
    expect(item.plati).toBe(100);
  });
});
