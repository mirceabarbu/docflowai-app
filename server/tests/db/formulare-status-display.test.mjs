/**
 * Plasă anti-regresie: matrice parametrizată DF+ORD — blochează badge-ul final pe TOATE stările.
 * - DF: display_status ABSENT (ramura DF nu-l selectează); badge din status brut / aprobat.
 * - ORD: display_status derivat (CASE transmis_flux); badge din display_status || aprobat || status.
 * Asimetria DF↔ORD este INTENȚIONATĂ — NU uniformiza.
 * OGLINDEȘTE public/js/formular/list.js:489 — ține-le sincron. (Pas viitor: sursă unică server-side.)
 */
import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import { hasTestDb, migrate, truncateAll, pool,
         seedOrgUser, seedDf, seedOrd, makeAuthCookie } from '../helpers/db-real.mjs';

vi.mock('../../middleware/csrf.mjs', () => ({ csrfMiddleware: (_req, _res, next) => next() }));
vi.mock('../../middleware/require-module.mjs', () => ({
  requireModule: () => (_req, _res, next) => next(),
  default: () => (_req, _res, next) => next(),
}));
vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  redactUrl: (u) => u,
}));

const { formulareDbRouter } = await import('../../routes/formulare/index.mjs');

function buildApp() {
  const app = express();
  app.set('trust proxy', 1);
  app.use(express.json({ limit: '50mb' }));
  app.use(cookieParser());
  app.use('/', formulareDbRouter);
  return app;
}

// OGLINDEȘTE public/js/formular/list.js:489 — ține-le sincron.
const effectiveBadge = (row) => row.display_status || (row.aprobat ? 'aprobat' : row.status);

// `completed` nespecificat → cheia e OMISĂ din `data` (flux real în curs; capcana NULL pt IS DISTINCT FROM).
async function seedFlowX(id, { status = 'in_progress', completed, deletedAt = null } = {}) {
  const data = { status, orgId: 1, initEmail: 'p1@x.ro', docName: 'Doc' };
  if (completed !== undefined) data.completed = completed;
  await pool.query(
    `INSERT INTO flows (id, data, org_id, deleted_at) VALUES ($1, $2::jsonb, $3, $4)`,
    [id, JSON.stringify(data), 1, deletedAt]
  );
  return id;
}

function findRow(body, id) { return body.rows.find(d => d.id === id); }

const d = describe.skipIf(!hasTestDb());

