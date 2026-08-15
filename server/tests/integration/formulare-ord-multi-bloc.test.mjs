/**
 * DocFlowAI — #128e: ORD cu N blocuri (multi-beneficiar) la VALIDARE și la PDF.
 *
 * `validateOrdnt` și `buildOrdnt` (server/routes/formulare.mjs) nu sunt exportate — se testează
 * prin ruta reală POST /api/formulare/generate (422 = lista de erori, 200 = PDF generat).
 *
 * ⭐ Criteriul lotului: pentru un ORD cu UN SINGUR bloc (tot ce există azi în producție)
 * mesajele de validare rămân BYTE-IDENTICE cu cele de dinainte de #128e.
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

import { formulareRouter } from '../../routes/formulare.mjs';

const JWT_SECRET = process.env.JWT_SECRET || 'test-jwt-secret-vitest-docflowai-2025';

const app = express();
app.use(cookieParser());
app.use(formulareRouter);

const TOKEN = jwt.sign(
  { userId: 1, email: 'test@test.ro', role: 'org_admin', orgId: 'org1', nume: 'Test' },
  JWT_SECRET, { expiresIn: '2h' }
);

const ROOT = {
  Cif: '4646897',
  DenInstPb: 'Primaria Orasului Zarnesti, Judetul Brasov',
  NrOrdonantPl: '39917',
  DataOrdontPl: '07.07.2026',
};

function bloc(overrides = {}) {
  return {
    nr_unic_inreg: '39917',
    beneficiar: 'SC Test SRL',
    documente_justificative: 'Factura 123',
    banca_beneficiar: 'Trezoreria Zarnesti',
    iban_beneficiar: 'RO49AAAA1B31007593840000',
    cif_beneficiar: '1234567',
    inf_pv_plata: 'Contravaloare servicii',
    rowTfd: [
      { cod_angajament: 'AAB542827M6', indicator_angajament: 'AAB', program: '0000000000',
        cod_SSI: '02A740501200130', receptii: 181500, plati_anterioare: 0,
        suma_ordonantata_plata: 181500, receptii_neplatite: 0 },
    ],
    ...overrides,
  };
}

const gen = (data) => request(app)
  .post('/api/formulare/generate')
  .set('Cookie', `auth_token=${TOKEN}`)
  .send({ formType: 'ordnt', data });

async function pdfPages(base64) {
  const doc = await getDocument({
    data: new Uint8Array(Buffer.from(base64, 'base64')), useSystemFonts: true,
  }).promise;
  const n = doc.numPages;
  doc.destroy();
  return n;
}

async function pdfText(base64) {
  const doc = await getDocument({
    data: new Uint8Array(Buffer.from(base64, 'base64')), useSystemFonts: true,
  }).promise;
  const chunks = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const c = await (await doc.getPage(i)).getTextContent();
    for (const it of c.items) if (it.str) chunks.push(it.str);
  }
  doc.destroy();
  return chunks.join(' ').replace(/\s+/g, ' ');
}

// ── Validare ──────────────────────────────────────────────────────────────────

describe('#128e — validateOrdnt pe N blocuri', () => {

  it('⭐ un bloc, câmp lipsă -> mesaj FĂRĂ prefix (byte-identic cu cel de dinainte)', async () => {
    const res = await gen({ ...ROOT, docFd: bloc({ beneficiar: '' }) });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(['beneficiar obligatoriu']);
  });

  it('⭐ un bloc trimis ca ARRAY de 1 -> tot fără prefix', async () => {
    const res = await gen({ ...ROOT, docFd: [bloc({ cif_beneficiar: '' })] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(['cif_beneficiar obligatoriu', 'cif_beneficiar format invalid']);
  });

  it('două blocuri, al doilea fără CIF -> prefix „blocul 2: ", primul bloc fără erori', async () => {
    const res = await gen({
      ...ROOT,
      docFd: [bloc(), bloc({ beneficiar: 'Furnizor Secund SRL', cif_beneficiar: '' })],
    });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual([
      'blocul 2: cif_beneficiar obligatoriu',
      'blocul 2: cif_beneficiar format invalid',
    ]);
    expect(res.body.errors.some(e => e.startsWith('blocul 1: '))).toBe(false);
  });

  it('docFd gol -> „Cel putin un bloc docFd obligatoriu"', async () => {
    const res = await gen({ ...ROOT, docFd: [] });
    expect(res.status).toBe(422);
    expect(res.body.errors).toEqual(['Cel putin un bloc docFd obligatoriu']);
  });

  it('două blocuri complete -> validare trecută (200)', async () => {
    const res = await gen({
      ...ROOT,
      docFd: [bloc(), bloc({ beneficiar: 'Furnizor Secund SRL', cif_beneficiar: '7654321' })],
    });
    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
  });
});

// ── PDF ───────────────────────────────────────────────────────────────────────

describe('#128e — PDF ORD cu N blocuri', () => {

  it('două blocuri -> generare fără excepție, ≥ paginile de la un bloc, ambii beneficiari', async () => {
    const unBloc = await gen({ ...ROOT, docFd: bloc() });
    expect(unBloc.status).toBe(200);
    const pgUnBloc = await pdfPages(unBloc.body.pdfBase64);

    const douaBlocuri = await gen({
      ...ROOT,
      docFd: [
        bloc(),
        bloc({
          beneficiar: 'Furnizor Secund SRL', cif_beneficiar: '7654321',
          iban_beneficiar: 'RO51RNCB0080002971510001',
          rowTfd: [
            { cod_angajament: 'BBC542827M7', indicator_angajament: 'BBC', program: '0000000001',
              cod_SSI: '02A740501200131', receptii: 500, plati_anterioare: 0,
              suma_ordonantata_plata: 500, receptii_neplatite: 0 },
          ],
        }),
      ],
    });
    expect(douaBlocuri.status).toBe(200);
    expect(await pdfPages(douaBlocuri.body.pdfBase64)).toBeGreaterThanOrEqual(pgUnBloc);

    const text = await pdfText(douaBlocuri.body.pdfBase64);
    expect(text).toContain('SC Test SRL');
    expect(text).toContain('Furnizor Secund SRL');
    expect(text).toContain('7654321');
    // titlul discret apare doar de la blocul 2 încolo
    expect(text).toContain('Beneficiar 2 din 2');
    expect(text).not.toContain('Beneficiar 1 din 2');
    // fiecare bloc își randează propriile rânduri
    expect(text).toContain('BBC542827M7');
    expect(text).toContain('AAB542827M6');
  });

  it('⭐ un bloc -> PDF fără antet de bloc (ieșire neschimbată)', async () => {
    const res = await gen({ ...ROOT, docFd: bloc() });
    expect(res.status).toBe(200);
    const text = await pdfText(res.body.pdfBase64);
    expect(text).not.toContain('Beneficiar 1 din');
    expect(text).not.toContain('Beneficiar 1 din 1');
  });
});
