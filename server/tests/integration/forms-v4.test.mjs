/**
 * DocFlowAI — Integration tests: Forms Engine v4
 *
 * Testează routes + service cu repository mock-uit (fără DB reală).
 *
 * Acoperire:
 *   ✓ GET  /api/forms/templates → lista templates (200)
 *   ✓ POST /api/forms/instances → creare instance (201)
 *   ✓ PUT  /api/forms/instances/:id/data → salvare date (200)
 *   ✓ POST /api/forms/instances/:id/validate → validare (200)
 *   ✓ POST /api/forms/instances/:id/generate-pdf → generare PDF (200)
 */

import { vi, describe, it, expect, beforeEach, afterEach } from 'vitest';
import request      from 'supertest';
import express      from 'express';
import cookieParser from 'cookie-parser';
import jwt          from 'jsonwebtoken';

// ── Mocks ────────────────────────────────────────────────────────────────────

vi.mock('../../modules/forms/repository.mjs', () => ({
  listTemplates:               vi.fn(),
  findTemplateById:            vi.fn(),
  findTemplateByCode:          vi.fn(),
  insertTemplate:              vi.fn(),
  getActiveVersion:            vi.fn(),
  getVersionById:              vi.fn(),
  listVersions:                vi.fn(),
  insertVersion:               vi.fn(),
  publishVersion:              vi.fn(),
  findInstanceById:            vi.fn(),
  findInstanceByFlowId:        vi.fn(),
  listInstances:               vi.fn(),
  insertInstance:              vi.fn(),
  updateInstance:              vi.fn(),
  insertFormDocumentRevision:  vi.fn(),
}));

vi.mock('../../db/queries/audit.mjs', () => ({
  logAuditEvent: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info:  vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() })),
  },
  requestLogger: (_req, _res, next) => next(),
}));

// Mock pdf-renderer to avoid pdf-lib file I/O in tests
vi.mock('../../modules/forms/pdf-renderer.mjs', () => ({
  renderFormPdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 mock')),
}));

// ── Imports (after mocks) ─────────────────────────────────────────────────────

import * as mockRepo from '../../modules/forms/repository.mjs';
import formsRouter   from '../../modules/forms/routes.mjs';
import { errorHandler } from '../../middleware/errorHandler.mjs';

const JWT_SECRET = process.env.JWT_SECRET;
const ORG_ID     = 10;
const USER_ID    = 1;

function createApp() {
  const app = express();
  app.use(express.json());
  app.use(cookieParser());
  app.use('/api/forms', formsRouter);
  app.use(errorHandler);
  return app;
}

function makeToken(overrides = {}) {
  return jwt.sign(
    {
      sub: USER_ID, email: 'test@test.com', org_id: ORG_ID,
      role: 'org_admin', name: 'Test User', ver: 1, tv: 1,
      ...overrides,
    },
    JWT_SECRET,
    { expiresIn: '1h' }
  );
}

// ── Fixtures ──────────────────────────────────────────────────────────────────

const TEMPLATE = {
  id:          'tmpl-uuid-1',
  org_id:      null,
  code:        'ALOP-2024',
  name:        'ALOP',
  category:    'financiar',
  is_standard: true,
  is_active:   true,
};

const VERSION = {
  id:              'ver-uuid-1',
  template_id:     'tmpl-uuid-1',
  version_no:      1,
  schema_json:     { fields: [{ name: 'institutie', label: 'Instituția', type: 'text', required: true }] },
  pdf_mapping_json: {},
  rules_json:      [],
  required_signers: [],
  status:          'published',
};

const INSTANCE = {
  id:          'inst-uuid-1',
  org_id:      ORG_ID,
  template_id: 'tmpl-uuid-1',
  version_id:  'ver-uuid-1',
  flow_id:     null,
  created_by_id: 1,
  status:      'draft',
  data_json:   {},
};

// ── Setup ─────────────────────────────────────────────────────────────────────

beforeEach(() => { vi.clearAllMocks(); });

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('Forms Engine — GET /api/forms/templates', () => {
  it('returns template list for authenticated user', async () => {
    mockRepo.listTemplates.mockResolvedValue([TEMPLATE]);

    const res = await request(createApp())
      .get('/api/forms/templates')
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.templates).toHaveLength(1);
    expect(res.body.templates[0].code).toBe('ALOP-2024');
  });

  it('returns 401 without auth', async () => {
    const res = await request(createApp()).get('/api/forms/templates');
    expect(res.status).toBe(401);
  });
});

