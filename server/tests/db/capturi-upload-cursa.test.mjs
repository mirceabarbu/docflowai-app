/**
 * #205 (v3.9.858) — cursa la încărcarea capturilor: `INSERT ... ON CONFLICT` în loc de
 * `DELETE` + `INSERT` ca două interogări separate.
 *
 * Incident producție 14.09.2026: două `POST /api/formulare-capturi/df/:id` în zbor simultan
 * pe același (form_id, slot, bloc). Ambele DELETE-uri au șters 0 rânduri, primul INSERT a
 * intrat, al doilea a lovit `uniq_formulare_capturi_form_slot_bloc` cu 500. Indexul unic
 * (migrarea 107) și-a făcut treaba — nicio dublură — dar a doua apăsare trebuie să fie
 * INOFENSIVĂ, nu o eroare.
 *
 * Rulează rutele REALE peste Postgres real, pe modelul `capturi-bloc-idx.test.mjs` (#128n).
 * ⚠️ Ruta citește corpul BRUT din stream ⇒ `Buffer` + `Content-Type: image/png` + `X-Filename`.
 *
 * ⭐ Cazul 1 e ancora lotului: pe codul vechi (DELETE+INSERT) PICĂ cu 500 `duplicate key`.
 *    Se rulează în mai multe runde (o cursă care trece o dată poate pica a doua oară).
 */