d('formulare-status-display: matrice parametrizată DF+ORD (anti-regresie badge)', () => {
  let app;
  beforeAll(migrate);
  beforeEach(async () => {
    await truncateAll();
    await seedOrgUser({ role: 'user', email: 'p1@x.ro' });
    app = buildApp();
  });
  afterAll(() => pool.end());

  const cookie = () => makeAuthCookie({ userId: 1, role: 'user', orgId: 1, email: 'p1@x.ro' });

  // ─── ORD — 8 cazuri ────────────────────────────────────────────────────────
  // display_status: non-null DOAR pentru transmis_flux; restul → null → fallback aprobat/status.
  const ORD_CASES = [
    {
      name: 'draft, fără flux → draft',
      seed: async () => seedOrd({ orgId: 1, createdBy: 1, status: 'draft', flowId: null }),
      expectedBadge: 'draft',
      diag: (row) => { expect(row.display_status).toBeNull(); },
    },
    {
      name: 'pending_p2, fără flux → pending_p2',
      seed: async () => seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', flowId: null }),
      expectedBadge: 'pending_p2',
      diag: (row) => { expect(row.display_status).toBeNull(); },
    },
    {
      name: 'completed, fără flux → completed',
      seed: async () => seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: null }),
      expectedBadge: 'completed',
      diag: (row) => {
        expect(row.display_status).toBeNull();
        expect(row.aprobat).toBe(false);
      },
    },
    {
      // Capcana NULL: flux activ real NU are cheia `completed` în data — seedat fără ea.
      // IS DISTINCT FROM 'true' prinde corect NULL (spre deosebire de !=).
      name: 'completed + flux activ (data.completed absent, flux real în curs) → transmis_flux',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-active', { status: 'pending' });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'transmis_flux',
      diag: (row) => {
        expect(row.display_status).toBe('transmis_flux');
        expect(row.aprobat).toBe(false);
        expect(row.status).toBe('completed'); // status brut neatins
      },
    },
    {
      name: 'completed + flux aprobat (data.completed=true) → aprobat (display_status null, regresia fix 16)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-approved', { completed: true });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'aprobat',
      diag: (row) => {
        expect(row.display_status).toBeNull(); // ELSE NULL, nu ELSE fo.status
        expect(row.aprobat).toBe(true);
        expect(row.status).toBe('completed');
      },
    },
    {
      // Status persistat 'aprobat' (ciclul 1): display_status=null (CASE cere status='completed'),
      // badge vine din aprobat=true (fluxul e completed).
      name: 'aprobat persistat (status=aprobat) + flux completed → aprobat (ciclul 1)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-cic1', { completed: true });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });
      },
      expectedBadge: 'aprobat',
      diag: (row) => {
        expect(row.display_status).toBeNull();
        expect(row.aprobat).toBe(true);
      },
    },
    {
      name: 'completed + flux cancelled → completed (display_status null)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-cancelled', { status: 'cancelled' });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'completed',
      diag: (row) => {
        expect(row.display_status).toBeNull();
        expect(row.aprobat).toBe(false);
      },
    },
    {
      // Flux soft-șters: deleted_at IS NULL în CASE → condiția eșuează → display_status=null.
      name: 'completed + flux activ șters (soft-delete) → completed (NU transmis_flux)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-deleted', {
          status: 'pending',
          deletedAt: new Date().toISOString(),
        });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'completed',
      diag: (row) => {
        expect(row.display_status).toBeNull();
        expect(row.aprobat).toBe(false);
      },
    },
  ];

  for (const { name, seed, expectedBadge, diag } of ORD_CASES) {
    it(`ORD: ${name}`, async () => {
      const id = await seed();
      const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
      expect(res.status).toBe(200);
      const row = findRow(res.body, id);
      expect(row).toBeTruthy();
      expect(effectiveBadge(row)).toBe(expectedBadge);
      diag?.(row);
    });
  }

  // ─── DF — 6 cazuri ─────────────────────────────────────────────────────────
  // Ramura DF NU selectează display_status — cheia lipsește complet din response.
  // transmis_flux vine din status brut (coloana reală), NU dintr-o derivare.
  // Dacă apare vreodată display_status pe DF, `not.toHaveProperty` pică și blochează schimbarea.
  const DF_CASES = [
    {
      name: 'draft, fără flux → draft (display_status absent)',
      seed: async () => seedDf({ orgId: 1, createdBy: 1, status: 'draft', flowId: null }),
      expectedBadge: 'draft',
      diag: (row) => { expect(row).not.toHaveProperty('display_status'); },
    },
    {
      name: 'pending_p2, fără flux → pending_p2 (display_status absent)',
      seed: async () => seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', flowId: null }),
      expectedBadge: 'pending_p2',
      diag: (row) => { expect(row).not.toHaveProperty('display_status'); },
    },
    {
      name: 'completed, fără flux → completed (display_status absent, aprobat false)',
      seed: async () => seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: null }),
      expectedBadge: 'completed',
      diag: (row) => {
        expect(row).not.toHaveProperty('display_status');
        expect(row.aprobat).toBe(false);
      },
    },
    {
      // DF: transmis_flux e status REAL persistat (linkFlowFormular îl setează).
      // Badge vine din row.status direct — NU dintr-un display_status derivat.
      // Aserția `not.toHaveProperty` blochează introducerea accidentală a derivării pe DF.
      name: 'transmis_flux (status real) + flux pending → transmis_flux din status brut (NU display_status)',
      seed: async () => {
        const flowId = await seedFlowX('flow-df-active', { status: 'pending' });
        return seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
      },
      expectedBadge: 'transmis_flux',
      diag: (row) => {
        expect(row).not.toHaveProperty('display_status');
        expect(row.status).toBe('transmis_flux');
      },
    },
    {
      name: 'completed + flux aprobat (data.completed=true) → aprobat (display_status absent)',
      seed: async () => {
        const flowId = await seedFlowX('flow-df-approved', { completed: true });
        return seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'aprobat',
      diag: (row) => {
        expect(row).not.toHaveProperty('display_status');
        expect(row.aprobat).toBe(true);
      },
    },
    {
      name: 'returnat + flux șters → returnat din status brut (display_status absent)',
      seed: async () => {
        const flowId = await seedFlowX('flow-df-deleted', {
          status: 'pending',
          deletedAt: new Date().toISOString(),
        });
        return seedDf({ orgId: 1, createdBy: 1, status: 'returnat', flowId });
      },
      expectedBadge: 'returnat',
      diag: (row) => {
        expect(row).not.toHaveProperty('display_status');
      },
    },
  ];

  for (const { name, seed, expectedBadge, diag } of DF_CASES) {
    it(`DF: ${name}`, async () => {
      const id = await seed();
      const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
      expect(res.status).toBe(200);
      const row = findRow(res.body, id);
      expect(row).toBeTruthy();
      expect(effectiveBadge(row)).toBe(expectedBadge);
      diag?.(row);
    });
  }
});
