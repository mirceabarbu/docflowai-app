// @vitest-environment happy-dom
/**
 * #146 — randarea verificatorului public (public/js/verifica/verifica.js).
 * Script clasic, încărcat cu `new Function(src).call(globalThis)` (convenția din
 * pagin-component.test.mjs). ⚠️ Capcană cunoscută: declarațiile top-level dintr-un
 * `new Function(...)` NU se scurg pe globalThis — verifica.js expune de aceea
 * explicit `window.__verificaTest` pentru teste (fără efect în producție).
 * ⚠️ Capcană cunoscută: sub happy-dom, `new URL('.', import.meta.url)` aruncă —
 * folosim dirname(fileURLToPath(import.meta.url)).
 */

import { describe, it, expect, beforeAll, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

const __dir = dirname(fileURLToPath(import.meta.url));
const src = readFileSync(join(__dir, '../../../public/js/verifica/verifica.js'), 'utf8');

const SHELL = `
  <div id="loading"></div>
  <div id="errBox"></div>
  <div id="result">
    <div class="verdict" id="verdictBox">
      <div class="verdict-icon" id="verdictIcon"></div>
      <div>
        <div class="verdict-title" id="verdictTitle"></div>
        <div class="verdict-sub" id="verdictSub"></div>
      </div>
    </div>
    <div id="levelsSection" style="display:none;">
      <div class="levels" id="levelsBox"></div>
    </div>
    <div id="dbSection" style="display:none;">
      <div class="info-grid" id="dbInfoGrid"></div>
      <div id="signersSection" style="display:none;">
        <table id="signersTable"><tbody id="signersTbody"></tbody></table>
      </div>
    </div>
    <div id="sigList"></div>
  </div>
  <input id="inputFlowId" />
`;

let T;

beforeAll(() => {
  document.body.innerHTML = SHELL;
  new Function(src).call(globalThis);
  T = window.__verificaTest;
});

beforeEach(() => {
  document.body.innerHTML = SHELL;
  T.clearResult();
});

function sig(overrides = {}) {
  return {
    isValid: true,
    isQES: true,
    certificate: { subject: { CN: 'Test Semnatar', O: 'Test Org' }, issuer: { CN: 'Test CA' } },
    signingTime: '2026-08-01T10:00:00Z',
    chain: [
      { CN: 'Test Semnatar', O: 'Test Org', isSelfSigned: false, notBefore: '2024-01-01', notAfter: '2027-01-01' },
      { CN: 'CA Root', isSelfSigned: true, notBefore: '2010-01-01', notAfter: '2040-01-01' },
    ],
    levels: {
      L1: { ok: true }, L2: { ok: true }, L3: { ok: true },
      L4: { ok: true }, L5: { ok: true }, L6: { ok: true, qtspName: 'certSIGN' },
    },
    ...overrides,
  };
}

describe('window.__verificaTest expune funcțiile reale', () => {
  it('renderCryptoResult, renderSignatureBlock, renderAggregateVerdict sunt funcții', () => {
    expect(typeof T.renderCryptoResult).toBe('function');
    expect(typeof T.renderSignatureBlock).toBe('function');
    expect(typeof T.renderAggregateVerdict).toBe('function');
  });
});

describe('#146 — verdictul e al documentului (multi-semnătură)', () => {
  it('7. ⭐⭐ trei semnături, a doua invalidă => verdict de eșec, fără "QES" ca afirmație pozitivă; 3 blocuri', () => {
    const data = {
      signatures: [
        sig({ certificate: { subject: { CN: 'A' }, issuer: { CN: 'CA' } } }),
        sig({
          isValid: false,
          certificate: { subject: { CN: 'B' }, issuer: { CN: 'CA' } },
          levels: { L1: { ok: true }, L2: { ok: false }, L3: { ok: true }, L4: { ok: true }, L5: { ok: true }, L6: { ok: true } },
        }),
        sig({ certificate: { subject: { CN: 'C' }, issuer: { CN: 'CA' } } }),
      ],
    };
    data.summary = {
      signatureCount: 3,
      allValid: false,
      allQES: data.signatures.every(s => s.isQES),
      anyInconclusive: false,
      signers: data.signatures.map(s => ({ cn: s.certificate.subject.CN, isValid: s.isValid, isQES: s.isQES })),
    };

    T.renderCryptoResult(data);

    const verdictBox = document.getElementById('verdictBox');
    expect(verdictBox.className).toContain('invalid');
    const title = document.getElementById('verdictTitle').textContent;
    expect(title).not.toMatch(/QES/);
    expect(title).toMatch(/invalid/i);

    const blocks = document.querySelectorAll('#sigList .sig-block');
    expect(blocks.length).toBe(3);
  });

  it('8. ⭐ o singură semnătură validă => verdict identic cu cel de azi, un bloc, desfășurat', () => {
    const data = { signatures: [sig()] };
    data.summary = {
      signatureCount: 1, allValid: true, allQES: true, anyInconclusive: false,
      signers: [{ cn: 'Test Semnatar', isValid: true, isQES: true }],
      isValid: true, isQES: true, signer: 'Test Semnatar', qtsp: 'certSIGN',
    };

    T.renderCryptoResult(data);

    expect(document.getElementById('verdictBox').className).toContain('valid');
    expect(document.getElementById('verdictTitle').textContent).toBe('Semnătură electronică calificată (QES)');
    expect(document.getElementById('verdictSub').textContent).toBe('Semnată de Test Semnatar · certSIGN');

    const blocks = document.querySelectorAll('#sigList .sig-block');
    expect(blocks.length).toBe(1);
    expect(blocks[0].classList.contains('collapsed')).toBe(false);
  });

  it('9. ⭐ blocurile 2 și 3 sunt pliate implicit, dar starea lor e prezentă în DOM', () => {
    const data = {
      signatures: [
        sig({ certificate: { subject: { CN: 'A' }, issuer: { CN: 'CA' } } }),
        sig({ certificate: { subject: { CN: 'B' }, issuer: { CN: 'CA' } } }),
        sig({ certificate: { subject: { CN: 'C' }, issuer: { CN: 'CA' } } }),
      ],
    };
    data.summary = {
      signatureCount: 3, allValid: true, allQES: true, anyInconclusive: false,
      signers: data.signatures.map(s => ({ cn: s.certificate.subject.CN, isValid: true, isQES: true })),
    };

    T.renderCryptoResult(data);

    const blocks = document.querySelectorAll('#sigList .sig-block');
    expect(blocks.length).toBe(3);
    expect(blocks[0].classList.contains('collapsed')).toBe(false);
    expect(blocks[1].classList.contains('collapsed')).toBe(true);
    expect(blocks[2].classList.contains('collapsed')).toBe(true);

    // starea (dot + CN) e vizibilă fără a plia/desfășura
    expect(blocks[1].querySelector('.sig-dot')).toBeTruthy();
    expect(blocks[1].querySelector('.sig-cn').textContent).toBe('B');
  });

  it('10. ⭐ un CN cu payload XSS apare escapat, elementul periculos nu se creează', () => {
    const payload = '<img src=x onerror="window.__pwned=1">';
    const data = { signatures: [sig({ certificate: { subject: { CN: payload, O: 'Org' }, issuer: { CN: 'CA' } } })] };
    data.summary = {
      signatureCount: 1, allValid: true, allQES: true, anyInconclusive: false,
      signers: [{ cn: payload, isValid: true, isQES: true }],
      isValid: true, isQES: true, signer: payload,
    };

    delete window.__pwned;
    T.renderCryptoResult(data);

    const block = document.querySelector('#sigList .sig-block');
    expect(block.querySelector('img')).toBeNull();
    expect(block.querySelector('.sig-cn').textContent).toBe(payload);
    expect(block.querySelector('.sig-cn').innerHTML).not.toContain('<img');
    expect(window.__pwned).toBeUndefined();

    // certGrid (info-box) trece prin esc() — verificăm că innerHTML nu conține tag-ul brut
    const certGrid = block.querySelector('.sig-cert');
    expect(certGrid.innerHTML).not.toContain('<img');
  });

  it('11. zero semnături => mesajul existent, fără blocuri', () => {
    T.renderCryptoResult({ signatures: [], error: 'no_signatures' });
    expect(document.getElementById('verdictTitle').textContent).toBe('Nicio semnătură electronică găsită');
    expect(document.querySelectorAll('#sigList .sig-block').length).toBe(0);
  });
});
