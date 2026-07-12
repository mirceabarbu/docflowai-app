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

// Normalizează spațierea: PDF-ul sparge textul pe rânduri, extragerea le lipește cu spații.
const norm = (s) => String(s).replace(/\s+/g, ' ').trim();

// ── Helper: extrage item-urile individuale de text (1 item = 1 drawText) ──────

async function extractPdfItems(base64) {
  const data = new Uint8Array(Buffer.from(base64, 'base64'));
  const doc = await getDocument({ data, useSystemFonts: true }).promise;
  const items = [];
  for (let i = 1; i <= doc.numPages; i++) {
    const page = await doc.getPage(i);
    const content = await page.getTextContent();
    for (const it of content.items) {
      if (it.str && it.str.trim()) items.push(it.str.trim());
    }
  }
  doc.destroy();
  return items;
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

  it('DF — Cod SSI de 15 caractere este desenat pe UN SINGUR rând (pct.4, pct.5 si SecB)', async () => {
    const SSI = '02A740501200130';   // 15 chars — cod SSI real din producție
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Tehnic',
        obiect_fd_reviz_scurt: 'Obiect',
        ang_legale_val: {
          ckbx_stab_tin_cont: true,
          rowT_ang_pl_val: [
            { element_fd: 'igienizare', program: '0000000000', codSSI: SSI, param_fd: 'oferta',
              valt_rev_prec: 0, influente: 181500, valt_actualiz: 181500 },
          ],
        },
        ang_legale_plati: {
          ckbx_cu_ang_emis_ancrt: true,
          ckbx_cu_plati_ang_in_mmani: true,
          rowT_ang_pl_plati: [
            { program: '0000000000', codSSI: SSI, plati_ani_precedenti: 0, plati_estim_ancrt: 181500,
              plati_estim_an_np1: 0, plati_estim_an_np2: 0, plati_estim_an_np3: 0, plati_estim_ani_ulter: 0 },
          ],
        },
      },
      sectiuneaB: {
        ckbx_secta_inreg_ctrl_ang: true,
        rowT_ang_ctrl_ang: [
          { cod_angajament: 'AAB542827M6', indicator_angajament: 'AAB', program: '0000000000',
            cod_SSI: SSI, sum_rezv_crdt_ang_af_rvz_prc: 0, influente_c6: 181500,
            sum_rezv_crdt_ang_act: 181500, sum_rezv_crdt_bug_af_rvz_prc: 0,
            influente_c9: 181500, sum_rezv_crdt_bug_act: 181500 },
        ],
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);

    const items = await extractPdfItems(res.body.pdfBase64);

    // SSI-ul trebuie să apară ca item ÎNTREG de 3 ori (pct.4, pct.5, SecB) — nu spart.
    const whole = items.filter(s => s === SSI);
    expect(whole.length).toBe(3);

    // și NU trebuie să existe niciun fragment parțial de SSI (dovada de wrap)
    const fragments = items.filter(s => s !== SSI && SSI.startsWith(s) && s.length >= 8);
    expect(fragments).toHaveLength(0);

    expect(items.join(' ')).not.toContain('…');
  });

  it('ORD — Cod SSI de 15 caractere este desenat pe UN SINGUR rând', async () => {
    const SSI = '02A740501200130';
    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({
        formType: 'ordnt',
        data: {
          Cif: '4646897',
          DenInstPb: 'Primaria Zarnesti',
          NrOrdonantPl: '39917',
          DataOrdontPl: '07.07.2026',
          docFd: {
            nr_unic_inreg: '39917',
            beneficiar: 'SC Test SRL',
            iban_beneficiar: 'RO49AAAA1B31007593840000',
            cif_beneficiar: '1234567',
            rowTfd: [
              { cod_angajament: 'AAB542827M6', indicator_angajament: 'AAB', program: '0000000000',
                cod_SSI: SSI, receptii: 181500, plati_anterioare: 0,
                suma_ordonantata_plata: 181500, receptii_neplatite: 0 },
            ],
          },
        },
      });

    expect(res.status).toBe(200);

    const items = await extractPdfItems(res.body.pdfBase64);
    expect(items.filter(s => s === SSI).length).toBe(1);
    expect(items.filter(s => s !== SSI && SSI.startsWith(s) && s.length >= 8)).toHaveLength(0);
    expect(items.join(' ')).not.toContain('…');
  });

  it('DF — titlul lung (SubtitluDF) apare INTEGRAL în caseta de titlu', async () => {
    const TITLU = 'Lucrari de igienizare si ecologizare zona Deal, Saticel si zona situata pe malul stang al raului Barsa la iesirea din Cartierul Saticel, in apropierea statie Peco Octano';
    const data = makeNotafdData({ SubtitluDF: TITLU });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    expect(norm(text)).toContain(norm(TITLU));
    expect(text).not.toContain('…');
  });

  it('DF — Secțiunea A pct.2 (obiect scurt, 250 chars) apare INTEGRAL', async () => {
    const OBIECT = 'Lucrari de igienizare si ecologizare zona Deal, Saticel si zona situata pe malul stang al raului Barsa la iesirea din Cartierul Saticel, in apropierea statiei Peco Octano, conform ofertei nr. 1234 din data de 07.07.2026, cu termen de executie 30 de zile';
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Tehnic',
        obiect_fd_reviz_scurt: OBIECT,
        ang_legale_val: { ckbx_stab_tin_cont: true, rowT_ang_pl_val: [{ element_fd: 'E', codSSI: '01A', valt_actualiz: 1 }] },
        ang_legale_plati: {},
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    expect(norm(text)).toContain(norm(OBIECT));
    expect(text).not.toContain('…');
  });

  it('DF — pct.3 „descriere pe larg" de 4000 chars apare INTEGRAL (spargere pe pagini)', async () => {
    const LUNG = Array.from({ length: 160 }, (_, i) => `paragraf${i} despre starea de fapt si de drept`).join(' ');
    const data = makeNotafdData({
      sectiuneaA: {
        compartiment_specialitate: 'Serviciul Tehnic',
        obiect_fd_reviz_scurt: 'Obiect',
        obiect_fd_reviz_lung: LUNG,
        ang_legale_val: { ckbx_stab_tin_cont: true, rowT_ang_pl_val: [{ element_fd: 'E', codSSI: '01A', valt_actualiz: 1 }] },
        ang_legale_plati: {},
      },
    });

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({ formType: 'notafd', data });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    const n = norm(text);
    expect(n).toContain('paragraf0 despre');     // începutul
    expect(n).toContain('paragraf159 despre');   // FINALUL — dovada că nu s-a plafonat la 12 rânduri
    expect(text).not.toContain('…');
  });

  it('ORD — beneficiar / documente justificative / banca / info plata apar INTEGRAL', async () => {
    const BENEF  = 'SOCIETATEA COMERCIALA DE SALUBRIZARE SI ECOLOGIZARE ZONA MONTANA BRASOV SUD-EST SRL';
    const DOCJ   = 'Factura fiscala seria ZRN nr. 0001234 din 05.07.2026, proces-verbal de receptie nr. 77 din 06.07.2026, situatie de lucrari anexata si oferta tehnico-financiara acceptata';
    const BANCA  = 'Trezoreria Municipiului Zarnesti, Judetul Brasov, Sucursala Operativa Centrala';
    const INFO   = Array.from({ length: 60 }, (_, i) => `detaliu${i} privind plata efectuata`).join(' ');

    const res = await request(app)
      .post('/api/formulare/generate')
      .set('Cookie', `auth_token=${TOKEN}`)
      .send({
        formType: 'ordnt',
        data: {
          Cif: '4646897',
          DenInstPb: 'Primaria Orasului Zarnesti, Judetul Brasov',
          NrOrdonantPl: '39917',
          DataOrdontPl: '07.07.2026',
          docFd: {
            nr_unic_inreg: '39917',
            beneficiar: BENEF,
            documente_justificative: DOCJ,
            banca_beneficiar: BANCA,
            iban_beneficiar: 'RO49AAAA1B31007593840000',
            cif_beneficiar: '1234567',
            inf_pv_plata: INFO,
            rowTfd: [
              { cod_angajament: 'AAB542827M6', cod_SSI: '02A740501200130',
                receptii: 181500, suma_ordonantata_plata: 181500 },
            ],
          },
        },
      });

    expect(res.status).toBe(200);
    const text = await extractPdfText(res.body.pdfBase64);
    const n = norm(text);
    expect(n).toContain(norm(BENEF));
    expect(n).toContain(norm(DOCJ));
    expect(n).toContain(norm(BANCA));
    expect(n).toContain('detaliu0 privind');
    expect(n).toContain('detaliu59 privind');   // finalul — dovada că nu s-a plafonat la 4 rânduri
    expect(text).not.toContain('…');
  });
});
