/**
 * Plasă anti-regresie: matrice parametrizată DF+ORD — blochează badge-ul final pe TOATE stările.
 * - badge_status este calculat server-side (câmp unic autoritar) — frontend doar prezintă.
 * - DF: badge_status = 'aprobat' dacă flux completed, altfel status brut (transmis_flux e status real persistat).
 * - ORD: badge_status = COALESCE(transmis_flux derivat, aprobat ? 'aprobat' : status).
 * - display_status ELIMINAT din response (curățenie confirmată prin aserție per caz).
 * Asimetria DF↔ORD este INTENȚIONATĂ — NU uniformiza.
 * OGLINDEȘTE public/js/formular/list.js:489 (_stBadge(row.badge_status)).
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
  // badge_status = COALESCE(transmis_flux derivat, aprobat ? 'aprobat' : fo.status)
  const ORD_CASES = [
    {
      name: 'draft, fără flux → draft',
      seed: async () => seedOrd({ orgId: 1, createdBy: 1, status: 'draft', flowId: null }),
      expectedBadge: 'draft',
      diag: (row) => { expect(row.aprobat).toBe(false); },
    },
    {
      name: 'pending_p2, fără flux → pending_p2',
      seed: async () => seedOrd({ orgId: 1, createdBy: 1, status: 'pending_p2', flowId: null }),
      expectedBadge: 'pending_p2',
      diag: (row) => { expect(row.aprobat).toBe(false); },
    },
    {
      name: 'completed, fără flux → completed',
      seed: async () => seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId: null }),
      expectedBadge: 'completed',
      diag: (row) => { expect(row.aprobat).toBe(false); },
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
        expect(row.aprobat).toBe(false);
        expect(row.status).toBe('completed'); // status brut neatins
      },
    },
    {
      name: 'completed + flux aprobat (data.completed=true) → aprobat (ELSE NULL fix 16)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-approved', { completed: true });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'aprobat',
      diag: (row) => {
        expect(row.aprobat).toBe(true);
        expect(row.status).toBe('completed');
      },
    },
    {
      // Status persistat 'aprobat' (ciclul 1): badge vine din aprobat=true (fluxul e completed).
      name: 'aprobat persistat (status=aprobat) + flux completed → aprobat (ciclul 1)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-cic1', { completed: true });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'aprobat', flowId });
      },
      expectedBadge: 'aprobat',
      diag: (row) => { expect(row.aprobat).toBe(true); },
    },
    {
      name: 'completed + flux cancelled → completed',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-cancelled', { status: 'cancelled' });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'completed',
      diag: (row) => { expect(row.aprobat).toBe(false); },
    },
    {
      // Flux soft-șters: deleted_at IS NULL în CASE → condiția eșuează → badge_status = fo.status.
      name: 'completed + flux activ șters (soft-delete) → completed (NU transmis_flux)',
      seed: async () => {
        const flowId = await seedFlowX('flow-ord-deleted', {
          status: 'pending',
          deletedAt: new Date().toISOString(),
        });
        return seedOrd({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'completed',
      diag: (row) => { expect(row.aprobat).toBe(false); },
    },
  ];

  for (const { name, seed, expectedBadge, diag } of ORD_CASES) {
    it(`ORD: ${name}`, async () => {
      const id = await seed();
      const res = await request(app).get('/api/formulare/list?type=ord').set('Cookie', cookie());
      expect(res.status).toBe(200);
      const row = findRow(res.body, id);
      expect(row).toBeTruthy();
      expect(row.badge_status).toBe(expectedBadge);
      expect(row).not.toHaveProperty('display_status'); // display_status eliminat din response
      diag?.(row);
    });
  }

  // ─── DF — 6 cazuri ─────────────────────────────────────────────────────────
  // Ramura DF: badge_status = 'aprobat' dacă flux completed, altfel status brut.
  // transmis_flux vine din status REAL persistat (linkFlowFormular îl setează), NU dintr-o derivare.
  const DF_CASES = [
    {
      name: 'draft, fără flux → draft',
      seed: async () => seedDf({ orgId: 1, createdBy: 1, status: 'draft', flowId: null }),
      expectedBadge: 'draft',
      diag: (row) => { expect(row).toHaveProperty('badge_status', 'draft'); },
    },
    {
      name: 'pending_p2, fără flux → pending_p2',
      seed: async () => seedDf({ orgId: 1, createdBy: 1, status: 'pending_p2', flowId: null }),
      expectedBadge: 'pending_p2',
      diag: (row) => { expect(row).toHaveProperty('badge_status', 'pending_p2'); },
    },
    {
      name: 'completed, fără flux → completed',
      seed: async () => seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId: null }),
      expectedBadge: 'completed',
      diag: (row) => {
        expect(row).toHaveProperty('badge_status', 'completed');
        expect(row.aprobat).toBe(false);
      },
    },
    {
      // DF: transmis_flux e status REAL persistat (linkFlowFormular îl setează).
      // badge_status vine din fd.status direct (ELSE fd.status) — flux activ NU e completed → nu e 'aprobat'.
      name: 'transmis_flux (status real) + flux pending → transmis_flux din status brut',
      seed: async () => {
        const flowId = await seedFlowX('flow-df-active', { status: 'pending' });
        return seedDf({ orgId: 1, createdBy: 1, status: 'transmis_flux', flowId });
      },
      expectedBadge: 'transmis_flux',
      diag: (row) => {
        expect(row).toHaveProperty('badge_status', 'transmis_flux');
        expect(row.status).toBe('transmis_flux');
      },
    },
    {
      name: 'completed + flux aprobat (data.completed=true) → aprobat',
      seed: async () => {
        const flowId = await seedFlowX('flow-df-approved', { completed: true });
        return seedDf({ orgId: 1, createdBy: 1, status: 'completed', flowId });
      },
      expectedBadge: 'aprobat',
      diag: (row) => {
        expect(row).toHaveProperty('badge_status', 'aprobat');
        expect(row.aprobat).toBe(true);
      },
    },
    {
      name: 'returnat + flux șters → returnat din status brut',
      seed: async () => {
        const flowId = await seedFlowX('flow-df-deleted', {
          status: 'pending',
          deletedAt: new Date().toISOString(),
        });
        return seedDf({ orgId: 1, createdBy: 1, status: 'returnat', flowId });
      },
      expectedBadge: 'returnat',
      diag: (row) => { expect(row).toHaveProperty('badge_status', 'returnat'); },
    },
  ];

  for (const { name, seed, expectedBadge, diag } of DF_CASES) {
    it(`DF: ${name}`, async () => {
      const id = await seed();
      const res = await request(app).get('/api/formulare/list?type=df').set('Cookie', cookie());
      expect(res.status).toBe(200);
      const row = findRow(res.body, id);
      expect(row).toBeTruthy();
      expect(row.badge_status).toBe(expectedBadge);
      expect(row).not.toHaveProperty('display_status'); // display_status eliminat din response
      diag?.(row);
    });
  }
});
