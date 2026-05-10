/**
 * DocFlowAI — Integration tests: PDF cell wrap (no truncation)
 *
 * Verifică că drawTable din formulare.mjs face wrap pe text lung
 * în loc de clamp cu „…". Generează PDF-uri reale via POST /api/formulare/generate
 * și extrage text cu pdfjs-dist.
 */

import { vi, describe, it, expect } from 'vitest';
import request from 'supertest';
import express from 'express';
import cookieParser from 'cookie-parser';
import jwt from 'jsonwebtoken';
import { getDocument } from 'pdfjs-dist/legacy/build/pdf.mjs';

// ── Mock-uri ESM ──────────────────────────────────────────────────────────────

vi.mock('../../middleware/logger.mjs', () => ({
  logger: {
    info: vi.fn(), warn: vi.fn(), error: vi.fn(),
    child: vi.fn(() => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() })),
  },
  redactUrl: (u) => u,
}));

// ── Importuri după mock-uri ───────────────────────────────────────────────────

import { formulareRouter } from '../../routes/formulare.mjs';

// ── App Express minimală ──────────────────────────────────────────────────────

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

function makeApp() {
  const app = express();
  app.use(cookieParser());
  app.use(formulareRouter);
  return app;
}

const app = makeApp();

const TOKEN = jwt.sign(
  { userId: 1, email: 'test@test.ro', role: 'org_admin', orgId: 'org1', nume: 'Test' },
  JWT_SECRET, { expiresIn: '2h' }
);

// ── Helper: extrage tot textul din PDF ────────────────────────────────────────

async function extractPdfText(base64) {
  const data = new Uint8Array(Buffer.from(base64, 'base64'));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const chunks = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const item of content.items) {
      if (item.str) chunks.push(item.str);
    }
  }
  doc.destroy();
  return chunks.join(' ');
}

// ── Minimal valid DF data ─────────────────────────────────────────────────────

function makeNotafdData(overrides = {}) {
  const sectA = {
    compartiment_specialitate: 'Compartiment Test',
    obiect_fd_reviz_scurt: 'Obiect test',
    ang_legale_val: {
      ckbx_stab_tin_cont: true,
      rowT_ang_pl_val: [
        { element_fd: 'Element test', codSSI: '02A510104', val_init: 1000, val_redim: 1000, val_angaj: 1000, valt_actuala: 1000, influente: 0, valt_actualiz: 1000 },
      ],
    },
    ang_legale_plati: {},
    ...(overrides.sectiuneaA || {}),
  };
  return {
    Cif: '1234567',
    DenInstPb: 'Instituția Test',
    SubtitluDF: 'Subtitlu test',
    NrUnicInreg: 'DF-001',
    Revizuirea: '1',
    DataRevizuirii: '01.01.2026',
    sectiuneaA: sectA,
    sectiuneaB: overrides.sectiuneaB || {},
    ...overrides,
    sectiuneaA: sectA,
  };
}

// ── Tests ─────────────────────────────────────────────────────────────────────

describe('PDF cell wrap (no truncation)', () => {

  it('DF — Cod SSI lung (18 chars) apare integral, fără „…"', async () => {
    const longSSI = '02A510104XYZ123456';
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Comp',
        obiect_fd_reviz_scurt: 'Obiect',
        ang_legale_val: {
          ckbx_stab_tin_cont: true,
          rowT_ang_pl_val: [
            { element_fd: 'Elem', codSSI: longSSI, val_init: 100, val_redim: 100, val_angaj: 100, valt_actuala: 100, influente: 0, valt_actualiz: 100 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: true,
          ckbx_cu_plati_ang_in_mmani: true,
          rowT_ang_pl_plati: [
            { program: 'P1', codSSI: longSSI, plati_ani_precedenti: 0, plati_estim_ancrt: 100, plati_estim_an_np1: 200, plati_estim_an_np2: 300, plati_estim_an_np3: 400, total_plati: 1000 },
          ],
        },
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const text = await extractPdfText(res.body.pdfBase64);
    const collapsed = text.replace(/\s+/g, '');

    expect(collapsed).toContain(longSSI);
    expect(text).not.toContain('…');
  });

  it('DF — Element de fundamentare 150 chars apare integral', async () => {
    const longElem = 'Achizitie echipamente informatice pentru digitalizarea serviciilor publice in cadrul proiectului de modernizare a infrastructurii IT la nivel central';
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Comp',
        obiect_fd_reviz_scurt: 'Obiect',
        ang_legale_val: {
          ckbx_stab_tin_cont: true,
          rowT_ang_pl_val: [
            { element_fd: longElem, codSSI: '01A', val_init: 500, val_redim: 500, val_angaj: 500, valt_actuala: 500, influente: 0, valt_actualiz: 500 },
          ],
        },
        ang_legale_plati: {},
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);

    expect(text).toContain(longElem);
  });

  it('DF — valoare numerica mare nu este trunchiata', async () => {
    const bigNum = 999888777666.55;
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Comp',
        obiect_fd_reviz_scurt: 'Obiect',
        ang_legale_val: {
          ckbx_stab_tin_cont: true,
          rowT_ang_pl_val: [
            { element_fd: 'Elem', codSSI: '01A', val_init: bigNum, val_redim: bigNum, val_angaj: bigNum, valt_actuala: bigNum, influente: 0, valt_actualiz: bigNum },
          ],
        },
        ang_legale_plati: {},
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);

    expect(text).not.toContain('…');
  });

  it('DF — randuri scurte normale genereaza PDF valid', async () => {
    const data = makeNotafdData();

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const text = await extractPdfText(res.body.pdfBase64);

    expect(text).toContain('02A510104');
    expect(text).not.toContain('…');
  });
});