describe('Forms Engine — POST /api/forms/instances', () => {
  it('creates a form instance with templateCode', async () => {
    mockRepo.findTemplateByCode.mockResolvedValue(TEMPLATE);
    mockRepo.getActiveVersion.mockResolvedValue(VERSION);
    mockRepo.insertInstance.mockResolvedValue(INSTANCE);

    const res = await request(createApp())
      .post('/api/forms/instances')
      .set('Cookie', `dfai_token=${makeToken()}`)
      .send({ templateCode: 'ALOP-2024', initialData: {} });

    expect(res.status).toBe(201);
    expect(res.body.instance).toBeDefined();
    expect(res.body.instance.id).toBe('inst-uuid-1');
    expect(mockRepo.insertInstance).toHaveBeenCalled();
  });

  it('returns 404 when template code not found', async () => {
    mockRepo.findTemplateByCode.mockResolvedValue(null);

    const res = await request(createApp())
      .post('/api/forms/instances')
      .set('Cookie', `dfai_token=${makeToken()}`)
      .send({ templateCode: 'UNKNOWN' });

    expect(res.status).toBe(404);
  });
});

describe('Forms Engine — PUT /api/forms/instances/:id/data', () => {
  it('saves data for a draft instance', async () => {
    const updated = { ...INSTANCE, data_json: { institutie: 'Primăria X' } };
    mockRepo.findInstanceById.mockResolvedValue(INSTANCE);
    mockRepo.getVersionById.mockResolvedValue(VERSION);
    mockRepo.updateInstance.mockResolvedValue(updated);

    const res = await request(createApp())
      .put('/api/forms/instances/inst-uuid-1/data')
      .set('Cookie', `dfai_token=${makeToken()}`)
      .send({ data: { institutie: 'Primăria X' } });

    expect(res.status).toBe(200);
    expect(res.body.instance.data_json.institutie).toBe('Primăria X');
  });

  it('returns 403 for instance owned by different org', async () => {
    mockRepo.findInstanceById.mockResolvedValue({ ...INSTANCE, org_id: 99 });

    const res = await request(createApp())
      .put('/api/forms/instances/inst-uuid-1/data')
      .set('Cookie', `dfai_token=${makeToken({ orgId: 10 })}`)
      .send({ data: {} });

    expect(res.status).toBe(403);
  });
});

describe('Forms Engine — POST /api/forms/instances/:id/validate', () => {
  it('returns valid: true for complete data', async () => {
    const completeInstance = { ...INSTANCE, data_json: { institutie: 'Primăria X' } };
    mockRepo.findInstanceById.mockResolvedValue(completeInstance);
    mockRepo.getVersionById.mockResolvedValue(VERSION);
    mockRepo.updateInstance.mockResolvedValue(completeInstance);

    const res = await request(createApp())
      .post('/api/forms/instances/inst-uuid-1/validate')
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(true);
  });

  it('returns valid: false and errors for missing required fields', async () => {
    mockRepo.findInstanceById.mockResolvedValue(INSTANCE);   // data_json: {}
    mockRepo.getVersionById.mockResolvedValue(VERSION);
    mockRepo.updateInstance.mockResolvedValue(INSTANCE);

    const res = await request(createApp())
      .post('/api/forms/instances/inst-uuid-1/validate')
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.valid).toBe(false);
    expect(res.body.errors.institutie).toBeTruthy();
  });
});

describe('Forms Engine — POST /api/forms/instances/:id/generate-pdf', () => {
  it('generates PDF for valid instance and returns revisionId', async () => {
    const validInstance = { ...INSTANCE, data_json: { institutie: 'Primăria Y' } };
    mockRepo.findInstanceById.mockResolvedValue(validInstance);
    mockRepo.getVersionById.mockResolvedValue(VERSION);
    mockRepo.findTemplateById.mockResolvedValue(TEMPLATE);
    mockRepo.insertFormDocumentRevision.mockResolvedValue({ id: 'rev-001' });
    mockRepo.updateInstance.mockResolvedValue({ ...validInstance, status: 'generated', generated_revision_id: 'rev-001' });

    const res = await request(createApp())
      .post('/api/forms/instances/inst-uuid-1/generate-pdf')
      .set('Cookie', `dfai_token=${makeToken()}`);

    expect(res.status).toBe(200);
    expect(res.body.revisionId).toBe('rev-001');
    expect(res.body.sha256).toBeTruthy();
  });
});