import { vi, describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';

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

const CSRF = 'test-csrf-token-cap-cursa';
const authz = (u) => `${makeAuthCookie(u)}; csrf_token=${CSRF}`;
const P1 = { userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' };
// #206 — capturile pe DF sunt atributul responsabilului CAB: upload-ul pe DF îl face P2 PUR
// (user 2 = `assigned_to`, creatorul e altcineva) — calea normală de producție, cea mai
// stabilă sub orice schimbare viitoare a porții. Mecanica ON CONFLICT e independentă de actor.
// ORD nu e sub poartă (#206, în afara scopului) — acolo P1 rămâne actorul.
const P2 = { userId: 2, role: 'user', orgId: 1, email: 'p2@x.ro' };

// Numărul de runde ale testului de cursă. Fiecare rundă = N cereri paralele pe aceeași cheie.
const ROUNDS = 8;
const PARALLEL = 4;

const d = describe.skipIf(!hasTestDb());

d('#205 — cursa la încărcarea capturilor (ON CONFLICT)', () => {
  let app, orgId, dfId, ordId;

  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    ({ orgId } = await seedOrgUser({ role: 'user', email: 'p1@x.ro', compartiment: 'Achizitii' }));
    await seedUser({ orgId, email: 'p2@x.ro', compartiment: 'CAB' });
    dfId  = await seedDf({ orgId, createdBy: 1, status: 'draft', assignedTo: 2, nrUnic: 'DF-205-1' });
    ordId = await seedOrd({ orgId, createdBy: 1, status: 'draft', nrOrd: 'ORD-205-1' });
    app = buildRealApp();
  });
  afterAll(() => pool.end());

  const upload = (type, id, qs, { filename = 'captura.png', body = 'PNG-BYTES', as = (type === 'df' ? P2 : P1) } = {}) =>
    request(app)
      .post(`/api/formulare-capturi/${type}/${id}${qs}`)
      .set('Cookie', authz(as))
      .set('x-csrf-token', CSRF)
      .set('Content-Type', 'image/png')
      .set('X-Filename', filename)
      .send(Buffer.from(body));

  const rowsOf = async (id) => {
    const { rows } = await pool.query(
      `SELECT filename, slot, bloc_idx, size_bytes, encode(data,'escape') AS body
         FROM formulare_capturi WHERE form_id=$1 ORDER BY slot, COALESCE(bloc_idx,0), id`, [id]);
    return rows;
  };

  // ── 0 ⭐ ancora de schemă — ținta ON CONFLICT trebuie să fie EXACT expresia indexului ──
  it('0 ⭐ indexul unic e pe (form_type, form_id, slot, (COALESCE(bloc_idx, 0))) — ținta ON CONFLICT', async () => {
    const { rows } = await pool.query(
      `SELECT indexdef FROM pg_indexes WHERE indexname = 'uniq_formulare_capturi_form_slot_bloc'`);
    expect(rows).toHaveLength(1);
    // Postgres deparsează expresia cu cast (`COALESCE((bloc_idx)::integer, 0)` — bloc_idx e
    // smallint) — verificăm componentele, nu textul brut. Potrivirea EXACTĂ a țintei
    // ON CONFLICT o dovedesc cazurile 1-5: o țintă greșită aruncă la execuție (42P10).
    const def = rows[0].indexdef.replace(/\s+/g, ' ');
    expect(def).toMatch(/CREATE UNIQUE INDEX/);
    expect(def).toMatch(/ON public\.formulare_capturi USING btree \(form_type, form_id, slot, \(*COALESCE\(\(?bloc_idx\)?(::integer)?, \(?0\)?(::\w+)?\)/);
  });

  // ── 1 ⭐ ANCORA LOTULUI: cereri paralele pe aceeași cheie ⇒ toate 200, UN rând ─────────
  it(`1 ⭐ ${PARALLEL} POST paralele × ${ROUNDS} runde pe același (form_id, slot, bloc) ⇒ toate 200, exact un rând, conținut întreg`, async () => {
    for (let round = 0; round < ROUNDS; round++) {
      const bodies = Array.from({ length: PARALLEL }, (_, i) => `IMG-${round}-${i}-${'x'.repeat(200 + i)}`);
      const results = await Promise.all(
        bodies.map((b, i) => upload('df', dfId, '?slot=1', { filename: `r${round}-${i}.png`, body: b }))
      );
      // Pe codul vechi (DELETE+INSERT separate): unul din răspunsuri e 500 server_error
      // (duplicate key). Cu ON CONFLICT: toate 200.
      const statuses = results.map(r => r.status);
      expect(statuses, `runda ${round}: ${JSON.stringify(results.map(r => r.body))}`).toEqual(Array(PARALLEL).fill(200));
      for (const r of results) {
        expect(r.body.ok).toBe(true);
        expect(r.body.captura.slot).toBe(1);
        expect(r.body.captura.bloc_idx).toBe(0);
      }

      const rows = await rowsOf(dfId);
      expect(rows, `runda ${round}`).toHaveLength(1);
      // Conținutul e al UNEIA dintre cereri, nu un amestec (size_bytes ↔ body coerente).
      const idx = bodies.indexOf(rows[0].body);
      expect(idx, `runda ${round}: corp necunoscut ${rows[0].body.slice(0, 20)}`).toBeGreaterThanOrEqual(0);
      expect(rows[0].size_bytes).toBe(bodies[idx].length);
      expect(rows[0].filename).toBe(`r${round}-${idx}.png`);
    }
  });

  // ── 2 — comportamentul „înlocuiește" se păstrează ──────────────────────────
  it('2 două încărcări SECVENȚIALE pe același slot ⇒ un rând, cu a doua imagine', async () => {
    const a = await upload('df', dfId, '?slot=1', { filename: 'v1.png', body: 'VECHI' });
    const b = await upload('df', dfId, '?slot=1', { filename: 'v2.png', body: 'NOU-NOU' });
    expect(a.status).toBe(200);
    expect(b.status).toBe(200);
    // Rândul e UPDATE-at în loc, deci id-ul rămâne cel al primului INSERT.
    expect(b.body.captura.id).toBe(a.body.captura.id);

    const rows = await rowsOf(dfId);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('v2.png');
    expect(rows[0].body).toBe('NOU-NOU');
    expect(rows[0].size_bytes).toBe(7);
  });

  // ── 3 — sloturi și blocuri diferite rămân rânduri separate ──────────────────
  it('3 sloturi diferite (1, 2) și blocuri diferite (0, 1) ⇒ rânduri separate, neafectate de înlocuire', async () => {
    expect((await upload('ord', ordId, '?slot=1&bloc=0', { filename: 's1b0.png', body: 'S1B0' })).status).toBe(200);
    expect((await upload('ord', ordId, '?slot=2&bloc=0', { filename: 's2b0.png', body: 'S2B0' })).status).toBe(200);
    expect((await upload('ord', ordId, '?slot=1&bloc=1', { filename: 's1b1.png', body: 'S1B1' })).status).toBe(200);
    expect((await upload('ord', ordId, '?slot=2&bloc=1', { filename: 's2b1.png', body: 'S2B1' })).status).toBe(200);
    // Înlocuire pe (1,0) — celelalte trei rămân intacte.
    expect((await upload('ord', ordId, '?slot=1&bloc=0', { filename: 's1b0-v2.png', body: 'S1B0-V2' })).status).toBe(200);

    const rows = await rowsOf(ordId);
    expect(rows.map(r => `${r.slot}/${r.bloc_idx}:${r.body}`)).toEqual([
      '1/0:S1B0-V2', '1/1:S1B1', '2/0:S2B0', '2/1:S2B1',
    ]);
  });

  // ── 4 — legacy: bloc_idx NULL e blocul 0 pentru ON CONFLICT (COALESCE) ─────
  it('4 rând legacy cu bloc_idx NULL ⇒ upload-ul pe blocul 0 îl ÎNLOCUIEȘTE (fără rând nou)', async () => {
    await pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
       VALUES ('df', $1, 1, 'legacy.png', 'image/png', 6, $2, 1)`,
      [dfId, Buffer.from('LEGACY')]
    );
    const r = await upload('df', dfId, '?slot=1', { filename: 'nou.png', body: 'NOU' });
    expect(r.status).toBe(200);

    const rows = await rowsOf(dfId);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toBe('nou.png');
    expect(rows[0].body).toBe('NOU');
    // Rândul legacy a fost UPDATE-at în loc: bloc_idx rămâne NULL (nu s-a atins coloana-cheie).
    expect(rows[0].bloc_idx).toBeNull();
  });

  // ── 5 — cursa NU scapă pe cheia legacy: paralel peste un rând cu bloc_idx NULL ──
  it('5 POST paralele peste un rând legacy (bloc_idx NULL) ⇒ toate 200, tot un singur rând', async () => {
    await pool.query(
      `INSERT INTO formulare_capturi (form_type, form_id, uploaded_by, filename, mimetype, size_bytes, data, slot)
       VALUES ('df', $1, 1, 'legacy.png', 'image/png', 6, $2, 1)`,
      [dfId, Buffer.from('LEGACY')]
    );
    const results = await Promise.all(
      Array.from({ length: PARALLEL }, (_, i) => upload('df', dfId, '?slot=1', { filename: `p${i}.png`, body: `P${i}` }))
    );
    expect(results.map(r => r.status)).toEqual(Array(PARALLEL).fill(200));
    const rows = await rowsOf(dfId);
    expect(rows).toHaveLength(1);
    expect(rows[0].filename).toMatch(/^p\d\.png$/);
  });
});
