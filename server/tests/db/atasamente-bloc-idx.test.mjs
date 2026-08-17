/**
 * #128m (v3.9.773) — atașamente per BLOC de furnizor (`formulare_atasamente.bloc_idx`).
 *
 * Rulează rutele REALE peste Postgres real, prin lanțul de middleware folosit de
 * `formulare-atasamente-authz.test.mjs` (json adaptiv + CSRF real + authz real).
 *
 * Cazurile ⭐ 1, 2 și 8 sunt plasa de siguranță a lotului:
 *   1 — NON-REGRESIE: fără `?bloc`, totul se comportă ca înainte (bloc 0);
 *   2 — CAPCANA de dedup: același fișier trebuie să poată sta la DOI furnizori;
 *   8 — schema: coloana e nullable, fără DEFAULT, fără backfill.
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, seedFlow, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/logger.mjs', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
            child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })) },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');
const { copyFormularAttachmentsToFlow } = await import('../../services/formular-flow-attachments.mjs');

function buildRealApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(cookieParser());
  app.use((req, res, next) => express.json({ limit: '1mb' })(req, res, next));
  app.use('/', formulareDbRouter);
  return app;
}

const CSRF = 'test-csrf-token-bloc-idx';
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;
const P1 = { userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' };

const d = describe.skipIf(!hasTestDb());

d('#128m — atașamente per bloc de furnizor (bloc_idx)', () => {
  let app, orgId, ordId, dfId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro', compartiment: 'Achizitii' }));
    ordId = await seedOrd({ orgId, createdBy: 1, status: 'draft', nrOrd: 'ORD-128M-1' });
    dfId  = await seedDf({ orgId, createdBy: 1, status: 'draft', nrUnic: 'DF-128M-1' });
    app = buildRealApp();
  });
  afterAll(() => pool.end());

  // `qs` = query string COMPLET (ex. '' , '?bloc=1', '?slot=2') — testăm inclusiv absența lui.
  const upload = (type, id, qs, { filename = 'anexa.pdf', body = 'PDF-BYTES' } = {}) =>
    request(app)
      .post(`/api/formulare-atasamente/${type}/${id}${qs}`)
      .set('Cookie', authz(P1))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'application/pdf')
      .set('X-Filename', filename)
      .send(Buffer.from(body));

  const list = (type, id, qs) =>
    request(app)
      .get(`/api/formulare-atasamente/${type}/${id}${qs}`)
      .set('Cookie', authz(P1));

  const rowsOf = async (id) => {
    const { rows } = await pool.query(
      `SELECT filename, size_bytes, slot, bloc_idx FROM formulare_atasamente
        WHERE form_id=$1 AND deleted_at IS NULL ORDER BY created_at ASC`, [id]);
    return rows;
  };

  // ── 1 ⭐ NON-REGRESIE ────────────────────────────────────────────────────────
  it('1 ⭐ upload FĂRĂ ?bloc → bloc_idx=0; GET fără ?bloc îl întoarce', async () => {
    const up = await upload('ord', ordId, '');
    expect(up.status).toBe(200);
    expect(up.body.atasament.bloc_idx).toBe(0);

    const rows = await rowsOf(ordId);
    expect(rows).toHaveLength(1);
    expect(rows[0].bloc_idx).toBe(0);

    const res = await list('ord', ordId, '');
    expect(res.status).toBe(200);
    expect(res.body.atasamente).toHaveLength(1);
    expect(res.body.atasamente[0].filename).toBe('anexa.pdf');
    expect(res.body.atasamente[0].bloc_idx).toBe(0);
  });

  // ── 2 ⭐ CAPCANA DEDUP ───────────────────────────────────────────────────────
  it('2 ⭐ același fișier pe bloc 0 și pe bloc 1 → DOUĂ rânduri (dedup extins cu bloc_idx)', async () => {
    const a = await upload('ord', ordId, '?bloc=0');
    const b = await upload('ord', ordId, '?bloc=1');
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    expect(a.body.deduplicated).toBeUndefined();
    expect(b.body.deduplicated).toBeUndefined();
    expect(a.body.atasament.id).not.toBe(b.body.atasament.id);

    const rows = await rowsOf(ordId);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.bloc_idx).sort()).toEqual([0, 1]);
  });

  // ── 3 dedup #124i nepierdut ─────────────────────────────────────────────────
  it('3 același fișier de două ori pe ACELAȘI bloc → dedup activ, un singur rând', async () => {
    const a = await upload('ord', ordId, '?bloc=1');
    const b = await upload('ord', ordId, '?bloc=1');
    expect(b.body.deduplicated).toBe(true);
    expect(b.body.atasament.id).toBe(a.body.atasament.id);
    expect(await rowsOf(ordId)).toHaveLength(1);
  });

  // ── 4 filtrare la listare ───────────────────────────────────────────────────
  it('4 GET ?bloc=1 întoarce doar atașamentele blocului 1', async () => {
    await upload('ord', ordId, '?bloc=0', { filename: 'b0.pdf' });
    await upload('ord', ordId, '?bloc=1', { filename: 'b1.pdf' });
    await upload('ord', ordId, '?bloc=1', { filename: 'b1-bis.pdf', body: 'ALTELE' });

    const r0 = await list('ord', ordId, '?bloc=0');
    const r1 = await list('ord', ordId, '?bloc=1');
    expect(r0.body.atasamente.map(a => a.filename)).toEqual(['b0.pdf']);
    expect(r1.body.atasamente.map(a => a.filename)).toEqual(['b1.pdf', 'b1-bis.pdf']);
    expect(r1.body.atasamente.every(a => a.bloc_idx === 1)).toBe(true);
  });

  // ── 5 legacy NULL = bloc 0 ──────────────────────────────────────────────────
  it('5 rânduri legacy cu bloc_idx NULL sunt citite ca bloc 0', async () => {
    await pool.query(
      `INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data, slot)
       VALUES ('ord', $1, 1, 'legacy.pdf', 'application/pdf', 6, $2, 1)`,
      [ordId, Buffer.from('LEGACY')]
    );
    const { rows } = await pool.query(
      `SELECT bloc_idx FROM formulare_atasamente WHERE form_id=$1`, [ordId]);
    expect(rows[0].bloc_idx).toBeNull();

    const r = await list('ord', ordId, '');
    expect(r.body.atasamente.map(a => a.filename)).toEqual(['legacy.pdf']);
    expect(r.body.atasamente[0].bloc_idx).toBe(0);
    // …și NU apare pe alt bloc.
    const r1 = await list('ord', ordId, '?bloc=1');
    expect(r1.body.atasamente).toHaveLength(0);
  });

  // ── 6 ortogonalitate slot × bloc (DF, neafectat de lot) ─────────────────────
  it('6 slot și bloc_idx sunt ortogonale: același fișier pe slot 1 și slot 2 (DF) → două rânduri', async () => {
    const a = await upload('df', dfId, '?slot=1');
    const b = await upload('df', dfId, '?slot=2');
    expect(a.body.deduplicated).toBeUndefined();
    expect(b.body.deduplicated).toBeUndefined();
    const rows = await rowsOf(dfId);
    expect(rows).toHaveLength(2);
    expect(rows.map(r => r.slot).sort()).toEqual([1, 2]);
    expect(rows.every(r => r.bloc_idx === 0)).toBe(true);
  });

  // ── 7 copierea în flux ia TOATE blocurile ──────────────────────────────────
  it('7 copyFormularAttachmentsToFlow ia atașamentele TUTUROR blocurilor; duplicatul între blocuri intră o dată', async () => {
    await upload('ord', ordId, '?bloc=0', { filename: 'b0.pdf', body: 'AAA' });
    await upload('ord', ordId, '?bloc=1', { filename: 'b1.pdf', body: 'BBBB' });
    // Același fișier (nume + dimensiune) la ambii furnizori:
    await upload('ord', ordId, '?bloc=0', { filename: 'comun.pdf', body: 'CCCCC' });
    await upload('ord', ordId, '?bloc=1', { filename: 'comun.pdf', body: 'CCCCC' });
    expect(await rowsOf(ordId)).toHaveLength(4);

    const flowId = await seedFlow({ orgId });
    const n = await copyFormularAttachmentsToFlow(pool, { flowId, formType: 'ord', formId: ordId });
    expect(n).toBe(3);
    const { rows } = await pool.query(
      `SELECT filename FROM flow_attachments WHERE flow_id=$1 ORDER BY filename`, [flowId]);
    expect(rows.map(r => r.filename)).toEqual(['b0.pdf', 'b1.pdf', 'comun.pdf']);
  });

  // ── 8 ⭐ schema ─────────────────────────────────────────────────────────────
  it('8 ⭐ bloc_idx există pe ambele tabele, e smallint NULLABLE, fără DEFAULT (zero backfill)', async () => {
    const { rows } = await pool.query(
      `SELECT table_name, data_type, is_nullable, column_default
         FROM information_schema.columns
        WHERE table_schema='public' AND column_name='bloc_idx'
          AND table_name IN ('formulare_atasamente','formulare_capturi')
        ORDER BY table_name`);
    expect(rows.map(r => r.table_name)).toEqual(['formulare_atasamente', 'formulare_capturi']);
    for (const r of rows) {
      expect(r.data_type).toBe('smallint');
      expect(r.is_nullable).toBe('YES');
      expect(r.column_default).toBeNull();
    }

    // INSERT minimal (ca al unui client vechi) NU populează coloana.
    await pool.query(
      `INSERT INTO formulare_atasamente (form_type, form_id, uploaded_by, filename, mime_type, size_bytes, data)
       VALUES ('ord', $1, 1, 'minimal.pdf', 'application/pdf', 3, $2)`,
      [ordId, Buffer.from('XYZ')]
    );
    const { rows: min } = await pool.query(
      `SELECT bloc_idx FROM formulare_atasamente WHERE form_id=$1 AND filename='minimal.pdf'`, [ordId]);
    expect(min[0].bloc_idx).toBeNull();

    // #128n: capturile NU sunt cablate în acest lot — coloana rămâne nescrisă.
    const { rows: cap } = await pool.query(
      `SELECT COUNT(*)::int AS n FROM formulare_capturi WHERE bloc_idx IS NOT NULL`);
    expect(cap[0].n).toBe(0);
  });
});
