// Anti-shadowing (Etapa 2 refactor — split formulare-db.mjs → routes/formulare/).
// Confirmă că ruta STATICĂ GET /api/formulare-df/aprobate NU e prinsă de ruta
// PARAM GET /api/formulare-df/:id după split. Express potrivește în ordinea
// înregistrării; dacă `:id` ar fi înaintea lui `aprobate`, am primi handlerul de
// document unic (cu id="aprobate") → 404/eroare în loc de lista de DF aprobate.
import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';
import { buildApp } from './helpers/app.mjs';

const d = describe.skipIf(!hasTestDb());

// #167 — fișierul are DOUĂ describe-uri; pool-ul se închide O SINGURĂ DATĂ, la nivel de FIȘIER.
// Un `afterAll(() => pool.end())` în primul describe l-ar închide înainte ca al doilea să ruleze.
if (hasTestDb()) afterAll(() => pool.end());

d('GET /api/formulare-df/aprobate (anti-shadowing)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' }); // id 1, org 1
    app = buildApp();
  });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  it('NU e prins de :id → 200 + listă (nu handler de document unic)', async () => {
    const res = await request(app).get('/api/formulare-df/aprobate').set('Cookie', cookie());
    // handlerul corect (listă aprobate) răspunde 200; handlerul :id ar da 404 (id="aprobate" inexistent)
    expect(res.status).toBe(200);
    // forma de listă: { ok: true, documents: [...] }, nu un singur { document }
    expect(Array.isArray(res.body.documents)).toBe(true);
    expect(res.body.document).toBeUndefined();
  });
});

/**
 * #167 — ruta /aprobate alimentează dropdown-ul din care se alege DF-ul unei ORDONANȚĂRI NOI,
 * deci nu e „doar afișare": forma laxă de dinainte (status='completed' OR completed=true, fără
 * deleted_at / cancelled / refused) lăsa în listă DF-uri cu aprobarea DESFĂCUTĂ. Acum ruta
 * folosește sursa unică `dfAprobatSql` din services/df-aprobat-sql.mjs.
 */
d('#167 — /aprobate întoarce doar aprobări vii', () => {
  let app, orgId, userId;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId, userId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro' }));
    app = buildApp();
  });
  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1 });

  const aprobate = async () => {
    const res = await request(app).get('/api/formulare-df/aprobate').set('Cookie', cookie());
    expect(res.status).toBe(200);
    return res.body.documents;
  };
  const setFlowStatus = (flowId, status) => pool.query(
    `UPDATE flows SET data = jsonb_set(data, '{status}', to_jsonb($2::text)) WHERE id=$1`, [flowId, status]);
  const softDeleteFlow = (flowId) => pool.query(`UPDATE flows SET deleted_at = NOW() WHERE id=$1`, [flowId]);

  // Flux finalizat, cu `completed:true` PĂSTRAT în JSONB (istoric corect — vezi #164).
  const dfPeFlux = async ({ nrUnic = 'DF-2026-001', revizieNr = 0, sourceAlopId = null } = {}) => {
    const flowId = await seedFlow({ orgId, completed: true });
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'aprobat', flowId, nrUnic, revizieNr, sourceAlopId });
    return { dfId, flowId };
  };

  it('1) DF cu flux viu finalizat ⇒ PREZENT', async () => {
    const { dfId } = await dfPeFlux();
    expect((await aprobate()).map(d => d.id)).toContain(dfId);
  });

  it('2) ⭐ DF cu flux ANULAT ADMINISTRATIV (soft-șters + cancelled + completed păstrat) ⇒ ABSENT', async () => {
    const { dfId, flowId } = await dfPeFlux();
    await setFlowStatus(flowId, 'cancelled');
    await softDeleteFlow(flowId);
    expect((await aprobate()).map(d => d.id)).not.toContain(dfId);
  });

  it('3) ⭐ DF cu flux ANULAT obișnuit (cancelled, fără soft-delete) ⇒ ABSENT', async () => {
    const { dfId, flowId } = await dfPeFlux();
    await setFlowStatus(flowId, 'cancelled');
    expect((await aprobate()).map(d => d.id)).not.toContain(dfId);
  });

  it('4) ⭐ DF cu flux REFUZAT purtând finalizarea ⇒ ABSENT', async () => {
    const { dfId, flowId } = await dfPeFlux();
    await setFlowStatus(flowId, 'refused');
    expect((await aprobate()).map(d => d.id)).not.toContain(dfId);
  });

  it('5) DF fără flux ⇒ absent (neschimbat)', async () => {
    const dfId = await seedDf({ orgId, createdBy: userId, status: 'draft', nrUnic: 'DF-FARA-FLUX' });
    expect((await aprobate()).map(d => d.id)).not.toContain(dfId);
  });

  it('6) ⭐ dedup: R1 aprobată + R2 cu flux anulat ⇒ EXACT un rând, iar acela e R1', async () => {
    // Același dosar: fără source_alop_id, cheia de lanț cade pe nr_unic_inreg (identic la
    // ambele revizii) — vezi services/df-dosar-key.mjs.
    const r1 = await dfPeFlux({ nrUnic: 'DF-2026-DEDUP', revizieNr: 1 });
    const r2 = await dfPeFlux({ nrUnic: 'DF-2026-DEDUP', revizieNr: 2 });
    await setFlowStatus(r2.flowId, 'cancelled');

    const docs = (await aprobate()).filter(d => d.nr_unic_inreg === 'DF-2026-DEDUP');
    expect(docs).toHaveLength(1);
    expect(docs[0].id).toBe(r1.dfId);
    expect(docs[0].revizie_nr).toBe(1);   // filtrarea se aplică ÎNAINTE de DISTINCT ON
  });
});
