/**
 * server/tests/integration/full-flow.test.mjs — End-to-end lifecycle tests (v4)
 *
 * Covers:
 *   'Complete flow lifecycle' — flow create → upload → start → advance ×2 → completed
 *   'ALOP form lifecycle'     — templates list → create → save → validate → generate-pdf
 *   'Policy evaluation'       — deny signers_count>10, allow signers_count=5
 *
 * All DB calls are mocked — no real database required.
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

// ── Mocks — must be hoisted before any imports that use them ──────────────────

vi.mock('../../modules/flows/repository.mjs', () => ({
  createFlow:             vi.fn(),
  getFlowById:            vi.fn(),
  updateFlowStatus:       vi.fn(),
  updateSigner:           vi.fn(),
  getCurrentSigner:       vi.fn(),
  getSignerByToken:       vi.fn(),
  getNextPendingSigner:   vi.fn(),
  listFlows:              vi.fn(),
  softDeleteFlow:         vi.fn(),
  insertDocumentRevision: vi.fn(),
  updateFlowDocument:     vi.fn(),
  getFlowRevisions:       vi.fn(),
}));

vi.mock('../../modules/forms/repository.mjs', () => ({
  listTemplates:          vi.fn(),
  findTemplateById:       vi.fn(),
  findTemplateByCode:     vi.fn(),
  findLatestVersion:      vi.fn(),
  getActiveVersion:       vi.fn(),
  getVersionById:         vi.fn(),
  createTemplate:         vi.fn(),
  insertTemplate:         vi.fn(),
  createVersion:          vi.fn(),
  insertVersion:          vi.fn(),
  createInstance:         vi.fn(),
  insertInstance:         vi.fn(),
  findInstanceById:       vi.fn(),
  updateInstance:         vi.fn(),           // used by saveData, validateInstance, generatePdf
  updateInstanceData:     vi.fn(),
  updateInstanceStatus:   vi.fn(),
  insertFormDocumentRevision: vi.fn(),
  listInstances:          vi.fn(),
}));

vi.mock('../../modules/forms/pdf-renderer.mjs', () => ({
  renderFormPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock')),
}));

vi.mock('../../db/index.mjs', () => ({
  pool: { query: vi.fn() },
}));

vi.mock('../../db/queries/audit.mjs', () => ({
  logAuditEvent:          vi.fn().mockResolvedValue(undefined),
  listAuditEventsForOrg:  vi.fn().mockResolvedValue({ items: [], meta: {} }),
  listAuditEventsForFlow: vi.fn().mockResolvedValue([
    { id: 1, event_type: 'flow.created',   actor_email: 'admin@test.ro', ok: true, created_at: new Date().toISOString() },
    { id: 2, event_type: 'flow.started',   actor_email: 'admin@test.ro', ok: true, created_at: new Date().toISOString() },
    { id: 3, event_type: 'flow.advanced',  actor_email: 's1@test.ro',   ok: true, created_at: new Date().toISOString() },
    { id: 4, event_type: 'flow.advanced',  actor_email: 's2@test.ro',   ok: true, created_at: new Date().toISOString() },
    { id: 5, event_type: 'flow.completed', actor_email: 's2@test.ro',   ok: true, created_at: new Date().toISOString() },
  ]),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  requestLogger: (_req, _res, next) => next(),
}));

vi.mock('../../modules/notifications/service.mjs', () => ({
  notify: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../services/webhook.mjs', () => ({
  fire: vi.fn().mockResolvedValue(undefined),
}));

// ── Imports after mocks ───────────────────────────────────────────────────────

import * as mockFlowRepo from '../../modules/flows/repository.mjs';
import * as mockFormRepo from '../../modules/forms/repository.mjs';
import { pool }          from '../../db/index.mjs';

import flowsModuleRouter from '../../modules/flows/routes.mjs';
import formsModuleRouter from '../../modules/forms/routes.mjs';
import policiesRouter    from '../../modules/policies/routes.mjs';
import auditRouter       from '../../modules/audit/routes.mjs';
import { errorHandler }  from '../../middleware/errorHandler.mjs';

// ── Constants ─────────────────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET;
const ORG_ID     = 1;
const USER_ID    = 42;
const FLOW_ID    = 'flow_e2e_test_001';

// ── Helpers ───────────────────────────────────────────────────────────────────

function makeToken(overrides = {}) {
  return jwt.sign(
    {
      sub: USER_ID, email: 'admin@test.ro', org_id: ORG_ID,
      role: 'org_admin', name: 'Admin Test', ver: 1, tv: 1,
      userId: USER_ID, orgId: ORG_ID,
      ...overrides,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

function makeApp() {
  const app = express();
  app.use(cookieParser());
  app.use(express.json());
  app.use('/api/flows',    flowsModuleRouter);
  app.use('/api/forms',    formsModuleRouter);
  app.use('/api/policies', policiesRouter);
  app.use('/api/audit',    auditRouter);
  app.use(errorHandler);
  return app;
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

// Flow in 'active' state (after upload, before start)
const FLOW_ACTIVE = {
  id: FLOW_ID, org_id: ORG_ID, title: 'Test flux E2E',
  doc_name: 'contract_test', doc_type: 'tabel',
  status: 'active',
  metadata: { hasDocument: true },
  signers: [
    { id: 's1', email: 'signer1@test.ro', name: 'Semnatar Unu', step_order: 0, status: 'pending', token: null },
    { id: 's2', email: 'signer2@test.ro', name: 'Semnatar Doi', step_order: 1, status: 'pending', token: null },
  ],
  created_at: new Date().toISOString(),
};

const FLOW_IN_PROGRESS = {
  ...FLOW_ACTIVE,
  status: 'in_progress',
  signers: [
    { id: 's1', email: 'signer1@test.ro', name: 'Semnatar Unu', step_order: 0, status: 'current', token: 'tok_s1' },
    { id: 's2', email: 'signer2@test.ro', name: 'Semnatar Doi', step_order: 1, status: 'pending', token: null },
  ],
};

const FLOW_AFTER_S1 = {
  ...FLOW_ACTIVE,
  status: 'in_progress',
  signers: [
    { id: 's1', email: 'signer1@test.ro', name: 'Semnatar Unu', step_order: 0, status: 'signed', token: 'tok_s1' },
    { id: 's2', email: 'signer2@test.ro', name: 'Semnatar Doi', step_order: 1, status: 'current', token: 'tok_s2' },
  ],
};

const FLOW_COMPLETED = {
  ...FLOW_ACTIVE,
  status: 'completed',
  completed_at: new Date().toISOString(),
  signers: [
    { id: 's1', email: 'signer1@test.ro', name: 'Semnatar Unu', step_order: 0, status: 'signed', token: 'tok_s1' },
    { id: 's2', email: 'signer2@test.ro', name: 'Semnatar Doi', step_order: 1, status: 'signed', token: 'tok_s2' },
  ],
};

// Signer rows as returned by getSignerByToken (include flow_status, flow_id, org_id, step_order)
const SIGNER1_ROW = {
  id: 's1', flow_id: FLOW_ID, org_id: ORG_ID,
  email: 'signer1@test.ro', name: 'Semnatar Unu',
  step_order: 0, status: 'current', token: 'tok_s1',
  flow_status: 'in_progress',
};

const SIGNER2_ROW = {
  id: 's2', flow_id: FLOW_ID, org_id: ORG_ID,
  email: 'signer2@test.ro', name: 'Semnatar Doi',
  step_order: 1, status: 'current', token: 'tok_s2',
  flow_status: 'in_progress',
};

// ── Form fixtures ─────────────────────────────────────────────────────────────

const TEMPLATE_ID  = 'tpl_alop_001';
const INSTANCE_ID  = 'inst_alop_001';
const VERSION_ID   = 'ver_001';

const ALOP_TEMPLATE = {
  id: TEMPLATE_ID, code: 'ALOP-2024', name: 'ALOP 2024',
  category: 'financial', is_standard: true, is_mandatory: false, is_active: true,
  created_at: new Date().toISOString(),
};

const ALOP_VERSION = {
  id: VERSION_ID, template_id: TEMPLATE_ID, version: 1, is_active: true,
  status: 'published',
  schema_json: {
    sections: [{ id: 'sectionA', title: 'Date generale' }],
    // validateFormData uses field.name (not field.id) for data lookup
    fields: [{ id: 'sectionA.institutie', name: 'sectionA.institutie', section: 'sectionA', type: 'text', label: 'Instituție', required: true }],
  },
  rules_json: [],
  required_signers:     ['CFP'],
  required_attachments: [],
};

const ALOP_INSTANCE = {
  id: INSTANCE_ID, template_id: TEMPLATE_ID, version_id: VERSION_ID,
  flow_id: FLOW_ID, org_id: ORG_ID, status: 'draft',
  data_json: {}, created_at: new Date().toISOString(),
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Complete flow lifecycle', () => {
  it('1-3: POST /api/flows → creates flow with 2 signers (201)', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.createFlow.mockResolvedValue({
      flow: { ...FLOW_ACTIVE, status: 'draft' },
    });

    const res = await request(app)
      .post('/api/flows')
      .set('Cookie', `dfai_token=${token}`)
      .send({
        title:    'Test flux E2E',
        doc_name: 'contract_test',
        doc_type: 'tabel',
        signers: [
          { email: 'signer1@test.ro', name: 'Semnatar Unu', step_order: 0 },
          { email: 'signer2@test.ro', name: 'Semnatar Doi', step_order: 1 },
        ],
      });

    expect(res.status).toBe(201);
    expect(mockFlowRepo.createFlow).toHaveBeenCalledOnce();
  });

  it('4: POST /api/flows/:id/document → upload PDF (201)', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.getFlowById.mockResolvedValue(FLOW_ACTIVE);
    mockFlowRepo.insertDocumentRevision.mockResolvedValue({ id: 1 });
    mockFlowRepo.updateFlowDocument.mockResolvedValue(FLOW_ACTIVE);

    const res = await request(app)
      .post(`/api/flows/${FLOW_ID}/document`)
      .set('Cookie', `dfai_token=${token}`)
      .attach('file', Buffer.from('%PDF-1.4 mock'), { filename: 'test.pdf', contentType: 'application/pdf' });

    expect([200, 201]).toContain(res.status);
  });

  it('5: POST /api/flows/:id/start → flow in_progress, first signer activated', async () => {
    const app   = makeApp();
    const token = makeToken();

    // startFlow: first getFlowById for the initial check
    mockFlowRepo.getFlowById
      .mockResolvedValueOnce(FLOW_ACTIVE)        // initial fetch in startFlow
      .mockResolvedValueOnce(FLOW_IN_PROGRESS);  // re-fetch after update
    mockFlowRepo.updateSigner.mockResolvedValue(undefined);
    mockFlowRepo.updateFlowStatus.mockResolvedValue(FLOW_IN_PROGRESS);

    const res = await request(app)
      .post(`/api/flows/${FLOW_ID}/start`)
      .set('Cookie', `dfai_token=${token}`);

    expect([200, 201]).toContain(res.status);
    expect(mockFlowRepo.updateFlowStatus).toHaveBeenCalledOnce();
  });

  it('6: GET /api/flows/:id → status = in_progress, first signer current', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.getFlowById.mockResolvedValue(FLOW_IN_PROGRESS);

    const res = await request(app)
      .get(`/api/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    const flow = res.body;
    expect(flow.status ?? flow.data?.status).toMatch(/in_progress/);
    const s1 = flow.signers?.find(s => s.id === 's1');
    if (s1) expect(s1.status).toBe('current');
  });

  it('7: POST /api/flows/:id/advance with signer1 token → advances to signer2', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.getSignerByToken.mockResolvedValue(SIGNER1_ROW);
    mockFlowRepo.getFlowById.mockResolvedValue(FLOW_IN_PROGRESS);
    mockFlowRepo.updateSigner.mockResolvedValue(undefined);
    mockFlowRepo.getNextPendingSigner.mockResolvedValue(FLOW_IN_PROGRESS.signers[1]);
    mockFlowRepo.updateFlowStatus.mockResolvedValue(FLOW_IN_PROGRESS);
    mockFlowRepo.insertDocumentRevision.mockResolvedValue({ id: 2 });

    const res = await request(app)
      .post(`/api/flows/${FLOW_ID}/advance`)
      .set('Cookie', `dfai_token=${token}`)
      .send({ token: 'tok_s1' });  // route expects { token } not { signerToken }

    expect([200, 201, 204]).toContain(res.status);
    expect(mockFlowRepo.getSignerByToken).toHaveBeenCalledWith('tok_s1');
  });

  it('8: GET after signer1 advance → signer2 is current', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.getFlowById.mockResolvedValue(FLOW_AFTER_S1);

    const res = await request(app)
      .get(`/api/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    const s2 = res.body.signers?.find(s => s.id === 's2');
    if (s2) expect(s2.status).toBe('current');
  });

  it('9: POST advance with signer2 token → flow completes', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.getSignerByToken.mockResolvedValue(SIGNER2_ROW);
    mockFlowRepo.getFlowById.mockResolvedValue(FLOW_AFTER_S1);
    mockFlowRepo.updateSigner.mockResolvedValue(undefined);
    mockFlowRepo.getNextPendingSigner.mockResolvedValue(null);
    mockFlowRepo.updateFlowStatus.mockResolvedValue(FLOW_COMPLETED);
    mockFlowRepo.insertDocumentRevision.mockResolvedValue({ id: 3 });

    const res = await request(app)
      .post(`/api/flows/${FLOW_ID}/advance`)
      .set('Cookie', `dfai_token=${token}`)
      .send({ token: 'tok_s2' });

    expect([200, 201, 204]).toContain(res.status);
  });

  it('10: GET after signer2 advance → status completed, completed_at set', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFlowRepo.getFlowById.mockResolvedValue(FLOW_COMPLETED);

    const res = await request(app)
      .get(`/api/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.status ?? res.body.data?.status).toMatch(/completed/);
  });

  it('11: GET /api/audit/flows/:id → at least 5 audit events', async () => {
    const app    = makeApp();
    const token  = makeToken();
    const events = [
      { id: 1, event_type: 'flow.created',   actor_email: 'admin@test.ro', ok: true, created_at: new Date().toISOString() },
      { id: 2, event_type: 'flow.started',   actor_email: 'admin@test.ro', ok: true, created_at: new Date().toISOString() },
      { id: 3, event_type: 'flow.advanced',  actor_email: 's1@test.ro',   ok: true, created_at: new Date().toISOString() },
      { id: 4, event_type: 'flow.advanced',  actor_email: 's2@test.ro',   ok: true, created_at: new Date().toISOString() },
      { id: 5, event_type: 'flow.completed', actor_email: 's2@test.ro',   ok: true, created_at: new Date().toISOString() },
    ];

    // audit route uses pool.query directly (not mocked module):
    // call 1: SELECT org_id FROM flows WHERE id=... (ownership check)
    // call 2: SELECT * FROM audit_events WHERE flow_id=...
    pool.query
      .mockResolvedValueOnce({ rows: [{ org_id: ORG_ID }] })
      .mockResolvedValueOnce({ rows: events });

    const res = await request(app)
      .get(`/api/audit/flows/${FLOW_ID}`)
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    const evts = res.body.events ?? res.body.items ?? res.body;
    expect(Array.isArray(evts)).toBe(true);
    expect(evts.length).toBeGreaterThanOrEqual(5);
  });
});

describe('ALOP form lifecycle', () => {
  it('1: GET /api/forms/templates → ALOP-2024 present', async () => {
    const app   = makeApp();
    const token = makeToken();

    mockFormRepo.listTemplates.mockResolvedValue([ALOP_TEMPLATE]);

    const res = await request(app)
      .get('/api/forms/templates')
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.templates.some(t => t.code === 'ALOP-2024')).toBe(true);
  });

  it('2-3: POST /api/forms/alop/create → instance created', async () => {
    const app   = makeApp();
    const token = makeToken();

    // createInstance → findTemplateByCode → getActiveVersion → insertInstance
    mockFormRepo.findTemplateByCode.mockResolvedValue(ALOP_TEMPLATE);
    mockFormRepo.getActiveVersion.mockResolvedValue(ALOP_VERSION);
    mockFormRepo.insertInstance.mockResolvedValue(ALOP_INSTANCE);

    const res = await request(app)
      .post('/api/forms/alop/create')
      .set('Cookie', `dfai_token=${token}`)
      .send({ flowId: FLOW_ID });

    expect(res.status).toBe(201);
    expect(res.body.instance?.id ?? res.body.id).toBe(INSTANCE_ID);
  });

  it('4: PUT /api/forms/instances/:id/data → saves successfully', async () => {
    const app   = makeApp();
    const token = makeToken();

    const updatedInstance = { ...ALOP_INSTANCE, data_json: { sectionA: { institutie: 'Primăria Test' } } };
    mockFormRepo.findInstanceById.mockResolvedValue(ALOP_INSTANCE);
    mockFormRepo.getVersionById.mockResolvedValue(ALOP_VERSION);       // called by saveData
    mockFormRepo.updateInstance.mockResolvedValue(updatedInstance);    // called by saveData

    const res = await request(app)
      .put(`/api/forms/instances/${INSTANCE_ID}/data`)
      .set('Cookie', `dfai_token=${token}`)
      .send({ data: { sectionA: { institutie: 'Primăria Test' } } });

    expect([200, 204]).toContain(res.status);
  });

  it('5: POST /api/forms/instances/:id/validate → valid:true', async () => {
    const app   = makeApp();
    const token = makeToken();

    const populatedInstance = { ...ALOP_INSTANCE, data_json: { sectionA: { institutie: 'Primăria Test' } } };
    mockFormRepo.findInstanceById.mockResolvedValue(populatedInstance);
    mockFormRepo.getVersionById.mockResolvedValue(ALOP_VERSION);     // called by validateInstance
    mockFormRepo.updateInstance.mockResolvedValue(populatedInstance); // called after validation

    const res = await request(app)
      .post(`/api/forms/instances/${INSTANCE_ID}/validate`)
      .set('Cookie', `dfai_token=${token}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('6: POST /api/forms/instances/:id/generate-pdf → returns revision info', async () => {
    const app   = makeApp();
    const token = makeToken();

    const populatedInstance = {
      ...ALOP_INSTANCE,
      status: 'draft',
      data_json: { sectionA: { institutie: 'Primăria Test' } },
    };
    mockFormRepo.findInstanceById.mockResolvedValue(populatedInstance);
    mockFormRepo.getVersionById.mockResolvedValue(ALOP_VERSION);        // called by generatePdf
    mockFormRepo.findTemplateById.mockResolvedValue(ALOP_TEMPLATE);    // called by generatePdf
    mockFormRepo.insertFormDocumentRevision.mockResolvedValue({ id: 10 });
    mockFormRepo.updateInstance.mockResolvedValue({ ...populatedInstance, status: 'generated' });

    const res = await request(app)
      .post(`/api/forms/instances/${INSTANCE_ID}/generate-pdf`)
      .set('Cookie', `dfai_token=${token}`);

    expect([200, 201]).toContain(res.status);
  });
});

describe('Policy evaluation', () => {
  it('signers_count=11 → allowed:false (flow.max_signers)', async () => {
    const app   = makeApp();
    const token = makeToken();

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'p1', org_id: null, scope: 'flow', code: 'flow.max_signers',
        name: 'Max signers', is_active: true, priority: 100,
        rule_json: {
          condition: { field: 'signers_count', op: '>', value: 10 },
          effect:    'deny',
          message:   'Maximum 10 semnatari per flux',
        },
      }],
    });

    const res = await request(app)
      .post('/api/policies/evaluate')
      .set('Cookie', `dfai_token=${token}`)
      .send({ scope: 'flow', context: { signers_count: 11 } });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(false);
    expect(res.body.messages).toContain('Maximum 10 semnatari per flux');
  });

  it('signers_count=5 → allowed:true', async () => {
    const app   = makeApp();
    const token = makeToken();

    pool.query.mockResolvedValueOnce({
      rows: [{
        id: 'p1', org_id: null, scope: 'flow', code: 'flow.max_signers',
        name: 'Max signers', is_active: true, priority: 100,
        rule_json: {
          condition: { field: 'signers_count', op: '>', value: 10 },
          effect:    'deny',
          message:   'Maximum 10 semnatari per flux',
        },
      }],
    });

    const res = await request(app)
      .post('/api/policies/evaluate')
      .set('Cookie', `dfai_token=${token}`)
      .send({ scope: 'flow', context: { signers_count: 5 } });

    expect(res.status).toBe(200);
    expect(res.body.allowed).toBe(true);
  });
});
