/**
 * #128n (v3.9.774) — capturi de ecran per BLOC de furnizor (`formulare_capturi.bloc_idx`).
 *
 * Rulează rutele REALE peste Postgres real, pe modelul `atasamente-bloc-idx.test.mjs` (#128m).
 * ⚠️ Ruta de capturi citește corpul BRUT din stream (`req.on('data')`), NU `express.json` ⇒
 * în supertest se trimite `Buffer` cu `Content-Type: image/png` și numele în `X-Filename`.
 *
 * Cazul ⭐ 1 e capcana lotului: fără `bloc_idx` în cheia DELETE-ului, captura furnizorului 2
 * o ȘTERGE tăcut pe a furnizorului 1, iar utilizatorul vede confirmare de succes.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');

function buildRealApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use((req, res, next) => express.json({ limit: '1mb' })(req, res, next));
  app.use('/', formulareDbRouter);
  return app;
}

const CSRF = 'test-csrf-token-cap-bloc';
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;
const P1 = { userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' };

const d = describe.skipIf(!hasTestDb());

d('#128n — capturi per bloc de furnizor (bloc_idx)', () => {
  let app, orgId, ordId, dfId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro', compartiment: 'Achizitii' }));
    ordId = await seedOrd({ orgId, createdBy: 1, status: 'draft', nrOrd: 'ORD-128N-1' });
    dfId  = await seedDf({ orgId, createdBy: 1, status: 'draft', nrUnic: 'DF-128N-1' });
    app = buildRealApp();
  });
  afterAll(() => pool.end());

  // `qs` = query string COMPLET (ex. '', '?bloc=1', '?slot=2&bloc=1') — testăm și absența lui.
  const upload = (type, id, qs, { filename = 'captura.png', body = 'PNG-BYTES' } = {}) =>
    request(app)
      .post(`/api/formulare-capturi/${type}/${id}${qs}`)
      .set('Cookie', authz(P1))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'image/png')
      .set('X-Filename', filename)
      .send(Buffer.from(body));

  const get = (type, id, qs) =>
    request(app)
      .get(`/api/formulare-capturi/${type}/${id}${qs}`)
      .set('Cookie', authz(P1));

  const rowsOf = async (id) => {
    const { rows } = await pool.query(
      `SELECT filename, slot, bloc_idx, encode(data,'escape') AS body
         FROM formulare_capturi WHERE form_id=$1 ORDER BY created_at ASC, id ASC`, [id]);
    return rows;
  };

  // ── 1 ⭐ CAPCANA LOTULUI ────────────────────────────────────────────────────
  it('1 ⭐ captura blocului 1 NU o mai șterge pe a blocului 0 (două rânduri, ambele intacte)', async () => {
    const up0 = await upload('ord', ordId, '?slot=1&bloc=0', { filename: 'b0.png', body: 'BLOC-0' });
    expect(up0.status).toBe(200);
    expect(up0.body.captura.bloc_idx).toBe(0);

    const up1 = await upload('ord', ordId, '?slot=1&bloc=1', { filename: 'b1.png', body: 'BLOC-1' });
    expect(up1.status).toBe(200);
    expect(up1.body.captura.bloc_idx).toBe(1);

    // Fără fix: UN singur rând (al blocului 1), captura blocului 0 ștearsă tăcut.
    const rows = await rowsOf(ordId);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.bloc_idx).sort()).toEqual([0, 1]);
    expect(rows.find(r => r.bloc_idx === 0).body).toBe('BLOC-0');
    expect(rows.find(r => r.bloc_idx === 1).body).toBe('BLOC-1');
  });

  // ── 2 — „ultima câștigă", restrâns la bloc ─────────────────────────────────
  it('2 două capturi succesive pe ACELAȘI (slot, bloc) → UN singur rând, ultima câștigă', async () => {
    await upload('ord', ordId, '?slot=1&bloc=1', { filename: 'v1.png', body: 'VECHI' });
    await upload('ord', ordId, '?slot=1&bloc=1', { filename: 'v2.png', body: 'NOU' });

    const rows = await rowsOf(ordId);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('v2.png');
    expect(rows[0].body).toBe('NOU');
  });

  // ── 3 — slot și bloc sunt ORTOGONALE ───────────────────────────────────────
  it('3 (slot=1,bloc=1) și (slot=2,bloc=1) coexistă → două rânduri', async () => {
    await upload('ord', ordId, '?slot=1&bloc=1', { filename: 's1.png', body: 'SLOT-1' });
    await upload('ord', ordId, '?slot=2&bloc=1', { filename: 's2.png', body: 'SLOT-2' });

    const rows = await rowsOf(ordId);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => `${r.slot}/${r.bloc_idx}`).sort()).toEqual(['1/1', '2/1']);
  });

  // ── 4 — GET discriminează pe bloc ──────────────────────────────────────────
  it('4 GET ?slot=1&bloc=1 întoarce captura blocului 1; GET ?slot=1 (fără bloc) pe a blocului 0', async () => {
    await upload('ord', ordId, '?slot=1&bloc=0', { filename: 'b0.png', body: 'BLOC-0' });
    await upload('ord', ordId, '?slot=1&bloc=1', { filename: 'b1.png', body: 'BLOC-1' });

    const r1 = await get('ord', ordId, '?slot=1&bloc=1');
    expect(r1.status).toBe(200);
    expect(r1.body.toString()).toBe('BLOC-1');

    const r0 = await get('ord', ordId, '?slot=1');
    expect(r0.status).toBe(200);
    expect(r0.body.toString()).toBe('BLOC-0');
  });

  // ── 5 — rând LEGACY (bloc_idx NULL) ────────────────────────────────────────
  it('5 rând legacy cu bloc_idx NULL e citit de GET fără ?bloc (COALESCE → 0)', async () => {
    await pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
       VALUES ('ord', $1, 1, 'legacy.png', 'image/png', 6, $2, 1)`,
      [ordId, Buffer.from('LEGACY')]
    );
    const { rows } = await pool.query('SELECT bloc_idx FROM formulare_capturi WHERE form_id=$1', [ordId]);
    expect(rows[0].bloc_idx).toBeNull();

    const r = await get('ord', ordId, '?slot=1');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('LEGACY');
  });

  // ── 6 — DF: cale NESCHIMBATĂ ───────────────────────────────────────────────
  it('6 DF: POST/GET fără ?bloc se comportă exact ca înainte (un rând, regăsit)', async () => {
    const up = await upload('df', dfId, '', { filename: 'df.png', body: 'DF-CAP' });
    expect(up.status).toBe(200);
    expect(up.body.captura.bloc_idx).toBe(0);

    const rows = await rowsOf(dfId);
    expect(rows).toHaveLength(1);

    const r = await get('df', dfId, '');
    expect(r.status).toBe(200);
    expect(r.body.toString()).toBe('DF-CAP');
  });

  // ── 7 ⭐ schema — zero migrații, zero backfill ─────────────────────────────
  it('7 ⭐ formulare_capturi.bloc_idx e smallint NULLABLE fără DEFAULT; INSERT minimal o lasă NULL', async () => {
    const { rows } = await pool.query(
      `SELECT data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND table_name='formulare_capturi' AND column_name='bloc_idx'`
    );
    expect(rows).toHaveLength(1);
    expect(rows[0].data_type).toBe('smallint');
    expect(rows[0].is_nullable).toBe('YES');
    expect(rows[0].column_default).toBeNull();

    await pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
       VALUES ('ord', $1, 1, 'min.png', 'image/png', 3, $2, 1)`,
      [ordId, Buffer.from('MIN')]
    );
    const { rows: r2 } = await pool.query(
      `SELECT bloc_idx FROM formulare_capturi WHERE form_id=$1 AND filename='min.png'`, [ordId]);
    expect(r2[0].bloc_idx).toBeNull();
  });

  // ── 8 ⭐ POARTA MIGRAȚIEI 107 ──────────────────────────────────────────────
  it('8 ⭐ migrația 107 a rulat: cheia veche pe (t,id,slot) e SCOASĂ, cea pe bloc e live', async () => {
    const { rows } = await pool.query(
      `SELECT indexname FROM pg_indexes WHERE tablename='formulare_capturi'`);
    const names = rows.map(r => r.indexname);
    // Fără DROP, cazul 1 ar trece din întâmplare pe o bază veche și ar pica în producție.
    expect(names).not.toContain('uniq_formulare_capturi_form_slot');
    expect(names).toContain('uniq_formulare_capturi_form_slot_bloc');
  });

  // ── 9 ⭐ cheia NU s-a slăbit ───────────────────────────────────────────────
  it('9 ⭐ două INSERT-uri directe cu același (type, id, slot, bloc_idx=1) → 23505', async () => {
    const ins = (blocIdx) => pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot, bloc_idx)
       VALUES ('ord', $1, 1, 'dup.png', 'image/png', 3, $2, 1, $3)`,
      [ordId, Buffer.from('DUP'), blocIdx]
    );
    await ins(1);
    await expect(ins(1)).rejects.toMatchObject({ code: '23505' });
  });

  // ── 10 — de ce COALESCE, nu `bloc_idx` brut ───────────────────────────────
  it('10 rând legacy (bloc_idx NULL) + INSERT direct cu bloc_idx=0, același slot → 23505', async () => {
    await pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
       VALUES ('ord', $1, 1, 'legacy.png', 'image/png', 6, $2, 1)`,
      [ordId, Buffer.from('LEGACY')]
    );
    // Cu `bloc_idx` brut în cheie, NULL e distinct de orice ⇒ legacy și blocul 0 ar coexista
    // tăcut pe același slot — exact bug-ul reparat, reintrodus pe altă ușă.
    await expect(pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot, bloc_idx)
       VALUES ('ord', $1, 1, 'nou.png', 'image/png', 3, $2, 1, 0)`,
      [ordId, Buffer.from('NOU')]
    )).rejects.toMatchObject({ code: '23505' });
  });
});
